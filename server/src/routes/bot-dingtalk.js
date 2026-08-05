/**
 * 钉钉企业内部机器人 — Stream 模式（长连接）。
 *
 * 流程：应用启动 → 主动连接钉钉 Stream → 接收消息 → 用户绑定 → agentChatCore → 回复。
 * 无需公网地址、无需 SSL 证书、无需白名单。
 */
const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream');
const { getPool, sql } = require('../db');
const { agentChatCore } = require('../agent-chat-core');

const pino = require('pino');
const log = pino({ name: 'dingtalk-stream' });

function getDingAppKey() {
  return process.env.DINGTALK_APP_KEY || '';
}
function getDingAppSecret() {
  return process.env.DINGTALK_APP_SECRET || '';
}

// ---------- 用户绑定（基于 OUSR.U_DDUserId） ----------

async function getBinding(pool, platformUid) {
  const rs = await pool.request()
    .input('dduid', sql.NVarChar(128), platformUid)
    .query('SELECT TOP (1) [USER_CODE] FROM dbo.OUSR WHERE [U_DDUserId] = @dduid');
  return rs.recordset?.[0]?.USER_CODE || null;
}

async function bindUser(pool, platformUid, userCode) {
  await pool.request()
    .input('dduid', sql.NVarChar(128), platformUid)
    .input('uc', sql.NVarChar(64), userCode)
    .query(`UPDATE dbo.OUSR SET [U_DDUserId] = @dduid WHERE [USER_CODE] = @uc`);
}

// ---------- 钉钉 API：获取 access_token ----------

let _tokenCache = { token: '', expiresAt: 0 };

async function getDingAccessToken(client) {
  // 优先使用 SDK 自带的 getAccessToken
  if (client && client.getAccessToken) {
    try {
      return await client.getAccessToken();
    } catch (e) {
      log.warn({ err: e }, 'SDK getAccessToken failed, fallback to manual');
    }
  }
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

// ---------- 回复消息（通过 sessionWebhook） ----------

async function replyViaWebhook(sessionWebhook, senderStaffId, text, accessToken) {
  const body = {
    at: { atUserIds: [senderStaffId], isAtAll: false },
    msgtype: 'markdown',
    markdown: { title: 'AI 助手', text: truncateForDing(text) },
  };
  const res = await fetch(sessionWebhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': accessToken,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    log.warn({ err, statusCode: res.status }, 'dingtalk webhook reply failed');
  }
  return res;
}

// ---------- 备用回复（oToMessages，单聊用） ----------

async function replyDirect(senderStaffId, text, accessToken) {
  const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    body: JSON.stringify({
      robotCode: getDingAppKey(),
      userIds: [senderStaffId],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'AI 助手', text: truncateForDing(text) }),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    log.warn({ err, statusCode: res.status, senderStaffId }, 'dingtalk direct reply failed');
  } else {
    log.info({ senderStaffId }, 'dingtalk direct reply success');
  }
}

function truncateForDing(text) {
  if (!text) return '（无回复）';
  return text.length > 18000 ? text.slice(0, 18000) + '\n\n…（内容过长已截断）' : text;
}

// ---------- 日志写入 bot_message_logs ----------

async function insertMessageLog(pool, entry) {
  try {
    await pool.request()
      .input('platform', sql.NVarChar(20), entry.platform || 'dingtalk')
      .input('message_id', sql.NVarChar(128), entry.messageId || null)
      .input('sender_staff_id', sql.NVarChar(128), entry.senderStaffId || null)
      .input('user_code', sql.NVarChar(64), entry.userCode || null)
      .input('content', sql.NVarChar(2000), (entry.content || '').slice(0, 2000))
      .input('reply_method', sql.NVarChar(20), entry.replyMethod || null)
      .input('reply_status', sql.NVarChar(20), entry.replyStatus || null)
      .input('reply_len', sql.Int, entry.replyLen || null)
      .input('elapsed_ms', sql.Int, entry.elapsedMs || null)
      .input('error_msg', sql.NVarChar(1000), (entry.errorMsg || '').slice(0, 1000) || null)
      .query(`INSERT INTO dbo.bot_message_logs
        (platform, message_id, sender_staff_id, user_code, content, reply_method, reply_status, reply_len, elapsed_ms, error_msg)
        VALUES (@platform, @message_id, @sender_staff_id, @user_code, @content, @reply_method, @reply_status, @reply_len, @elapsed_ms, @error_msg)`);
  } catch (err) {
    log.warn({ err: err.message }, 'insertMessageLog failed');
  }
}

// ---------- 消息处理 ----------

async function handleRobotMessage(client, res) {
  const msgData = JSON.parse(res.data);
  const messageId = res.headers.messageId;

  log.info({ senderStaffId: msgData.senderStaffId, content: msgData.text?.content, messageId }, 'dingtalk message received');

  const content = (msgData.text?.content || '').trim();
  const senderStaffId = msgData.senderStaffId || '';
  const sessionWebhook = msgData.sessionWebhook || '';

  if (!senderStaffId || !content) {
    log.warn('missing senderStaffId or content');
    client.socketCallBackResponse(messageId, { status: 'OK' });
    return;
  }

  // 去掉群聊中 @机器人 的前缀
  const userMessage = content.replace(/^@\S+\s*/, '').trim();
  if (!userMessage) {
    client.socketCallBackResponse(messageId, { status: 'OK' });
    return;
  }

  const pool = await getPool();
  const accessToken = await getDingAccessToken(client);
  const startTime = Date.now();

  // 跟踪回复方式和状态
  let replyMethod = null;
  let replyStatus = null;

  // 辅助回复函数（webhook 失败自动降级到直接发送）
  async function reply(text) {
    if (sessionWebhook) {
      const res = await replyViaWebhook(sessionWebhook, senderStaffId, text, accessToken);
      if (!res || !res.ok) {
        log.info('webhook reply failed, falling back to replyDirect');
        replyMethod = 'direct';
        replyStatus = 'fallback';
        await replyDirect(senderStaffId, text, accessToken);
      } else {
        replyMethod = 'webhook';
        replyStatus = 'success';
      }
    } else {
      replyMethod = 'direct';
      replyStatus = 'success';
      await replyDirect(senderStaffId, text, accessToken);
    }
  }

  // 绑定指令处理：用户发 "绑定 U001"
  const bindMatch = userMessage.match(/^绑定\s+(\S+)$/);
  if (bindMatch) {
    const userCode = bindMatch[1].toUpperCase();
    const check = await pool.request()
      .input('uc', sql.NVarChar(64), userCode)
      .query(`SELECT USER_CODE FROM dbo.OUSR WHERE USER_CODE = @uc`);
    if (!check.recordset?.length) {
      await reply(`❌ 工号 "${userCode}" 不存在，请确认后重新发送`);
      client.socketCallBackResponse(messageId, { status: 'OK' });
      insertMessageLog(pool, { messageId, senderStaffId, content: userMessage, replyMethod, replyStatus, elapsedMs: Date.now() - startTime, errorMsg: 'invalid user code' });
      return;
    }
    await bindUser(pool, senderStaffId, userCode);
    await reply(`✅ 已绑定工号 **${userCode}**，之后可直接向我提问`);
    client.socketCallBackResponse(messageId, { status: 'OK' });
    insertMessageLog(pool, { messageId, senderStaffId, userCode, content: userMessage, replyMethod, replyStatus, elapsedMs: Date.now() - startTime });
    return;
  }

  // 检查绑定
  const userCode = await getBinding(pool, senderStaffId);
  if (!userCode) {
    await reply('你还未绑定系统账号，请发送：**绑定 你的工号**\n\n例如：`绑定 U001`');
    client.socketCallBackResponse(messageId, { status: 'OK' });
    insertMessageLog(pool, { messageId, senderStaffId, content: userMessage, replyMethod, replyStatus, elapsedMs: Date.now() - startTime, errorMsg: 'not bound' });
    return;
  }

  // 先响应钉钉避免重试（60s超时），然后异步处理
  client.socketCallBackResponse(messageId, { status: 'OK' });

  // 调用 Agent
  const conversationId = `ding_${senderStaffId}`;
  log.info({ userCode, conversationId, messageId }, 'dingtalk agent processing start');
  try {
    const result = await agentChatCore({
      userCode,
      displayName: userCode,
      conversationId,
      message: userMessage,
      log,
    });
    const elapsed = Date.now() - startTime;
    const replyContent = result.status === 'need_clarification'
      ? (result.clarification?.question || '请补充信息') + formatOptions(result.clarification?.options)
      : (result.message || '处理完成');
    log.info({ userCode, messageId, status: result.status, elapsed, replyLen: replyContent.length }, 'dingtalk agent done, sending reply');
    await reply(replyContent);
    log.info({ userCode, messageId, elapsed: Date.now() - startTime }, 'dingtalk reply sent');
    insertMessageLog(pool, { messageId, senderStaffId, userCode, content: userMessage, replyMethod, replyStatus, replyLen: replyContent.length, elapsedMs: Date.now() - startTime });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log.error({ err, userCode, messageId, elapsed }, 'dingtalk agentChatCore error');
    await reply('⚠️ AI 处理出错，请稍后重试');
    insertMessageLog(pool, { messageId, senderStaffId, userCode, content: userMessage, replyMethod: replyMethod || 'unknown', replyStatus: 'failed', elapsedMs: elapsed, errorMsg: err.message });
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

  _client = new DWClient({ clientId, clientSecret, debug: false });

  _client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    try {
      await handleRobotMessage(_client, res);
    } catch (err) {
      log.error({ err }, 'dingtalk stream message handler error');
      // 仍需响应避免重试
      try { _client.socketCallBackResponse(res.headers.messageId, { status: 'FAILURE' }); } catch {}
    }
  });

  _client.connect();
  log.info('钉钉 Stream 模式已连接 (clientId: %s)', clientId);
}

// ---------- Fastify 路由注册（保留 HTTP 兼容） ----------

async function botDingtalkRoutes(fastify) {
  fastify.get('/bot/dingtalk', async (_request, reply) => {
    return reply.code(200).type('text/plain').send('success');
  });

  fastify.post('/bot/dingtalk', async (_request, reply) => {
    return reply.code(200).type('text/plain').send('success');
  });
}

module.exports = botDingtalkRoutes;
module.exports.startDingtalkStream = startDingtalkStream;
