/**
 * 服务端解析 BI 动态值记号（看板筛选默认值、预警参数、每日要点）：按中国本地日期（UTC+8）计算，
 * 与前端 utils/bi.ts 的 resolveDefaultToken 同名同义，另加 $thisYear / $lastYear。
 * 以及「上一期」推算（预警的环比）：'YYYY-MM' 按月、'YYYY' 按年、'YYYY-MM-DD' 按天。
 */
const TOKENS = ['$today', '$yesterday', '$thisMonth', '$lastMonth', '$monthStart', '$yearStart', '$thisYear', '$lastYear'];

const pad = (n) => String(n).padStart(2, '0');

/** 中国本地「今天」的年月日（不依赖服务器时区） */
function chinaYmd(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function fmtDate(y, m, d) {
  const x = new Date(Date.UTC(y, m - 1, d));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
function fmtMonth(y, m) {
  const x = new Date(Date.UTC(y, m - 1, 1));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`;
}

/** 记号 → 值；不是记号原样返回；未知记号返回 null */
function resolveToken(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.startsWith('$')) return value ?? null;
  const t = chinaYmd(now);
  switch (value) {
    case '$today':
      return fmtDate(t.y, t.m, t.d);
    case '$yesterday':
      return fmtDate(t.y, t.m, t.d - 1);
    case '$thisMonth':
      return fmtMonth(t.y, t.m);
    case '$lastMonth':
      return fmtMonth(t.y, t.m - 1);
    case '$monthStart':
      return fmtDate(t.y, t.m, 1);
    case '$yearStart':
      return `${t.y}-01-01`;
    case '$thisYear':
      return String(t.y);
    case '$lastYear':
      return String(t.y - 1);
    default:
      return null;
  }
}

function resolveTokens(params, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) out[k] = resolveToken(v, now);
  return out;
}

/** 期间值前后推 n 期；认不出格式返回 null */
function shiftPeriod(value, n) {
  const s = String(value ?? '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return fmtDate(+m[1], +m[2], +m[3] + n);
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return fmtMonth(+m[1], +m[2] + n);
  if ((m = /^(\d{4})$/.exec(s))) return String(+m[1] + n);
  return null;
}

module.exports = { TOKENS, resolveToken, resolveTokens, shiftPeriod, chinaYmd };
