/**
 * 企业微信机器人 Webhook 路由。
 *
 * 协议：
 * - URL 验证：GET → 解密 echostr 返回明文
 * - 消息接收：POST → 解密 XML → 解析 → agentChatCore → 主动发消息 API 回复
 */
const crypto = require('crypto');
const { getPool, sql } = require('../db');
const { agentChatCore } = require('../agent-chat-core');

function getCorpId() { return process.env.WECOM_CORP_ID || ''; }
function getToken() { return process.env.WECOM_TOKEN || ''; }
function getEncodingAESKey() { return process.env.WECOM_ENCODING_AES_KEY || ''; }
function getAgentId() { return process.env.WECOM_AGENT_ID || ''; }
function getSecret() { return process.env.WECOM_SECRET || ''; }

// ---------- AES 加解密（企业微信规范） ----------

function getAESKey() {
  return Buffer.from(getEncodingAESKey() + '=', 'base64');
}

function decrypt(encrypted) {
  const aesKey = getAESKey();
  const iv = aesKey.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
  // PKCS7 unpad
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - pad);
  // 16 bytes random + 4 bytes msg_len (big-endian) + msg + receiveid
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.slice(20, 20 + msgLen).toString('utf8');
  return msg;
}

function calcSignature(token, timestamp, nonce, encrypt) {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

// ---------- 企微 API ----------

let _tokenCache = { token: '', expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${getCorpId()}&corpsecret=${getSecret()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode) throw new Error('企微 token: ' + data.errmsg);
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 - 60000 };
  return _tokenCache.token;
}

async function sendTextMessage(userId, text, log) {
  const token = await getAccessToken();
  const body = {
    touser: userId,
    msgtype: 'markdown',
    agentid: Number(getAgentId()),
    markdown: { content: truncate(text) },
  };
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.errcode) log?.warn?.({ data }, 'wecom send failed');
}

function truncate(text) {
  if (!text) return '（无回复）';
  return text.length > 2000 ? text.slice(0, 2000) + '\n\n…（内容过长已截断）' : text;
}

// ---------- XML 解析（极简，不引入依赖） ----------

function extractXml(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`))
    || xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : '';
}

// ---------- 用户绑定 ----------

async function getBinding(pool, uid) {
  const rs = await pool.request()
    .input('p', sql.VarChar(20), 'wecom')
    .input('uid', sql.NVarChar(128), uid)
    .query('SELECT user_code FROM dbo.bot_user_bindings WHERE platform = @p AND platform_uid = @uid');
  return rs.recordset?.[0]?.user_code || null;
}

async function bindUser(pool, uid, userCode) {
  await pool.request()
    .input('p', sql.VarChar(20), 'wecom')
    .input('uid', sql.NVarChar(128), uid)
    .input('uc', sql.NVarChar(64), userCode)
    .query(`MERGE dbo.bot_user_bindings AS t
            USING (SELECT @p AS platform, @uid AS platform_uid) AS s
            ON t.platform = s.platform AND t.platform_uid = s.platform_uid
            WHEN MATCHED THEN UPDATE SET user_code = @uc
            WHEN NOT MATCHED THEN INSERT (platform, platform_uid, user_code) VALUES (@p, @uid, @uc);`);
}

// ---------- 路由注册 ----------

async function botWecomRoutes(fastify) {
  // URL 验证（GET）
  fastify.get('/bot/wecom', async (request, reply) => {
    const { msg_signature, timestamp, nonce, echostr } = request.query;
    const expected = calcSignature(getToken(), timestamp, nonce, echostr);
    if (expected !== msg_signature) return reply.code(403).send('verify fail');
    const plain = decrypt(echostr);
    reply.type('text/plain').send(plain);
  });

  // 消息接收（POST）
  fastify.post('/bot/wecom', { config: { rawBody: true } }, async (request, reply) => {
    const { msg_signature, timestamp, nonce } = request.query;
    const rawXml = typeof request.body === 'string' ? request.body : String(request.body || '');
    const encrypt = extractXml(rawXml, 'Encrypt');
    if (!encrypt) return reply.code(200).send('success');

    const expected = calcSignature(getToken(), timestamp, nonce, encrypt);
    if (expected !== msg_signature) return reply.code(403).send('sign fail');

    const xml = decrypt(encrypt);
    const msgType = extractXml(xml, 'MsgType');
    if (msgType !== 'text') return reply.code(200).send('success');

    const content = extractXml(xml, 'Content').trim();
    const fromUser = extractXml(xml, 'FromUserName');
    if (!content || !fromUser) return reply.code(200).send('success');

    // 必须快速返回（5秒内），异步处理
    reply.code(200).send('success');

    const pool = await getPool();

    // 绑定指令
    const bindMatch = content.match(/^绑定\s+(\S+)$/);
    if (bindMatch) {
      const userCode = bindMatch[1].toUpperCase();
      const check = await pool.request().input('uc', sql.NVarChar(64), userCode)
        .query('SELECT USER_CODE FROM dbo.OUSR WHERE USER_CODE = @uc');
      if (!check.recordset?.length) {
        await sendTextMessage(fromUser, `❌ 工号 "${userCode}" 不存在`, request.log);
        return;
      }
      await bindUser(pool, fromUser, userCode);
      await sendTextMessage(fromUser, `✅ 已绑定工号 **${userCode}**`, request.log);
      return;
    }

    const userCode = await getBinding(pool, fromUser);
    if (!userCode) {
      await sendTextMessage(fromUser, '请先绑定账号，发送：**绑定 你的工号**\n\n例如：`绑定 U001`', request.log);
      return;
    }

    try {
      const result = await agentChatCore({
        userCode,
        displayName: userCode,
        conversationId: `wecom_${fromUser}`,
        message: content,
        log: request.log,
      });
      const replyText = result.status === 'need_clarification'
        ? (result.clarification?.question || '请补充信息')
        : (result.message || '处理完成');
      await sendTextMessage(fromUser, replyText, request.log);
    } catch (err) {
      request.log.error({ err }, 'wecom agentChatCore error');
      await sendTextMessage(fromUser, '⚠️ AI 处理出错，请稍后重试', request.log);
    }
  });
}

module.exports = botWecomRoutes;
