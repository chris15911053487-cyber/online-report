/**
 * 钉钉企业内部机器人 — Stream 模式（长连接）。
 *
 * 流程：应用启动 → 主动连接钉钉 Stream → 接收消息 → 用户绑定 → agentChatCore → 回复。
 * 无需公网地址、无需 SSL 证书、无需白名单。
 */
const { DWClient, TOPIC_ROBOT, EventAck } = require('dingtalk-stream');
const { getPool, sql } = require('../db');
const { agentChatCore } = require('../agent-chat-core');

const log = require('pino')({ name: 'dingtalk-stream' });

function getDingAppKey() {
  return process.env.DINGTALK_APP_KEY || '';
}
function getDingAppSecret() {
  return process.env.DINGTALK_APP_SECRET || '';
}

// ---------- 用户绑定 ----------

async function getBinding(pool, platformUid) {
  const rs = await pool.request()
    .input('p', sql.VarChar(20), 'dingtalk')
    .input('uid', sql.NVarChar(128), platformUid)
    .query('SELECT user_code FROM dbo.bot_user_bindings WHERE platform = @p AND platform_uid = @uid');
  return rs.recordset?.[0]?.user_code || null;
}

async function bindUser(pool, platformUid, userCode) {
  await pool.request()
    .input('p', sql.VarChar(20), 'dingtalk')
    .input('uid', sql.NVarChar(128), platformUid)
    .input('uc', sql.NVarChar(64), userCode)
    .query(`MERGE dbo.bot_user_bindings AS t
            USING (SELECT @p AS platform, @uid AS platform_uid) AS s
            ON t.platform = s.platform AND t.platform_uid = s.platform_uid
            WHEN MATCHED THEN UPDATE SET user_code = @uc
            WHEN NOT MATCHED THEN INSERT (platform, platform_uid, user_code) VALUES (@p, @uid, @uc);`);
}

// ---------- 钉钉 API：获取 access_token ----------

let _tokenCache = { token: '', expiresAt: 0 };

async function getDingAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: getDingAppKey(), appSecret: getDingAppSecret() }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error('获取钉钉 token 失败: ' + JSON.stringify(data));
  _tokenCache = { token: data.accessToken, expiresAt: Date.now() + (data.expireIn || 7200) * 1000 - 60000 };
  return _tokenCache.token;
}

// ---------- 回复消息 ----------

async function replyText(senderStaffId, text) {
  const token = await getDingAccessToken();
  const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      robotCode: getDingAppKey(),
      userIds: [senderStaffId],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'AI 助手', text: truncateForDing(text) }),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    log.warn({ err }, 'dingtalk reply failed');
  }
}

function truncateForDing(text) {
  if (!text) return '（无回复）';
  return text.length > 18000 ? text.slice(0, 18000) + '\n\n…（内容过长已截断）' : text;
}

// ---------- 消息处理 ----------

async function handleRobotMessage(msgData) {
  const data = typeof msgData === 'string' ? JSON.parse(msgData) : msgData;
  log.info({ senderStaffId: data.senderStaffId, content: data.text?.content }, 'dingtalk message received');

  const msgtype = data.msgtype;
  const content = (msgtype === 'text' ? (data.text?.content || '') : '').trim();
  const senderStaffId = data.senderStaffId || '';

  if (!senderStaffId || !content) {
    log.warn({ data }, 'dingtalk message missing senderStaffId or content');
    return;
  }

  // 去掉群聊中 @机器人 的前缀
  const userMessage = content.replace(/^@\S+\s*/, '').trim();
  if (!userMessage) return;

  const pool = await getPool();

  // 绑定指令处理：用户发 "绑定 U001"
  const bindMatch = userMessage.match(/^绑定\s+(\S+)$/);
  if (bindMatch) {
    const userCode = bindMatch[1].toUpperCase();
    const check = await pool.request()
      .input('uc', sql.NVarChar(64), userCode)
      .query(`SELECT USER_CODE FROM dbo.OUSR WHERE USER_CODE = @uc`);
    if (!check.recordset?.length) {
      await replyText(senderStaffId, `❌ 工号 "${userCode}" 不存在，请确认后重新发送`);
      return;
    }
    await bindUser(pool, senderStaffId, userCode);
    await replyText(senderStaffId, `✅ 已绑定工号 **${userCode}**，之后可直接向我提问`);
    return;
  }

  // 检查绑定
  const userCode = await getBinding(pool, senderStaffId);
  if (!userCode) {
    await replyText(senderStaffId, '你还未绑定系统账号，请发送：**绑定 你的工号**\n\n例如：`绑定 U001`');
    return;
  }

  // 调用 Agent
  const conversationId = `ding_${senderStaffId}`;
  try {
    const result = await agentChatCore({
      userCode,
      displayName: userCode,
      conversationId,
      message: userMessage,
      log,
    });
    const replyContent = result.status === 'need_clarification'
      ? (result.clarification?.question || '请补充信息') + formatOptions(result.clarification?.options)
      : (result.message || '处理完成');
    await replyText(senderStaffId, replyContent);
  } catch (err) {
    log.error({ err }, 'dingtalk agentChatCore error');
    await replyText(senderStaffId, '⚠️ AI 处理出错，请稍后重试');
  }
}

function formatOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return '';
  return '\n\n请回复序号选择：\n' + options.map((o, i) => `${i + 1}. ${o.label || o.value}`).join('\n');
}

// ---------- Stream 客户端启动 ----------

let _client = null;

function startDingtalkStream() {
  const clientId = getDingAppKey();
  const clientSecret = getDingAppSecret();

  if (!clientId || !clientSecret) {
    log.warn('DINGTALK_APP_KEY / DINGTALK_APP_SECRET 未配置，跳过钉钉 Stream 连接');
    return;
  }

  _client = new DWClient({ clientId, clientSecret });

  _client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    try {
      await handleRobotMessage(res.data);
    } catch (err) {
      log.error({ err }, 'dingtalk stream message handler error');
    }
    return EventAck.SUCCESS;
  });

  _client.connect();
  log.info('钉钉 Stream 模式已连接 (clientId: %s)', clientId);
}

// ---------- Fastify 路由注册（保留 HTTP 兼容） ----------

async function botDingtalkRoutes(fastify) {
  // 保留 GET/POST 端点用于健康检查和兼容
  fastify.get('/bot/dingtalk', async (_request, reply) => {
    return reply.code(200).type('text/plain').send('success');
  });

  fastify.post('/bot/dingtalk', async (request, reply) => {
    // Stream 模式下 HTTP 端点仅作兼容，返回 success
    return reply.code(200).type('text/plain').send('success');
  });
}

module.exports = botDingtalkRoutes;
module.exports.startDingtalkStream = startDingtalkStream;
