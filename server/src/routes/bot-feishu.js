/**
 * 飞书机器人 Webhook 路由。
 *
 * 协议：
 * - URL 验证：POST {"challenge":"xxx","type":"url_verification"} → 返回 {"challenge":"xxx"}
 * - 消息事件：POST (可选加密) → 解析 im.message.receive_v1 → agentChatCore → 回复
 */
const crypto = require('crypto');
const { getPool, sql } = require('../db');
const { agentChatCore } = require('../agent-chat-core');

function getAppId() { return process.env.FEISHU_APP_ID || ''; }
function getAppSecret() { return process.env.FEISHU_APP_SECRET || ''; }
function getVerificationToken() { return process.env.FEISHU_VERIFICATION_TOKEN || ''; }
function getEncryptKey() { return process.env.FEISHU_ENCRYPT_KEY || ''; }

// ---------- 解密（飞书 AES-256-CBC） ----------

function decryptEvent(encrypted) {
  const key = getEncryptKey();
  const keyBuf = crypto.createHash('sha256').update(key).digest();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.slice(0, 16);
  const data = buf.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

// ---------- 飞书 API ----------

let _tokenCache = { token: '', expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: getAppId(), app_secret: getAppSecret() }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('飞书 token: ' + data.msg);
  _tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + (data.expire || 7200) * 1000 - 60000 };
  return _tokenCache.token;
}

async function replyMessage(messageId, text, log) {
  const token = await getAccessToken();
  const content = JSON.stringify({ text: truncate(text) });
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msg_type: 'text', content }),
  });
  const data = await res.json();
  if (data.code !== 0) log?.warn?.({ data }, 'feishu reply failed');
}

async function sendDirectMessage(openId, text, log) {
  const token = await getAccessToken();
  const content = JSON.stringify({ text: truncate(text) });
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: 'text', content }),
  });
  const data = await res.json();
  if (data.code !== 0) log?.warn?.({ data }, 'feishu send failed');
}

function truncate(text) {
  if (!text) return '（无回复）';
  return text.length > 4000 ? text.slice(0, 4000) + '\n\n…（内容过长已截断）' : text;
}

// ---------- 用户绑定 ----------

async function getBinding(pool, uid) {
  const rs = await pool.request()
    .input('p', sql.VarChar(20), 'feishu')
    .input('uid', sql.NVarChar(128), uid)
    .query('SELECT user_code FROM dbo.bot_user_bindings WHERE platform = @p AND platform_uid = @uid');
  return rs.recordset?.[0]?.user_code || null;
}

async function bindUser(pool, uid, userCode) {
  await pool.request()
    .input('p', sql.VarChar(20), 'feishu')
    .input('uid', sql.NVarChar(128), uid)
    .input('uc', sql.NVarChar(64), userCode)
    .query(`MERGE dbo.bot_user_bindings AS t
            USING (SELECT @p AS platform, @uid AS platform_uid) AS s
            ON t.platform = s.platform AND t.platform_uid = s.platform_uid
            WHEN MATCHED THEN UPDATE SET user_code = @uc
            WHEN NOT MATCHED THEN INSERT (platform, platform_uid, user_code) VALUES (@p, @uid, @uc);`);
}

// ---------- 去重（飞书可能重发） ----------
const _processed = new Set();
function isDuplicate(eventId) {
  if (_processed.has(eventId)) return true;
  _processed.add(eventId);
  if (_processed.size > 500) {
    const first = _processed.values().next().value;
    _processed.delete(first);
  }
  return false;
}

// ---------- 路由注册 ----------

async function botFeishuRoutes(fastify) {
  fastify.post('/bot/feishu', async (request, reply) => {
    let body = request.body || {};

    // 解密
    if (body.encrypt) {
      try { body = decryptEvent(body.encrypt); } catch {
        return reply.code(400).send({ error: 'decrypt failed' });
      }
    }

    // URL 验证
    if (body.type === 'url_verification') {
      const token = body.token;
      if (getVerificationToken() && token !== getVerificationToken()) {
        return reply.code(403).send({ error: 'token mismatch' });
      }
      return { challenge: body.challenge };
    }

    // 事件处理
    const header = body.header || body.schema && body;
    const event = body.event;
    if (!event) return reply.code(200).send({ ok: true });

    const eventType = header?.event_type || body.header?.event_type;
    if (eventType !== 'im.message.receive_v1') return reply.code(200).send({ ok: true });

    const eventId = header?.event_id || '';
    if (eventId && isDuplicate(eventId)) return reply.code(200).send({ ok: true });

    const message = event.message || {};
    const sender = event.sender?.sender_id?.open_id || '';
    const messageId = message.message_id || '';
    const chatType = message.chat_type; // 'p2p' or 'group'

    // 只处理文本
    if (message.message_type !== 'text') return reply.code(200).send({ ok: true });

    let text = '';
    try { text = JSON.parse(message.content || '{}').text || ''; } catch {}
    text = text.replace(/@_user_\d+/g, '').trim(); // 去掉 @机器人

    if (!text || !sender) return reply.code(200).send({ ok: true });

    // 快速返回
    reply.code(200).send({ ok: true });

    const pool = await getPool();
    const sendReply = (msg) => chatType === 'p2p'
      ? sendDirectMessage(sender, msg, request.log)
      : replyMessage(messageId, msg, request.log);

    // 绑定指令
    const bindMatch = text.match(/^绑定\s+(\S+)$/);
    if (bindMatch) {
      const userCode = bindMatch[1].toUpperCase();
      const check = await pool.request().input('uc', sql.NVarChar(64), userCode)
        .query('SELECT USER_CODE FROM dbo.OUSR WHERE USER_CODE = @uc');
      if (!check.recordset?.length) {
        await sendReply(`❌ 工号 "${userCode}" 不存在`);
        return;
      }
      await bindUser(pool, sender, userCode);
      await sendReply(`✅ 已绑定工号 ${userCode}`);
      return;
    }

    const userCode = await getBinding(pool, sender);
    if (!userCode) {
      await sendReply('请先绑定账号，发送：绑定 你的工号\n\n例如：绑定 U001');
      return;
    }

    try {
      const result = await agentChatCore({
        userCode,
        displayName: userCode,
        conversationId: `feishu_${sender}`,
        message: text,
        log: request.log,
      });
      const replyText = result.status === 'need_clarification'
        ? (result.clarification?.question || '请补充信息')
        : (result.message || '处理完成');
      await sendReply(replyText);
    } catch (err) {
      request.log.error({ err }, 'feishu agentChatCore error');
      await sendReply('⚠️ AI 处理出错，请稍后重试');
    }
  });
}

module.exports = botFeishuRoutes;
