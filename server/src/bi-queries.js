/**
 * BI 查询库（命名查询）：bi_queries 的校验与增删改查。
 *
 * 一条命名查询 = 一段只读 SQL + 参数定义 + 输出列语义 + 口径说明 + 示例问法 + 缓存策略 + 可见角色。
 * 输出列语义（columns）是看板配置的基础：卡片的维度/度量只能从这里选，格式/单位默认从这里继承；
 * 可下钻维度（dimensions）由 role 为 dimension / time 的列推导（未登记列时沿用手填的旧数据）。
 * 看板卡片、卡片下钻、Agent 追问（run_named_query）共用同一份定义，保证同一个数到处一致。
 *
 * SQL 由管理员编写；这里的只读校验是第二道防线（拒绝多语句、写操作、SELECT INTO、跨服务器访问等），
 * 参数一律 @name 绑定，绝不拼接。
 */
const { sql } = require('./db');
const { normalizeRoleKeys } = require('./roles');
const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');

const QUERY_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLUMN_RE = /^[^\s[\]"'`;]{1,128}$/;
const PARAM_TYPES = new Set(['string', 'number', 'date', 'bool']);
const MAX_PARAMS = 20;
const MAX_DIMENSIONS = 30;
const MAX_COLUMNS = 100;
const MAX_SAMPLE_QUESTIONS = 10;
const COLUMN_ROLES = new Set(['dimension', 'measure', 'time', 'attr']);
const FORMATS = new Set(['number', 'money', 'percent', 'integer']);
const MAX_SQL_CHARS = 100000;
const MAX_CACHE_SECS = 86400;

// 只读校验：出现即拒绝的关键字（在去掉注释、字符串、[标识符] 之后按整词匹配）
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'BACKUP', 'RESTORE', 'DBCC',
  'SHUTDOWN', 'KILL', 'RECONFIGURE', 'BULK', 'WAITFOR', 'INTO', 'USE', 'GO',
  'OPENQUERY', 'OPENROWSET', 'OPENDATASOURCE', 'OPENXML', 'DECLARE', 'SET',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i');
// 系统扩展过程（xp_cmdshell 等）与系统过程
const FORBIDDEN_PREFIX_RE = /\b(xp_|sp_)\w*/i;

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}
function isMissingTable(err) {
  return sqlErrorNumber(err) === 208;
}

function safeParseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 去掉注释、字符串常量、[方括号] 与 "双引号" 标识符，便于做关键字/参数扫描。
 * 字符串替换为 ''，标识符替换为 [x]，保证不会因为列名或常量里出现 DELETE 等字样误判。
 * 未闭合的字符串/注释/标识符视为非法（返回 null）。
 */
function stripSqlForScan(text) {
  const s = String(text || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '-' && n === '-') {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end;
      out += ' ';
      continue;
    }
    if (c === '/' && n === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || ((c === 'N' || c === 'n') && n === "'")) {
      let j = c === "'" ? i + 1 : i + 2;
      for (;;) {
        if (j >= s.length) return null;
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
      out += "''";
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return null;
        if (s[j] === ']') {
          if (s[j + 1] === ']') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
      out += '[x]';
      continue;
    }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return null;
      i = end + 1;
      out += '[x]';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 扫描 SQL 里引用的 @参数（排除 @@系统变量），返回去重后的原始大小写名称 */
function extractSqlParams(scanned) {
  const names = new Map();
  const re = /(^|[^@\w])@([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(scanned))) {
    const k = m[2].toLowerCase();
    if (!names.has(k)) names.set(k, m[2]);
  }
  return [...names.values()];
}

/**
 * 只读校验。返回 { ok, error?, params? }，params 为 SQL 中引用的参数名。
 */
function validateReadonlySql(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'SQL 不能为空' };
  if (raw.length > MAX_SQL_CHARS) return { ok: false, error: `SQL 不能超过 ${MAX_SQL_CHARS} 字符` };
  const scanned = stripSqlForScan(raw);
  if (scanned == null) return { ok: false, error: 'SQL 中有未闭合的字符串、注释或标识符' };
  const body = scanned.trim().replace(/;\s*$/, '');
  if (!/^(SELECT|WITH)\b/i.test(body)) {
    return { ok: false, error: 'SQL 只能以 SELECT 或 WITH 开头' };
  }
  if (body.includes(';')) return { ok: false, error: 'SQL 只能是一条语句（不能含分号分隔的多条语句）' };
  const bad = body.match(FORBIDDEN_RE);
  if (bad) return { ok: false, error: `SQL 含禁止的关键字：${bad[1].toUpperCase()}（只允许只读查询）` };
  const badPrefix = body.match(FORBIDDEN_PREFIX_RE);
  if (badPrefix) return { ok: false, error: `SQL 不能调用系统过程：${badPrefix[0]}` };
  // 四段名 server.db.schema.table = 链接服务器访问
  if (/\b\w+\s*\.\s*\w+\s*\.\s*\w+\s*\.\s*\w+\b/.test(body.replace(/\[x\]/g, 'x'))) {
    return { ok: false, error: 'SQL 不能访问链接服务器（四段名）' };
  }
  return { ok: true, params: extractSqlParams(body) };
}

/** 参数定义规范化 + 校验 */
function normalizeParamDefs(input) {
  const arr = Array.isArray(input) ? input : [];
  if (arr.length > MAX_PARAMS) return { ok: false, error: `参数不能超过 ${MAX_PARAMS} 个` };
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '参数定义须为对象数组' };
    const name = String(raw.name || '').trim().replace(/^@/, '');
    if (!PARAM_NAME_RE.test(name)) return { ok: false, error: `参数名非法：「${name}」` };
    const k = name.toLowerCase();
    if (seen.has(k)) return { ok: false, error: `参数重复：「${name}」` };
    seen.add(k);
    const type = String(raw.type || 'string').trim().toLowerCase();
    if (!PARAM_TYPES.has(type)) {
      return { ok: false, error: `参数「${name}」类型须为 string / number / date / bool` };
    }
    const def = {
      name,
      type,
      label: String(raw.label || '').trim().slice(0, 64),
      required: !!raw.required,
    };
    if (raw.default !== undefined && raw.default !== null && raw.default !== '') {
      if (typeof raw.default === 'object') return { ok: false, error: `参数「${name}」默认值须为简单值` };
      def.default = raw.default;
    }
    out.push(def);
  }
  return { ok: true, value: out };
}

function normalizeDimensions(input) {
  const arr = Array.isArray(input) ? input : [];
  if (arr.length > MAX_DIMENSIONS) return { ok: false, error: `维度不能超过 ${MAX_DIMENSIONS} 个` };
  const out = [];
  for (const raw of arr) {
    const column = String((typeof raw === 'string' ? raw : raw?.column) || '').trim();
    if (!COLUMN_RE.test(column)) return { ok: false, error: `维度列名非法：「${column}」` };
    out.push({ column, label: String((typeof raw === 'object' && raw?.label) || '').trim().slice(0, 64) });
  }
  return { ok: true, value: out };
}

/** 输出列语义：列名唯一；role 决定能当维度还是度量；format / unit / scale 作为卡片的默认展示 */
function normalizeColumns(input) {
  const arr = Array.isArray(input) ? input : [];
  if (arr.length > MAX_COLUMNS) return { ok: false, error: `输出列不能超过 ${MAX_COLUMNS} 个` };
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '输出列须为对象数组' };
    const column = String(raw.column || '').trim();
    if (!COLUMN_RE.test(column)) return { ok: false, error: `输出列名非法：「${column}」` };
    if (seen.has(column)) return { ok: false, error: `输出列重复：「${column}」` };
    seen.add(column);
    const role = String(raw.role || 'dimension').trim().toLowerCase();
    if (!COLUMN_ROLES.has(role)) return { ok: false, error: `列「${column}」角色须为 dimension / measure / time / attr` };
    const col = { column, label: String(raw.label || '').trim().slice(0, 64), role };
    if (raw.format != null && raw.format !== '') {
      if (!FORMATS.has(raw.format)) return { ok: false, error: `列「${column}」格式须为 number / money / percent / integer` };
      col.format = raw.format;
    }
    const unit = String(raw.unit || '').trim().slice(0, 16);
    if (unit) col.unit = unit;
    if (raw.scale != null && raw.scale !== '') {
      const n = Number(raw.scale);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `列「${column}」缩放须为正数（如 10000 表示按万显示）` };
      if (n !== 1) col.scale = n;
    }
    out.push(col);
  }
  return { ok: true, value: out };
}

function normalizeSampleQuestions(input) {
  const arr = (Array.isArray(input) ? input : [])
    .map((q) => String(q ?? '').trim())
    .filter(Boolean);
  if (arr.length > MAX_SAMPLE_QUESTIONS) return { ok: false, error: `示例问法不能超过 ${MAX_SAMPLE_QUESTIONS} 条` };
  if (arr.some((q) => q.length > 200)) return { ok: false, error: '每条示例问法不能超过 200 字' };
  return { ok: true, value: [...new Set(arr)] };
}

/** 由列语义推导可下钻维度（role 为 dimension / time 的列） */
function dimensionsFromColumns(columns) {
  return columns
    .filter((c) => c.role === 'dimension' || c.role === 'time')
    .slice(0, MAX_DIMENSIONS)
    .map((c) => ({ column: c.column, label: c.label }));
}

/** 校验输入。返回 { ok, error?, value? } */
function validateQueryInput(input) {
  const queryKey = String(input?.queryKey || '').trim().toLowerCase();
  if (!QUERY_KEY_RE.test(queryKey)) {
    return { ok: false, error: 'queryKey 须为小写字母开头、仅含小写字母/数字/下划线/连字符、≤64 字符' };
  }
  const label = String(input?.label || '').trim();
  if (!label) return { ok: false, error: '显示名称不能为空' };
  if (label.length > 128) return { ok: false, error: '显示名称不能超过 128 字符' };
  const description = String(input?.description || '').trim();
  if (description.length > 1024) return { ok: false, error: '说明不能超过 1024 字符' };
  const caliberNote = String(input?.caliberNote || '').trim();
  if (caliberNote.length > 1024) return { ok: false, error: '口径说明不能超过 1024 字符' };

  const sqlText = String(input?.sqlText || '').trim();
  const ro = validateReadonlySql(sqlText);
  if (!ro.ok) return ro;

  const params = normalizeParamDefs(input?.params);
  if (!params.ok) return params;
  const declared = new Set(params.value.map((p) => p.name.toLowerCase()));
  const undeclared = ro.params.filter((p) => !declared.has(p.toLowerCase()));
  if (undeclared.length > 0) {
    return { ok: false, error: `SQL 引用了未声明的参数：${undeclared.map((p) => '@' + p).join('、')}` };
  }

  const columns = normalizeColumns(input?.columns);
  if (!columns.ok) return columns;
  const sampleQuestions = normalizeSampleQuestions(input?.sampleQuestions);
  if (!sampleQuestions.ok) return sampleQuestions;
  // 登记了列语义时维度由它推导；否则沿用手填的 dimensions（兼容旧数据）
  const dims = columns.value.length > 0 ? { ok: true, value: dimensionsFromColumns(columns.value) } : normalizeDimensions(input?.dimensions);
  if (!dims.ok) return dims;

  const rawCache = Number(input?.cacheSecs);
  const cacheSecs = Number.isFinite(rawCache)
    ? Math.max(0, Math.min(MAX_CACHE_SECS, Math.floor(rawCache)))
    : 300;

  return {
    ok: true,
    value: {
      queryKey,
      label,
      description,
      sqlText,
      params: params.value,
      columns: columns.value,
      dimensions: dims.value,
      sampleQuestions: sampleQuestions.value,
      caliberNote,
      cacheSecs,
      roles: normalizeRoleKeys(Array.isArray(input?.roles) ? input.roles : []),
      enabled: input?.enabled !== false,
    },
  };
}

/** 门禁：管理员始终可用；roles 为空 = 仅管理员（与 skill / agent 一致） */
function canUseQuery(userRoles, queryRoles) {
  const u = normalizeRoleKeys(userRoles);
  if (u.includes('admin')) return true;
  const q = normalizeRoleKeys(queryRoles);
  return q.some((r) => u.includes(r));
}

function rowToQuery(row) {
  const params = normalizeParamDefs(safeParseJson(row.params_json, []));
  const dims = normalizeDimensions(safeParseJson(row.dimensions_json, []));
  const columns = normalizeColumns(safeParseJson(row.columns_json, []));
  const samples = normalizeSampleQuestions(safeParseJson(row.sample_questions_json, []));
  return {
    id: Number(row.id),
    queryKey: String(row.query_key),
    label: String(row.label || ''),
    description: String(row.description || ''),
    sqlText: String(row.sql_text || ''),
    params: params.ok ? params.value : [],
    columns: columns.ok ? columns.value : [],
    dimensions: dims.ok ? dims.value : [],
    sampleQuestions: samples.ok ? samples.value : [],
    caliberNote: String(row.caliber_note || ''),
    cacheSecs: Math.max(0, Number(row.cache_secs) || 0),
    roles: normalizeRoleKeys(safeParseJson(row.roles_json, [])),
    enabled: !!row.enabled,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const QUERY_COLS = `id, query_key, label, description, sql_text, params_json, dimensions_json,
  columns_json, sample_questions_json, caliber_note, cache_secs, roles_json, enabled, updated_at`;

// ---- 进程内缓存全量定义（看板每张卡片都要取定义，不能每次查库）----
let listCache = null; // { at, items }
let listInflight = null;
const changeListeners = new Set();

function cacheTtlMs() {
  const n = Number(process.env.BI_QUERY_DEF_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

/** 定义变更时通知（结果缓存据此失效） */
function onQueryChanged(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function invalidateQueryDefs(queryKey) {
  listCache = null;
  for (const fn of changeListeners) {
    try {
      fn(queryKey);
    } catch {
      /* 监听者异常不影响保存 */
    }
  }
}

async function loadAllQueries(pool) {
  try {
    const rs = await pool.request().query(`SELECT ${QUERY_COLS} FROM dbo.bi_queries ORDER BY query_key ASC`);
    return (rs.recordset || []).map(rowToQuery);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** 全量定义（含 SQL；仅服务端与管理侧使用） */
async function listAllQueries(pool) {
  const ttl = cacheTtlMs();
  if (ttl > 0 && listCache && Date.now() - listCache.at < ttl) return listCache.items;
  if (listInflight) return listInflight;
  listInflight = loadAllQueries(pool)
    .then((items) => {
      if (ttl > 0) listCache = { at: Date.now(), items };
      return items;
    })
    .finally(() => {
      listInflight = null;
    });
  return listInflight;
}

async function getQuery(pool, queryKey) {
  const k = String(queryKey || '').trim().toLowerCase();
  if (!k) return null;
  const all = await listAllQueries(pool);
  return all.find((q) => q.queryKey === k) || null;
}

async function upsertQuery(pool, value) {
  await pool
    .request()
    .input('query_key', sql.NVarChar(64), value.queryKey)
    .input('label', sql.NVarChar(128), value.label)
    .input('description', sql.NVarChar(1024), value.description)
    .input('sql_text', sql.NVarChar(sql.MAX), value.sqlText)
    .input('params_json', sql.NVarChar(sql.MAX), JSON.stringify(value.params))
    .input('dimensions_json', sql.NVarChar(sql.MAX), JSON.stringify(value.dimensions))
    .input('columns_json', sql.NVarChar(sql.MAX), JSON.stringify(value.columns || []))
    .input('sample_questions_json', sql.NVarChar(sql.MAX), JSON.stringify(value.sampleQuestions || []))
    .input('caliber_note', sql.NVarChar(1024), value.caliberNote)
    .input('cache_secs', sql.Int, value.cacheSecs)
    .input('roles_json', sql.NVarChar(sql.MAX), JSON.stringify(value.roles))
    .input('enabled', sql.Bit, value.enabled)
    .query(`
      MERGE dbo.bi_queries AS t
      USING (SELECT @query_key AS query_key) AS s ON t.query_key = s.query_key
      WHEN MATCHED THEN UPDATE SET
        label = @label, description = @description, sql_text = @sql_text,
        params_json = @params_json, dimensions_json = @dimensions_json,
        columns_json = @columns_json, sample_questions_json = @sample_questions_json,
        caliber_note = @caliber_note, cache_secs = @cache_secs,
        roles_json = @roles_json, enabled = @enabled,
        updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
      WHEN NOT MATCHED THEN
        INSERT (query_key, label, description, sql_text, params_json, dimensions_json,
                columns_json, sample_questions_json, caliber_note, cache_secs, roles_json, enabled)
        VALUES (@query_key, @label, @description, @sql_text, @params_json, @dimensions_json,
                @columns_json, @sample_questions_json, @caliber_note, @cache_secs, @roles_json, @enabled);
    `);
  invalidateQueryDefs(value.queryKey);
  return getQuery(pool, value.queryKey);
}

async function deleteQuery(pool, queryKey) {
  const k = String(queryKey || '').trim().toLowerCase();
  const rs = await pool
    .request()
    .input('k', sql.NVarChar(64), k)
    .query(`DELETE FROM dbo.bi_queries WHERE query_key = @k`);
  invalidateQueryDefs(k);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

/** 给前端/AI 的公开元数据：不含 SQL */
function toPublicQuery(q) {
  return {
    queryKey: q.queryKey,
    label: q.label,
    description: q.description,
    params: q.params,
    columns: q.columns || [],
    dimensions: q.dimensions,
    caliberNote: q.caliberNote,
    cacheSecs: q.cacheSecs,
  };
}

module.exports = {
  QUERY_KEY_RE,
  PARAM_TYPES,
  stripSqlForScan,
  extractSqlParams,
  validateReadonlySql,
  normalizeParamDefs,
  normalizeColumns,
  COLUMN_ROLES,
  validateQueryInput,
  canUseQuery,
  rowToQuery,
  listAllQueries,
  getQuery,
  upsertQuery,
  deleteQuery,
  toPublicQuery,
  onQueryChanged,
  invalidateQueryDefs,
};
