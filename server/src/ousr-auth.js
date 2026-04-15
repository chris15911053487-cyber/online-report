const crypto = require('crypto');

/**
 * 将库中 PortNum 等字段转为可比较的字符串（兼容 Buffer、数字、BigInt 等）
 */
function normalizeDbCredential(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/**
 * 与 OUSR 中 PortNum 做常量时间比较；任何异常都视为不匹配，避免抛错导致 500
 */
function timingSafeEqualStr(inputPassword, dbPortNum) {
  try {
    const x = Buffer.from(normalizeDbCredential(inputPassword), 'utf8');
    const y = Buffer.from(normalizeDbCredential(dbPortNum), 'utf8');
    if (x.length !== y.length) {
      return false;
    }
    return crypto.timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/**
 * 由 OUSR 用户代码生成稳定的 user_id（写入 work_reports.user_id，与 JWT sub 一致，不依赖 app_users 表）
 */
function userCodeToStableBigInt(userCode) {
  const h = crypto.createHash('sha256').update(String(userCode), 'utf8').digest();
  let n = 0n;
  for (let i = 0; i < 6; i++) {
    n = (n << 8n) | BigInt(h[i]);
  }
  return n;
}

module.exports = {
  timingSafeEqualStr,
  normalizeDbCredential,
  userCodeToStableBigInt,
};
