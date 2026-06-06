/**
 * 中国本地墙钟时间（Asia/Shanghai），与工厂报工界面时钟一致。
 * SQL Server 无 timezone 的 DATETIME2 列应存此类时间，勿直接写 UTC（toISOString / SYSUTCDATETIME）。
 */

const CHINA_TZ = 'Asia/Shanghai';

const CHINA_STANDARD_TIME_SQL = `'China Standard Time'`;

/**
 * SQL 表达式：当前中国本地时间，用于 DEFAULT / INSERT。
 * 注意：生产库为 SQL Server 2012，不支持 `AT TIME ZONE`（2016+ 才有）。
 * 中国自 1991 年起无夏令时，固定 UTC+8，故用 DATEADD(HOUR, 8, SYSUTCDATETIME())
 * 得到与 `... AT TIME ZONE 'China Standard Time'` 完全一致的墙钟时间，且全版本兼容。
 */
const SQL_CHINA_LOCAL_NOW_EXPR = `DATEADD(HOUR, 8, SYSUTCDATETIME())`;

function formatInstantChinaLocal(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CHINA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

/**
 * 将 Date / ISO / 前端本地字符串转为 `YYYY-MM-DD HH:mm:ss`（中国墙钟），供 sql.DateTime2 绑定。
 */
function toChinaLocalDateTimeForSql(value) {
  if (value == null || value === '') return formatInstantChinaLocal(new Date());
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? formatInstantChinaLocal(new Date())
      : formatInstantChinaLocal(value);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ+-]\d{2}:?\d{2}$/.test(s) && !s.endsWith('Z')) {
    return s.replace('T', ' ').slice(0, 19);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? formatInstantChinaLocal(new Date()) : formatInstantChinaLocal(d);
}

module.exports = {
  CHINA_TZ,
  SQL_CHINA_LOCAL_NOW_EXPR,
  formatInstantChinaLocal,
  toChinaLocalDateTimeForSql,
};
