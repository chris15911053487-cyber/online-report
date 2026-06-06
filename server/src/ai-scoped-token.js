/**
 * Scoped token：主后端签发给 ai-agent 的短期令牌。
 *
 * 设计目的（见 .cursor 设计讨论）：
 * - Agent 容器无 DB 凭据，数据访问必须回调主后端 skill 端点；
 * - 回调时带本令牌，主后端据此还原"当前用户 + 角色"并做 canAccessMenu 门禁；
 * - 与用户登录 JWT 分离的独立密钥（AI_SCOPED_SECRET），短期有效、可吊销。
 *
 * 不引入额外依赖：使用 Node 内置 crypto 做 HMAC-SHA256 签名的紧凑令牌。
 * 格式：base64url(payloadJson).base64url(hmac)
 */
const crypto = require('crypto');

function getSecret() {
  const s =
    process.env.AI_SCOPED_SECRET ||
    process.env.JWT_SECRET ||
    'change-me-ai-scoped-secret';
  return String(s);
}

function getTtlSeconds() {
  const n = Number(process.env.AI_SCOPED_TTL_SECONDS || 300);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecodeToString(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function sign(payloadB64) {
  return b64urlEncode(
    crypto.createHmac('sha256', getSecret()).update(payloadB64).digest()
  );
}

/**
 * 为某次 Agent 调用签发 scoped token。
 * @param {object} opts
 * @param {string} opts.userCode  OUSR.USER_CODE
 * @param {string} opts.displayName
 * @param {string[]} opts.roles   已解析角色
 * @param {string} opts.conversationId 会话/线程 id（用于 thread 归属校验）
 */
function signScopedToken(opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(opts.userCode || ''),
    name: String(opts.displayName || opts.userCode || ''),
    roles: Array.isArray(opts.roles) ? opts.roles : [],
    cid: String(opts.conversationId || ''),
    iat: now,
    exp: now + getTtlSeconds(),
    scope: 'ai-agent',
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * 校验并解析 scoped token。
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function verifyScopedToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'malformed token' };
  }
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return { ok: false, error: 'malformed token' };

  const expected = sign(payloadB64);
  // 定长比较，防时序侧信道
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad signature' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    return { ok: false, error: 'bad payload' };
  }

  if (payload.scope !== 'ai-agent') return { ok: false, error: 'bad scope' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { ok: false, error: 'token expired' };
  }
  return { ok: true, payload };
}

/** 从 scoped token payload 还原 request.user 形态，供 roles.js 复用 */
function userFromScopedPayload(payload) {
  return {
    sub: payload.sub,
    username: payload.sub,
    displayName: payload.name,
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    role: (payload.roles || []).includes('admin') ? 'admin' : 'operator',
  };
}

module.exports = {
  signScopedToken,
  verifyScopedToken,
  userFromScopedPayload,
  getTtlSeconds,
};
