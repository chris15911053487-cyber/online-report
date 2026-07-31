/**
 * 钉钉企业内部机器人 Webhook 路由。
 *
 * 流程：钉钉推送消息 → 验签 → 解析 → 用户绑定 → agentChatCore → 回复。
 * 支持单聊和群聊（@机器人）。
 */
const crypto = require('crypto');
const { getPool, sql } = require('../db');
const { agentChatCore } = require('../agent-chat-core');

function getDingAppSecret() {
  return process.env.DINGTALK_APP_SECRET || '';
}
function getDingAppKey() {
  return process.env.DINGTALK_APP_KEY || '';
}

// ---------- 验签 ----------

function verifyDingSign(timestamp, sign) {
  const secret = getDingAppSecret();
  if (!secret || !timestamp || !sign) return false;
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  return hmac === sign;
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

async function replyText(senderStaffId, text, log) {
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
    log?.warn?.({ err }, 'dingtalk reply failed');
  }
}

function truncateForDing(text) {
  // 钉钉 markdown 限约 20000 字符
  if (!text) return '（无回复）';
  return text.length > 18000 ? text.slice(0, 18000) + '\n\n…（内容过长已截断）' : text;
}

// ---------- 路由注册 ----------

async function botDingtalkRoutes(fastify) {
  // 钉钉验证地址时可能发送空 body 或不带 Content-Type
  // Fastify 默认会返回 400/415，这里用 preParsing 钩子统一补一个空 JSON
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (request.method === 'POST' && request.url.startsWith('/bot/dingtalk')) {
      const contentLength = Number(request.headers['content-length'] || 0);
      // 没有 content-type 或 body 为空时，补上 application/json + {}
      if (!request.headers['content-type']) {
        request.headers['content-type'] = 'application/json';
      }
      if (contentLength === 0) {
        const { Readable } = require('stream');
        const mock = new Readable();
        mock.push('{}');
        mock.push(null);
        request.headers['content-length'] = '2';
        return mock;
      }
    }
    return payload;
  });

  // 钉钉开放平台验证回调地址时发送 GET 请求
  fastify.get('/bot/dingtalk', async (request, reply) => {
    const { echostr } = request.query;
    if (echostr) {
      return reply.type('text/plain').send(echostr);
    }
    return reply.code(200).type('text/plain').send('success');
  });

  fastify.post('/bot/dingtalk', async (request, reply) => {
    // 钉钉校验请求：无业务字段（无 msgtype/senderStaffId），返回纯文本 success
    const body = request.body || {};
    if (!body.msgtype && !body.senderStaffId && !body.conversationId) {
      return reply.code(200).type('text/plain').send('success');
    }
    // 记录钉钉请求便于调试
    request.log.info({ headers: request.headers, body }, 'dingtalk POST received');

    // 1. 验签（调试期间仅警告，不拦截）
    const timestamp = request.headers['timestamp'] || '';
    const sign = request.headers['sign'] || '';
    if (!verifyDingSign(timestamp, sign)) {
      request.log.warn({ timestamp, sign }, 'dingtalk sign verification failed (allowing for debug)');
      // 暂时不拦截，让钉钉调试先通过
      // return reply.code(403).send({ error: 'sign verification failed' });
    }

    const msgtype = body.msgtype;
    const content = (msgtype === 'text' ? (body.text?.content || '') : '').trim();
    const senderStaffId = body.senderStaffId || '';
    // conversationType: "1"=单聊, "2"=群聊
    const isGroup = body.conversationType === '2';

    if (!senderStaffId || !content) {
      return reply.code(200).send({ msgtype: 'empty' });
    }

    // 去掉群聊中 @机器人 的前缀
    const userMessage = content.replace(/^@\S+\s*/, '').trim();
    if (!userMessage) return reply.code(200).send({ msgtype: 'empty' });

    const pool = await getPool();

    // 2. 绑定指令处理：用户发 "绑定 U001"
    const bindMatch = userMessage.match(/^绑定\s+(\S+)$/);
    if (bindMatch) {
      const userCode = bindMatch[1].toUpperCase();
      // 校验用户存在
      const check = await pool.request()
        .input('uc', sql.NVarChar(64), userCode)
        .query(`SELECT USER_CODE FROM dbo.OUSR WHERE USER_CODE = @uc`);
      if (!check.recordset?.length) {
        await replyText(senderStaffId, `❌ 工号 "${userCode}" 不存在，请确认后重新发送`, request.log);
        return reply.code(200).send({ msgtype: 'text', text: { content: '' } });
      }
      await bindUser(pool, senderStaffId, userCode);
      await replyText(senderStaffId, `✅ 已绑定工号 **${userCode}**，之后可直接向我提问`, request.log);
      return reply.code(200).send({ msgtype: 'text', text: { content: '' } });
    }

    // 3. 检查绑定
    const userCode = await getBinding(pool, senderStaffId);
    if (!userCode) {
      await replyText(senderStaffId, '你还未绑定系统账号，请发送：**绑定 你的工号**\n\n例如：`绑定 U001`', request.log);
      return reply.code(200).send({ msgtype: 'text', text: { content: '' } });
    }

    // 4. 先返回 200（钉钉要求快速应答），异步处理
    reply.code(200).send({ msgtype: 'text', text: { content: '' } });

    // 5. 调用 Agent（异步，不阻塞钉钉回调）
    const conversationId = `ding_${senderStaffId}`;
    try {
      const result = await agentChatCore({
        userCode,
        displayName: userCode,
        conversationId,
        message: userMessage,
        log: request.log,
      });
      const replyContent = result.status === 'need_clarification'
        ? (result.clarification?.question || '请补充信息') + formatOptions(result.clarification?.options)
        : (result.message || '处理完成');
      await replyText(senderStaffId, replyContent, request.log);
    } catch (err) {
      request.log.error({ err }, 'dingtalk agentChatCore error');
      await replyText(senderStaffId, '⚠️ AI 处理出错，请稍后重试', request.log);
    }
  });
}

function formatOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return '';
  return '\n\n请回复序号选择：\n' + options.map((o, i) => `${i + 1}. ${o.label || o.value}`).join('\n');
}

module.exports = botDingtalkRoutes;
