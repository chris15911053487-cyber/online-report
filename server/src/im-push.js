/**
 * 企业微信 / 飞书：给单个用户发一条消息（应用消息）。
 * 钉钉个人消息与群 Webhook 在 alert-dingtalk.js。统一由 notify.js 调用。
 */

function truncate(text, max) {
  if (!text) return '（无内容）';
  return text.length > max ? text.slice(0, max) + '\n\n…（内容过长已截断）' : text;
}

// --- 企业微信 ---
let _wecomToken = { token: '', expiresAt: 0 };
async function getWecomAccessToken() {
  if (_wecomToken.token && Date.now() < _wecomToken.expiresAt) return _wecomToken.token;
  const corpId = process.env.WECOM_CORP_ID || '';
  const secret = process.env.WECOM_SECRET || '';
  if (!corpId || !secret) return null;
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
  const data = await res.json();
  if (!data.access_token) return null;
  _wecomToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 - 60000 };
  return _wecomToken.token;
}

/** @returns {Promise<{success: boolean, error?: string}>} */
async function sendWecom(platformUid, text) {
  const token = await getWecomAccessToken();
  if (!token) return { success: false, error: '企业微信 token 获取失败' };
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: platformUid,
      msgtype: 'markdown',
      agentid: Number(process.env.WECOM_AGENT_ID || 0),
      markdown: { content: truncate(text, 4000) },
    }),
  });
  const data = await res.json();
  return data.errcode ? { success: false, error: JSON.stringify(data) } : { success: true };
}

// --- 飞书 ---
let _feishuToken = { token: '', expiresAt: 0 };
async function getFeishuAccessToken() {
  if (_feishuToken.token && Date.now() < _feishuToken.expiresAt) return _feishuToken.token;
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) return null;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) return null;
  _feishuToken = { token: data.tenant_access_token, expiresAt: Date.now() + (data.expire || 7200) * 1000 - 60000 };
  return _feishuToken.token;
}

/** @returns {Promise<{success: boolean, error?: string}>} */
async function sendFeishu(platformUid, text) {
  const token = await getFeishuAccessToken();
  if (!token) return { success: false, error: '飞书 token 获取失败' };
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: platformUid, msg_type: 'text', content: JSON.stringify({ text: truncate(text, 4000) }) }),
  });
  const data = await res.json();
  return data.code !== 0 ? { success: false, error: JSON.stringify(data) } : { success: true };
}

module.exports = { sendWecom, sendFeishu };
