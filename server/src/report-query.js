const { sql } = require('./db');

const RESERVED_ROUTE_KEYS = new Set(['orders', 'menu-settings']);

const DANGEROUS_SQL_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|GRANT|REVOKE|DENY)\b/i;

/** @returns {number} */
function getReportMaxRows() {
  const n = Number(process.env.REPORT_MAX_ROWS ?? 2000);
  if (!Number.isFinite(n) || n < 1) return 2000;
  return Math.min(Math.trunc(n), 50000);
}

/** @returns {number} */
function getReportQueryTimeoutMs() {
  const n = Number(process.env.REPORT_QUERY_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(n) || n < 1000) return 60000;
  return Math.min(Math.trunc(n), 600000);
}

/** 下拉 optionsSql 最大行数 */
function getFilterOptionsSqlMaxRows() {
  const n = Number(process.env.REPORT_FILTER_OPTIONS_MAX_ROWS ?? 500);
  if (!Number.isFinite(n) || n < 1) return 500;
  return Math.min(Math.trunc(n), 5000);
}

/** 下拉 optionsSql 查询超时（毫秒） */
function getFilterOptionsSqlTimeoutMs() {
  const n = Number(process.env.REPORT_FILTER_OPTIONS_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(n) || n < 1000) return 15000;
  return Math.min(Math.trunc(n), 120000);
}

/** 单页最大条数上限（与 REPORT_MAX_ROWS 取 min） */
function getReportMaxPageSize() {
  return Math.min(500, getReportMaxRows());
}

/**
 * @param {unknown} pageRaw
 * @param {unknown} pageSizeRaw
 * @returns {{ page: number, pageSize: number }}
 * 省略 page / pageSize 时：page=1、pageSize=REPORT_MAX_ROWS（兼容旧客户端一次取满页上限）。
 */
function normalizeReportPaging(pageRaw, pageSizeRaw) {
  const maxRows = getReportMaxRows();
  const maxPageSize = getReportMaxPageSize();
  const pageMissing = pageRaw === undefined || pageRaw === null || pageRaw === '';
  const pageSizeMissing =
    pageSizeRaw === undefined || pageSizeRaw === null || pageSizeRaw === '';

  let page = 1;
  let pageSize = maxRows;

  if (!pageMissing) {
    page = Math.trunc(Number(pageRaw));
    if (!Number.isFinite(page) || page < 1) {
      const err = new Error('page 须为不小于 1 的整数');
      err.code = 'REPORT_BAD_PAGING';
      throw err;
    }
  }
  if (!pageSizeMissing) {
    pageSize = Math.trunc(Number(pageSizeRaw));
    if (!Number.isFinite(pageSize) || pageSize < 1) {
      const err = new Error('pageSize 须为不小于 1 的整数');
      err.code = 'REPORT_BAD_PAGING';
      throw err;
    }
    if (pageSize > maxPageSize) {
      const err = new Error(`pageSize 不能超过 ${maxPageSize}`);
      err.code = 'REPORT_BAD_PAGING';
      throw err;
    }
  }

  return { page, pageSize };
}

function normalizeTemplate(s) {
  return String(s || '')
    .trim()
    .replace(/;+\s*$/g, '');
}

/**
 * @param {string} text
 * @returns {'select'|'exec'|null}
 */
function detectTemplateKind(text) {
  const t = normalizeTemplate(text);
  if (!t) return null;
  if (/^\s*(EXEC|EXECUTE)\s+/i.test(t)) return 'exec';
  if (/^\s*WITH\s+/i.test(t)) return 'select';
  if (/^\s*SELECT\s+/i.test(t)) return 'select';
  return null;
}

function validateSingleStatement(t) {
  const normalized = normalizeTemplate(t);
  const parts = normalized
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length > 1) {
    return { ok: false, error: '不允许多条语句（请勿使用分号连接多条 SQL）' };
  }
  return { ok: true, statement: parts[0] || normalized };
}

function validateNoDynamicExec(t) {
  if (/\bEXEC(UTE)?\s*\(/i.test(t)) {
    return { ok: false, error: '不允许 EXEC(...) 动态 SQL' };
  }
  if (/\bsp_executesql\b/i.test(t)) {
    return { ok: false, error: '不允许使用 sp_executesql' };
  }
  return { ok: true };
}

function validateSelectTemplate(t) {
  const st = normalizeTemplate(t);
  if (!/^\s*(WITH\s|SELECT\s)/i.test(st)) {
    return { ok: false, error: 'SELECT 模板须以 SELECT 或 WITH 开头' };
  }
  if (DANGEROUS_SQL_PATTERN.test(st)) {
    return { ok: false, error: 'SELECT 模板中不允许包含 INSERT/UPDATE/DELETE/DROP 等关键字' };
  }
  return { ok: true };
}

function validateExecTemplate(t) {
  const st = normalizeTemplate(t);
  const m = st.match(/^\s*(EXEC|EXECUTE)\s+(.+)$/is);
  if (!m) {
    return { ok: false, error: '存储过程模板须以 EXEC 或 EXECUTE 开头' };
  }
  const rest = m[2].trim();
  if (!/^[\w\[\].]+/.test(rest)) {
    return { ok: false, error: '无法解析存储过程名称' };
  }
  if (DANGEROUS_SQL_PATTERN.test(st)) {
    return { ok: false, error: 'EXEC 模板中含不允许的关键字' };
  }
  return { ok: true };
}

/**
 * @param {string} sqlText
 * @returns {Set<string>}
 */
function extractParamNames(sqlText) {
  const set = new Set();
  const re = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(sqlText)) !== null) {
    const name = m[1];
    if (name.startsWith('_')) continue;
    set.add(name);
  }
  return set;
}

/**
 * 提取 SQL 中全部 @参数名（含下划线前缀，用于 optionsSql 白名单校验）。
 * @param {string} sqlText
 * @returns {Set<string>}
 */
function extractAllSqlParamNames(sqlText) {
  const set = new Set();
  const re = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(String(sqlText || ''))) !== null) {
    set.add(m[1]);
  }
  return set;
}

/**
 * 会话注入占位符（SQL 中写 @_xxx，无需出现在 filterSchema；客户端不可改）。
 * @_loginUser：登录用户编码（JWT username，与 OUSR 用户编码一致）
 * @_loginDisplayName：显示名（无则与编码相同）
 */
const REPORT_SESSION_INJECT_PARAMS = [
  { key: '_loginUser', maxLen: 128 },
  { key: '_loginDisplayName', maxLen: 256 },
];

/** optionsSql 子查询中允许的 @参数（与会话注入一致） */
const FILTER_OPTIONS_SQL_ALLOWED_PARAMS = new Set(
  REPORT_SESSION_INJECT_PARAMS.map((p) => p.key)
);

/**
 * @param {string} sqlRaw
 * @param {string} filterParamName filterSchema 中的参数名（用于错误信息）
 * @returns {{ ok: true, normalized: string } | { ok: false, error: string }}
 */
function validateFilterFieldOptionsSql(sqlRaw, filterParamName) {
  const template = normalizeTemplate(sqlRaw);
  if (!template) {
    return { ok: false, error: `参数 ${filterParamName} 的 optionsSql 不能为空` };
  }
  const single = validateSingleStatement(template);
  if (!single.ok) return single;
  const dyn = validateNoDynamicExec(single.statement);
  if (!dyn.ok) return dyn;
  const kind = detectTemplateKind(single.statement);
  if (kind !== 'select') {
    return {
      ok: false,
      error: `参数 ${filterParamName} 的 optionsSql 仅支持 SELECT（或 WITH…SELECT），不支持 EXEC`,
    };
  }
  const vs = validateSelectTemplate(single.statement);
  if (!vs.ok) return vs;
  for (const n of extractAllSqlParamNames(single.statement)) {
    if (!FILTER_OPTIONS_SQL_ALLOWED_PARAMS.has(n)) {
      return {
        ok: false,
        error: `参数 ${filterParamName} 的 optionsSql 中 @${n} 不可用：仅允许 @_loginUser、@_loginDisplayName`,
      };
    }
  }
  return { ok: true, normalized: single.statement };
}

/**
 * @param {string} sqlText
 * @param {string} paramName 不含 @
 */
function sqlTemplateReferencesParam(sqlText, paramName) {
  return new RegExp(`@${paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
    String(sqlText || '')
  );
}

/**
 * @param {import('mssql').Request} request
 * @param {string} sqlTemplate
 * @param {{ userCode?: string, displayName?: string } | null | undefined} session
 */
function bindReportSessionInjections(request, sqlTemplate, session) {
  if (!session || typeof session !== 'object') return;
  const tpl = String(sqlTemplate || '');
  const userCode =
    session.userCode != null ? String(session.userCode).trim().slice(0, 128) : '';
  const displayRaw =
    session.displayName != null ? String(session.displayName).trim().slice(0, 256) : '';
  const displayName = displayRaw || userCode;

  for (const { key, maxLen } of REPORT_SESSION_INJECT_PARAMS) {
    if (!sqlTemplateReferencesParam(tpl, key)) continue;
    if (key === '_loginUser') {
      request.input('_loginUser', sql.NVarChar(maxLen), userCode);
    } else if (key === '_loginDisplayName') {
      request.input('_loginDisplayName', sql.NVarChar(maxLen), displayName);
    }
  }
}

/**
 * 从 JWT 用户载荷构造报表会话注入对象（供 executeReport* 使用）。
 * @param {unknown} user
 * @returns {{ userCode: string, displayName: string }}
 */
function buildReportSessionInject(user) {
  if (!user || typeof user !== 'object') {
    return { userCode: '', displayName: '' };
  }
  const u = /** @type {{ username?: unknown, displayName?: unknown }} */ (user);
  const userCode = u.username != null ? String(u.username).trim() : '';
  const displayName = u.displayName != null ? String(u.displayName).trim() : '';
  return { userCode, displayName: displayName || userCode };
}

/**
 * @param {object} field
 * @param {unknown} raw
 */
function coerceValue(field, raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  switch (field.type) {
    case 'string': {
      let s = String(raw);
      if (field.maxLength) s = s.slice(0, field.maxLength);
      return s;
    }
    case 'int': {
      const n = parseInt(String(raw), 10);
      if (!Number.isFinite(n)) return null;
      return n;
    }
    case 'decimal': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return n;
    }
    case 'date': {
      const s = String(raw).trim();
      if (!s) return null;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      return s.length <= 10 ? s : d.toISOString().slice(0, 10);
    }
    case 'datetime': {
      const s = String(raw).trim();
      if (!s) return null;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      return d;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (s === '1' || s === 'true' || s === 'yes') return true;
      if (s === '0' || s === 'false' || s === 'no') return false;
      return null;
    }
    default:
      return null;
  }
}

/**
 * @param {string} type
 * @param {unknown} a
 * @param {unknown} b
 */
function valuesEqualForFilterType(type, a, b) {
  if (a === null || b === null) return a === b;
  switch (type) {
    case 'string':
      return String(a) === String(b);
    case 'int':
      return (
        Number.isFinite(Number(a)) &&
        Number.isFinite(Number(b)) &&
        Math.trunc(Number(a)) === Math.trunc(Number(b))
      );
    case 'decimal':
      return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b);
    case 'date':
      return String(a).slice(0, 10) === String(b).slice(0, 10);
    case 'datetime': {
      const da = a instanceof Date ? a : new Date(a);
      const db = b instanceof Date ? b : new Date(b);
      return !Number.isNaN(da.getTime()) && !Number.isNaN(db.getTime()) && da.getTime() === db.getTime();
    }
    case 'bool':
      return !!a === !!b;
    default:
      return false;
  }
}

/**
 * @param {string} type
 * @param {unknown} val
 */
function fingerprintFilterOptionValue(type, val) {
  if (val === null) return '\0null';
  switch (type) {
    case 'string':
      return `s:${String(val)}`;
    case 'int':
      return `i:${Math.trunc(Number(val))}`;
    case 'decimal':
      return `d:${Number(val)}`;
    case 'date':
      return `D:${String(val).slice(0, 10)}`;
    case 'datetime': {
      const d = val instanceof Date ? val : new Date(val);
      return `T:${Number.isNaN(d.getTime()) ? 'NaN' : d.getTime()}`;
    }
    case 'bool':
      return `b:${!!val}`;
    default:
      return `x:${String(val)}`;
  }
}

/**
 * 下拉项：name 为界面展示，code 为提交给 SQL 绑定的值。
 * @param {unknown} rawOptions
 * @param {{ type: string, maxLength?: number }} field
 * @param {string} paramName
 * @returns {{ ok: true, options?: { name: string, code: unknown }[] } | { ok: false, error: string }}
 */
function parseFilterFieldOptions(rawOptions, field, paramName) {
  if (rawOptions === undefined || rawOptions === null) {
    return { ok: true };
  }
  if (!Array.isArray(rawOptions)) {
    return {
      ok: false,
      error: `参数 ${paramName} 的 options 须为数组，每项含 name（界面显示）与 code（提交值）`,
    };
  }
  if (rawOptions.length === 0) {
    return { ok: false, error: `参数 ${paramName} 的 options 须至少包含一项` };
  }
  /** @type {{ name: string, code: unknown }[]} */
  const options = [];
  const seenFp = new Set();
  for (let i = 0; i < rawOptions.length; i++) {
    const item = rawOptions[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `参数 ${paramName} 的 options[${i}] 须为对象` };
    }
    const disp = String(item.name != null ? item.name : '').trim();
    if (!disp) {
      return { ok: false, error: `参数 ${paramName} 的 options[${i}] 须有非空 name（界面显示）` };
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'code')) {
      return { ok: false, error: `参数 ${paramName} 的 options[${i}] 须有 code（提交给后端的值）` };
    }
    const code = item.code;
    if (code === undefined || code === null || code === '') {
      return { ok: false, error: `参数 ${paramName} 的 options[${i}] 的 code 不能为空` };
    }
    const coerced = coerceValue(field, code);
    if (coerced === null) {
      return {
        ok: false,
        error: `参数 ${paramName} 的 options[${i}] 的 code 无法按类型 ${field.type} 解析`,
      };
    }
    const fp = fingerprintFilterOptionValue(field.type, coerced);
    if (seenFp.has(fp)) {
      return { ok: false, error: `参数 ${paramName} 的 options 中存在重复 code（解析后相同）` };
    }
    seenFp.add(fp);
    options.push({ name: disp.slice(0, 256), code });
  }
  return { ok: true, options };
}

/**
 * @param {object} field
 * @param {unknown} val 已 coerce 的非 null 值
 */
function isCoercedValueInFilterOptions(field, val) {
  if (!field.options || field.options.length === 0) return true;
  for (const opt of field.options) {
    const c = coerceValue(field, opt.code);
    if (c !== null && valuesEqualForFilterType(field.type, c, val)) return true;
  }
  return false;
}

/**
 * 静态 options 与 optionsSql 二选一。
 * @param {object} raw filterSchema 数组项
 * @param {{ type: string, maxLength?: number }} field
 * @param {string} paramName
 * @returns
 *   | { ok: true }
 *   | { ok: true, options: { name: string, code: unknown }[] }
 *   | { ok: true, optionsSql: string }
 *   | { ok: false, error: string }
 */
function parseFilterFieldOptionsSource(raw, field, paramName) {
  const sqlTrim = raw.optionsSql != null ? String(raw.optionsSql).trim() : '';
  const hasSql = sqlTrim !== '';
  const o = raw.options;
  if (hasSql) {
    if (o !== undefined && o !== null && !(Array.isArray(o) && o.length === 0)) {
      return { ok: false, error: `参数 ${paramName} 不能同时配置 options 与 optionsSql` };
    }
    const vs = validateFilterFieldOptionsSql(sqlTrim, paramName);
    if (!vs.ok) return vs;
    return { ok: true, optionsSql: vs.normalized };
  }
  return parseFilterFieldOptions(raw.options, field, paramName);
}

/**
 * 执行 filter 字段的 optionsSql，返回下拉项（第一列为显示名，第二列为 code）。
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ name: string, type: string, maxLength?: number, optionsSql: string }} field
 * @param {{ userCode?: string, displayName?: string } | null | undefined} sessionInject
 * @returns {Promise<{ name: string, code: unknown }[]>}
 */
async function loadFilterFieldOptionsItems(pool, field, sessionInject) {
  const sqlTemplate = field.optionsSql;
  const maxRows = getFilterOptionsSqlMaxRows();
  const timeoutMs = getFilterOptionsSqlTimeoutMs();
  const req = pool.request();
  req.timeout = timeoutMs;
  bindReportSessionInjections(req, sqlTemplate, sessionInject);
  const wrapped = `SELECT TOP (${maxRows}) * FROM (${sqlTemplate}) AS __opt_sub`;
  const result = await req.query(wrapped);
  const rows = result.recordset || [];
  /** @type {{ name: string, code: unknown }[]} */
  const items = [];
  const seenFp = new Set();
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (!row || typeof row !== 'object') continue;
    const vals = Object.values(row);
    if (vals.length < 2) {
      const err = new Error(
        `参数 ${field.name} 的 optionsSql 结果每行须至少两列（第 1 列显示名，第 2 列 code）`
      );
      err.code = 'REPORT_OPTIONS_SQL_BAD_RESULT';
      throw err;
    }
    const nameDisp = String(vals[0] != null ? vals[0] : '').trim();
    const codeRaw = vals[1];
    if (!nameDisp) continue;
    if (codeRaw === undefined || codeRaw === null || codeRaw === '') continue;
    const coerced = coerceValue(field, codeRaw);
    if (coerced === null) continue;
    const fp = fingerprintFilterOptionValue(field.type, coerced);
    if (seenFp.has(fp)) continue;
    seenFp.add(fp);
    items.push({ name: nameDisp.slice(0, 256), code: codeRaw });
  }
  return items;
}

/**
 * @param {string} jsonStr
 * @returns {{ ok: true, fields: object[] } | { ok: false, error: string }}
 */
function parseFilterSchemaJson(jsonStr) {
  let parsed;
  try {
    parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch {
    return { ok: false, error: 'filterSchema 不是合法 JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'filterSchema 须为 JSON 数组' };
  }
  const fields = [];
  const seen = new Set();
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'filterSchema 数组项须为对象' };
    }
    const name = String(raw.name || '').trim();
    const label = String(raw.label || '').trim().slice(0, 128);
    const type = String(raw.type || 'string').toLowerCase();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return { ok: false, error: `无效参数名: ${name}` };
    }
    if (name.startsWith('_')) {
      return { ok: false, error: '参数名不能以 _ 开头' };
    }
    if (seen.has(name)) {
      return { ok: false, error: `重复参数名: ${name}` };
    }
    seen.add(name);
    const allowedTypes = new Set(['string', 'int', 'decimal', 'date', 'datetime', 'bool']);
    if (!allowedTypes.has(type)) {
      return { ok: false, error: `不支持的条件类型: ${type}` };
    }
    const maxLength =
      typeof raw.maxLength === 'number' && Number.isFinite(raw.maxLength)
        ? Math.min(Math.trunc(raw.maxLength), 4000)
        : type === 'string'
          ? 4000
          : undefined;
    const field = {
      name,
      label: label || name,
      type,
      required: raw.required === true,
      maxLength,
    };
    if (raw.noAllOption === true) {
      field.noAllOption = true;
    }
    if (raw.scan === true) {
      if (type !== 'string' && type !== 'int' && type !== 'decimal') {
        return { ok: false, error: `参数 ${name} 的 scan 仅适用于 string / int / decimal` };
      }
      field.scan = true;
    }
    const optRes = parseFilterFieldOptionsSource(raw, field, name);
    if (!optRes.ok) {
      return { ok: false, error: optRes.error };
    }
    if (optRes.options) {
      field.options = optRes.options;
    }
    if (optRes.optionsSql) {
      field.optionsSql = optRes.optionsSql;
    }
    fields.push(field);
  }
  return { ok: true, fields };
}

/**
 * 列表结果列英文名 -> 界面表头中文（数据行 key 仍为英文列名）。
 * @param {unknown} raw
 * @returns {{ ok: true, labels: Record<string, string> } | { ok: false, error: string }}
 */
function parseColumnLabelsJson(raw) {
  let parsed;
  try {
    if (raw === undefined || raw === null || raw === '') {
      parsed = {};
    } else if (typeof raw === 'string') {
      parsed = JSON.parse(raw);
    } else {
      parsed = raw;
    }
  } catch {
    return { ok: false, error: 'columnLabels 不是合法 JSON' };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'columnLabels 须为 JSON 对象（英文列名 -> 显示标题）' };
  }
  /** @type {Record<string, string>} */
  const labels = {};
  for (const [k, v] of Object.entries(parsed)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (key.length > 256) {
      return { ok: false, error: 'columnLabels 键过长' };
    }
    const label = String(v != null ? v : '')
      .trim()
      .slice(0, 128);
    if (!label) continue;
    labels[key] = label;
  }
  return { ok: true, labels };
}

const COL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * 列名映射：键为**逻辑名**（前端/合并报工等使用的列名），值为 SQL 结果中的**原列名**。
 * 例：{"orderId":"order_id","operationId":"OpId"} 将 order_id 映为 orderId，OpId 映为 operationId。
 * @param {unknown} raw
 * @returns {{ ok: true, mapping: Record<string, string> } | { ok: false, error: string }}
 */
function parseColumnNameMappingJson(raw) {
  let parsed;
  try {
    if (raw === undefined || raw === null || raw === '') {
      parsed = {};
    } else if (typeof raw === 'string') {
      parsed = JSON.parse(raw);
    } else {
      parsed = raw;
    }
  } catch {
    return { ok: false, error: 'columnNameMapping 不是合法 JSON' };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'columnNameMapping 须为 JSON 对象（逻辑列名 -> SQL 列名）' };
  }
  /** @type {Record<string, string>} */
  const mapping = {};
  for (const [k, v] of Object.entries(parsed)) {
    const logical = String(k || '').trim();
    if (!logical) continue;
    if (logical.length > 256) {
      return { ok: false, error: 'columnNameMapping 键过长' };
    }
    if (!COL_NAME_RE.test(logical)) {
      return { ok: false, error: `columnNameMapping 含无效逻辑列名: ${logical}` };
    }
    const source = String(v != null ? v : '').trim();
    if (!source) {
      return { ok: false, error: `columnNameMapping「${logical}」须对应非空的 SQL 列名` };
    }
    if (source.length > 256) {
      return { ok: false, error: 'columnNameMapping 源列名过长' };
    }
    if (!COL_NAME_RE.test(source)) {
      return { ok: false, error: `columnNameMapping 含无效源列名: ${source}` };
    }
    mapping[logical] = source;
  }
  return { ok: true, mapping };
}

/**
 * 将列表/详情查询结果的列重命名为逻辑名，并更新 columns 与 rows。
 * @param {{ columns?: string[], rows: object[] }} result
 * @param {Record<string, string>} mapping
 */
function applyColumnNameMapping(result, mapping) {
  if (!result || !mapping || Object.keys(mapping).length === 0) return result;
  const entries = Object.entries(mapping).map(([log, src]) => [
    String(log).trim(),
    String(src).trim(),
  ]);
  if (entries.length === 0) return result;
  const rows = result.rows || [];
  const newRows = rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const o = { ...row };
    for (const [logical, source] of entries) {
      if (!Object.prototype.hasOwnProperty.call(o, source)) continue;
      o[logical] = o[source];
    }
    for (const [logical, source] of entries) {
      if (logical !== source && Object.prototype.hasOwnProperty.call(o, source)) {
        delete o[source];
      }
    }
    return o;
  });
  const newColumns = newRows.length > 0 ? Object.keys(newRows[0]) : result.columns || [];
  return { ...result, rows: newRows, columns: newColumns };
}

/**
 * 行详情 SQL：参数须包含主键参数 @detailKeyParam，其余参数须来自列表查询的 filterSchema。
 * @param {object[]} filterFields
 * @param {{ detailQueryTemplate?: string|null, detailKeyColumn?: string|null, detailKeyParam?: string|null, detailKeyType?: string|null }} cfg
 */
function validateReportDetailAttachment(filterFields, cfg) {
  const dqRaw = cfg.detailQueryTemplate != null ? String(cfg.detailQueryTemplate) : '';
  const dkcRaw = cfg.detailKeyColumn != null ? String(cfg.detailKeyColumn).trim() : '';
  const dkpRaw = cfg.detailKeyParam != null ? String(cfg.detailKeyParam).trim() : '';
  const dkp = dkpRaw || 'detailKey';
  const dktRaw = cfg.detailKeyType != null ? String(cfg.detailKeyType).trim().toLowerCase() : 'string';

  const dq = normalizeTemplate(dqRaw);
  const dkc = dkcRaw.trim();

  if (!dq && !dkc) {
    return {
      ok: true,
      detailNormalizedTemplate: null,
      detailKeyColumn: '',
      detailKeyParam: dkp,
      detailKeyType: 'string',
    };
  }
  if (dq && !dkc) {
    return {
      ok: false,
      error: '已填写行详情 SQL 时须同时填写「主键列名」（与列表结果列名一致）',
    };
  }
  if (!dq && dkc) {
    return { ok: false, error: '填写了主键列名时须同时配置行详情 SQL' };
  }

  if (!dkc || dkc.length > 256) {
    return { ok: false, error: '主键列名长度须为 1～256' };
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dkp)) {
    return {
      ok: false,
      error: '详情参数名须为字母/数字/下划线，且以字母或下划线开头',
    };
  }
  const allowedDetailTypes = new Set(['string', 'int', 'decimal', 'date', 'datetime', 'bool']);
  if (!allowedDetailTypes.has(dktRaw)) {
    return { ok: false, error: '行主键类型须为 string / int / decimal / date / datetime / bool' };
  }

  const single = validateSingleStatement(dq);
  if (!single.ok) return single;
  const dyn = validateNoDynamicExec(single.statement);
  if (!dyn.ok) return dyn;
  const kind = detectTemplateKind(single.statement);
  if (!kind) {
    return { ok: false, error: '行详情 SQL 须为 SELECT / WITH…SELECT 或 EXEC 存储过程' };
  }
  if (kind === 'select') {
    const vs = validateSelectTemplate(single.statement);
    if (!vs.ok) return vs;
  } else {
    const ve = validateExecTemplate(single.statement);
    if (!ve.ok) return ve;
  }

  const filterNames = new Set(filterFields.map((f) => f.name));
  if (filterNames.has(dkp)) {
    return {
      ok: false,
      error: `详情参数名 @${dkp} 不能与查询条件 JSON 中的参数名重复，请改用如 detailKey`,
    };
  }

  const templateParams = extractParamNames(single.statement);
  for (const name of templateParams) {
    if (name === dkp) continue;
    if (!filterNames.has(name)) {
      return {
        ok: false,
        error: `行详情 SQL 中的 @${name} 须在查询条件 JSON 中声明（主键请使用 @${dkp}）`,
      };
    }
  }
  if (!templateParams.has(dkp)) {
    return {
      ok: false,
      error: `行详情 SQL 须包含主键参数 @${dkp}（与「详情参数名」一致）`,
    };
  }

  return {
    ok: true,
    detailNormalizedTemplate: single.statement,
    detailKeyColumn: dkc,
    detailKeyParam: dkp,
    detailKeyType: dktRaw,
  };
}

/**
 * @param {{ menuKind: string, routeKey: string, queryTemplate: string|null|undefined, filterSchema: unknown, columnLabels?: unknown, columnNameMapping?: unknown, detailQueryTemplate?: string|null, detailKeyColumn?: string|null, detailKeyParam?: string|null, detailKeyType?: string|null }} cfg
 */
function validateReportMenuConfig(cfg) {
  const menuKind = String(cfg.menuKind || 'builtin').toLowerCase();
  const routeKey = String(cfg.routeKey || '')
    .trim()
    .toLowerCase();
  const qt = cfg.queryTemplate != null ? String(cfg.queryTemplate) : '';
  const fsRaw =
    cfg.filterSchema != null
      ? typeof cfg.filterSchema === 'string'
        ? cfg.filterSchema
        : JSON.stringify(cfg.filterSchema)
      : '[]';

  if (menuKind !== 'builtin' && menuKind !== 'report') {
    return { ok: false, error: 'menuKind 须为 builtin 或 report' };
  }

  if (RESERVED_ROUTE_KEYS.has(routeKey) && menuKind === 'report') {
    return { ok: false, error: '内置路由不可配置为报表类型' };
  }

  if (menuKind === 'builtin') {
    if (qt.trim()) {
      return { ok: false, error: '内置菜单不应填写 SQL 模板' };
    }
    const fs = parseFilterSchemaJson(fsRaw);
    if (!fs.ok) return fs;
    if (fs.fields.length > 0) {
      return { ok: false, error: '内置菜单不应填写查询条件 schema' };
    }
    const cl0 = parseColumnLabelsJson(cfg.columnLabels);
    if (!cl0.ok) return cl0;
    if (Object.keys(cl0.labels).length > 0) {
      return { ok: false, error: '内置菜单不应填写列标题映射' };
    }
    const cnm0 = parseColumnNameMappingJson(cfg.columnNameMapping);
    if (!cnm0.ok) return cnm0;
    if (Object.keys(cnm0.mapping).length > 0) {
      return { ok: false, error: '内置菜单不应填写列名映射' };
    }
    return { ok: true, menuKind, filterFields: [], columnLabels: {}, columnNameMapping: {} };
  }

  const template = normalizeTemplate(qt);
  if (!template) {
    return { ok: false, error: '报表菜单请填写 SQL 模板' };
  }

  const single = validateSingleStatement(template);
  if (!single.ok) return single;
  const dyn = validateNoDynamicExec(single.statement);
  if (!dyn.ok) return dyn;

  const kind = detectTemplateKind(single.statement);
  if (!kind) {
    return { ok: false, error: '模板须为 SELECT / WITH…SELECT 或 EXEC 存储过程' };
  }

  if (kind === 'select') {
    const vs = validateSelectTemplate(single.statement);
    if (!vs.ok) return vs;
  } else {
    const ve = validateExecTemplate(single.statement);
    if (!ve.ok) return ve;
  }

  const fs = parseFilterSchemaJson(fsRaw);
  if (!fs.ok) return fs;

  const templateParams = extractParamNames(single.statement);
  for (const name of templateParams) {
    const found = fs.fields.some((f) => f.name === name);
    if (!found) {
      return {
        ok: false,
        error: `SQL 中的参数 @${name} 须在 filterSchema 中声明`,
      };
    }
  }
  for (const f of fs.fields) {
    if (!templateParams.has(f.name)) {
      return {
        ok: false,
        error: `filterSchema 中的参数 ${f.name} 须在 SQL 模板中使用 @${f.name}`,
      };
    }
  }

  const detailPart = validateReportDetailAttachment(fs.fields, cfg);
  if (!detailPart.ok) return detailPart;

  const cl = parseColumnLabelsJson(cfg.columnLabels);
  if (!cl.ok) return cl;

  const cnm = parseColumnNameMappingJson(cfg.columnNameMapping);
  if (!cnm.ok) return cnm;

  return {
    ok: true,
    menuKind: 'report',
    templateKind: kind,
    normalizedTemplate: single.statement,
    filterFields: fs.fields,
    columnLabels: cl.labels,
    columnNameMapping: cnm.mapping,
    detailNormalizedTemplate: detailPart.detailNormalizedTemplate,
    detailKeyColumn: detailPart.detailKeyColumn,
    detailKeyParam: detailPart.detailKeyParam,
    detailKeyType: detailPart.detailKeyType,
  };
}

/**
 * 校验 filter 参数并绑定到 request（不含分页占位符）。
 * @param {import('mssql').Request} request
 * @param {import('mssql').ConnectionPool} pool
 * @param {object[]} schemaFields
 * @param {object} body
 * @param {{ userCode?: string, displayName?: string } | null | undefined} sessionInject
 * @param {Map<string, { name: string, code: unknown }[]>} dynamicOptsCache
 */
async function bindReportFilterParams(
  request,
  pool,
  schemaFields,
  body,
  sessionInject,
  dynamicOptsCache
) {
  const params = body && typeof body === 'object' ? body : {};
  for (const field of schemaFields) {
    const raw = params[field.name];
    const empty = raw === undefined || raw === null || raw === '';
    if (empty && field.required) {
      const err = new Error(`缺少必填参数: ${field.label || field.name}`);
      err.code = 'REPORT_PARAM_REQUIRED';
      throw err;
    }
    let val = null;
    if (!empty) {
      val = coerceValue(field, raw);
      if (val === null) {
        const err = new Error(`参数无效: ${field.label || field.name}`);
        err.code = 'REPORT_PARAM_INVALID';
        throw err;
      }
      if (field.optionsSql) {
        if (!dynamicOptsCache.has(field.name)) {
          const loaded = await loadFilterFieldOptionsItems(pool, field, sessionInject);
          dynamicOptsCache.set(field.name, loaded);
        }
        const dynItems = dynamicOptsCache.get(field.name) || [];
        const tmp = { ...field, options: dynItems, optionsSql: undefined };
        if (!isCoercedValueInFilterOptions(tmp, val)) {
          const err = new Error(`参数不在允许范围: ${field.label || field.name}`);
          err.code = 'REPORT_PARAM_INVALID';
          throw err;
        }
      } else if (!isCoercedValueInFilterOptions(field, val)) {
        const err = new Error(`参数不在允许范围: ${field.label || field.name}`);
        err.code = 'REPORT_PARAM_INVALID';
        throw err;
      }
    }
    bindInput(request, field, val);
  }
}

function bindInput(req, field, value) {
  if (value === null) {
    switch (field.type) {
      case 'string':
        req.input(field.name, sql.NVarChar(4000), null);
        break;
      case 'int':
        req.input(field.name, sql.Int, null);
        break;
      case 'decimal':
        req.input(field.name, sql.Decimal(18, 4), null);
        break;
      case 'date':
        req.input(field.name, sql.Date, null);
        break;
      case 'datetime':
        req.input(field.name, sql.DateTime2, null);
        break;
      case 'bool':
        req.input(field.name, sql.Bit, null);
        break;
      default:
        req.input(field.name, sql.NVarChar(4000), null);
    }
    return;
  }
  switch (field.type) {
    case 'string':
      req.input(field.name, sql.NVarChar(field.maxLength || 4000), value);
      break;
    case 'int':
      req.input(field.name, sql.Int, value);
      break;
    case 'decimal':
      req.input(field.name, sql.Decimal(18, 4), value);
      break;
    case 'date': {
      const d = new Date(value + (String(value).length <= 10 ? 'T00:00:00' : ''));
      req.input(field.name, sql.Date, d);
      break;
    }
    case 'datetime':
      req.input(field.name, sql.DateTime2, value instanceof Date ? value : new Date(value));
      break;
    case 'bool':
      req.input(field.name, sql.Bit, value ? 1 : 0);
      break;
    default:
      req.input(field.name, sql.NVarChar(4000), String(value));
  }
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} opts
 */
async function executeReportQuery(pool, opts) {
  const {
    templateKind,
    sqlTemplate,
    schemaFields,
    params,
    sessionInject,
    timeoutMs = getReportQueryTimeoutMs(),
    maxRows = getReportMaxRows(),
    page: pageOpt,
    pageSize: pageSizeOpt,
  } = opts;

  const body = params && typeof params === 'object' ? params : {};
  const { page, pageSize } = normalizeReportPaging(pageOpt, pageSizeOpt);
  const dynamicOptsCache = new Map();

  try {
    if (templateKind === 'select') {
      const countReq = pool.request();
      countReq.timeout = timeoutMs;
      await bindReportFilterParams(
        countReq,
        pool,
        schemaFields,
        body,
        sessionInject,
        dynamicOptsCache
      );
      bindReportSessionInjections(countReq, sqlTemplate, sessionInject);
      const countSql = `SELECT COUNT(1) AS __report_cnt FROM (${sqlTemplate}) AS __report_sub`;
      const countResult = await countReq.query(countSql);
      const cntRow = countResult.recordset && countResult.recordset[0];
      const rawCnt =
        cntRow &&
        (cntRow.__report_cnt ??
          cntRow.__report_CNT ??
          (typeof cntRow === 'object' ? Object.values(cntRow)[0] : undefined));
      let totalRowCount =
        typeof rawCnt === 'bigint' ? Number(rawCnt) : Number(rawCnt);
      if (!Number.isFinite(totalRowCount) || totalRowCount < 0) {
        totalRowCount = 0;
      }
      totalRowCount = Math.trunc(totalRowCount);

      const offset = (page - 1) * pageSize;
      const dataReq = pool.request();
      dataReq.timeout = timeoutMs;
      await bindReportFilterParams(
        dataReq,
        pool,
        schemaFields,
        body,
        sessionInject,
        dynamicOptsCache
      );
      bindReportSessionInjections(dataReq, sqlTemplate, sessionInject);
      dataReq.input('__reportOffset', sql.Int, offset);
      dataReq.input('__reportPageSize', sql.Int, pageSize);
      const dataSql = `SELECT * FROM (${sqlTemplate}) AS __report_sub
        ORDER BY (SELECT NULL)
        OFFSET @__reportOffset ROWS FETCH NEXT @__reportPageSize ROWS ONLY`;
      const result = await dataReq.query(dataSql);
      const rows = result.recordset || [];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        truncated: false,
        totalRowCount,
        page,
        pageSize,
        clientSidePaging: false,
      };
    }

    const request = pool.request();
    request.timeout = timeoutMs;
    await bindReportFilterParams(
      request,
      pool,
      schemaFields,
      body,
      sessionInject,
      dynamicOptsCache
    );
    bindReportSessionInjections(request, sqlTemplate, sessionInject);
    const result = await request.query(sqlTemplate);
    let rows =
      result.recordset && result.recordset.length
        ? result.recordset
        : (result.recordsets && result.recordsets[0]) || [];
    let truncated = false;
    if (rows.length > maxRows) {
      truncated = true;
      rows = rows.slice(0, maxRows);
    }
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const totalRowCount = rows.length;
    return {
      columns,
      rows,
      truncated,
      totalRowCount,
      page: 1,
      pageSize,
      clientSidePaging: true,
    };
  } catch (err) {
    if (
      err &&
      (err.code === 'REPORT_PARAM_REQUIRED' ||
        err.code === 'REPORT_PARAM_INVALID' ||
        err.code === 'REPORT_BAD_PAGING' ||
        err.code === 'REPORT_OPTIONS_SQL_BAD_RESULT')
    ) {
      throw err;
    }
    const msg = String(err?.message || err);
    const code = err?.code;
    if (
      code === 'ETIMEOUT' ||
      /timeout/i.test(msg) ||
      /Query timeout/i.test(msg)
    ) {
      const e = new Error('查询超时，请缩小条件或联系管理员');
      e.code = 'REPORT_QUERY_TIMEOUT';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

/**
 * 行详情查询：绑定列表筛选条件 + 主键参数后执行详情 SQL（无分页，结果条数受 REPORT_MAX_ROWS 限制）。
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} opts
 */
async function executeReportDetailQuery(pool, opts) {
  const {
    templateKind,
    sqlTemplate,
    schemaFields,
    params,
    sessionInject,
    detailKeyParam,
    detailKeyRaw,
    detailKeyType,
    timeoutMs = getReportQueryTimeoutMs(),
    maxRows = getReportMaxRows(),
  } = opts;

  const dkp = String(detailKeyParam || 'detailKey').trim() || 'detailKey';
  const dkt = String(detailKeyType || 'string').toLowerCase();
  const dkField = {
    name: dkp,
    type: dkt,
    required: true,
    label: dkp,
    maxLength: dkt === 'string' ? 4000 : undefined,
  };

  const body = params && typeof params === 'object' ? params : {};
  const empty =
    detailKeyRaw === undefined || detailKeyRaw === null || detailKeyRaw === '';
  if (empty) {
    const err = new Error('缺少行主键 detailKey');
    err.code = 'REPORT_DETAIL_KEY_MISSING';
    throw err;
  }
  const val = coerceValue(dkField, detailKeyRaw);
  if (val === null) {
    const err = new Error('行主键无效');
    err.code = 'REPORT_PARAM_INVALID';
    throw err;
  }

  const dynamicOptsCache = new Map();

  try {
    if (templateKind === 'select') {
      const dataReq = pool.request();
      dataReq.timeout = timeoutMs;
      await bindReportFilterParams(
        dataReq,
        pool,
        schemaFields,
        body,
        sessionInject,
        dynamicOptsCache
      );
      bindReportSessionInjections(dataReq, sqlTemplate, sessionInject);
      bindInput(dataReq, dkField, val);
      const cap = Math.min(Math.max(1, maxRows), 50000);
      dataReq.input('__reportDetailCap', sql.Int, cap);
      const dataSql = `SELECT TOP (@__reportDetailCap) * FROM (${sqlTemplate}) AS __report_sub`;
      const result = await dataReq.query(dataSql);
      const rows = result.recordset || [];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        truncated: false,
        totalRowCount: rows.length,
      };
    }

    const request = pool.request();
    request.timeout = timeoutMs;
    await bindReportFilterParams(
      request,
      pool,
      schemaFields,
      body,
      sessionInject,
      dynamicOptsCache
    );
    bindReportSessionInjections(request, sqlTemplate, sessionInject);
    bindInput(request, dkField, val);
    const result = await request.query(sqlTemplate);
    let rows =
      result.recordset && result.recordset.length
        ? result.recordset
        : (result.recordsets && result.recordsets[0]) || [];
    let truncated = false;
    if (rows.length > maxRows) {
      truncated = true;
      rows = rows.slice(0, maxRows);
    }
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const totalRowCount = rows.length;
    return { columns, rows, truncated, totalRowCount };
  } catch (err) {
    if (
      err &&
      (err.code === 'REPORT_PARAM_REQUIRED' ||
        err.code === 'REPORT_PARAM_INVALID' ||
        err.code === 'REPORT_DETAIL_KEY_MISSING' ||
        err.code === 'REPORT_OPTIONS_SQL_BAD_RESULT')
    ) {
      throw err;
    }
    const msg = String(err?.message || err);
    const code = err?.code;
    if (
      code === 'ETIMEOUT' ||
      /timeout/i.test(msg) ||
      /Query timeout/i.test(msg)
    ) {
      const e = new Error('查询超时，请缩小条件或联系管理员');
      e.code = 'REPORT_QUERY_TIMEOUT';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

module.exports = {
  getReportMaxRows,
  getReportMaxPageSize,
  getReportQueryTimeoutMs,
  getFilterOptionsSqlMaxRows,
  getFilterOptionsSqlTimeoutMs,
  normalizeReportPaging,
  RESERVED_ROUTE_KEYS,
  normalizeTemplate,
  detectTemplateKind,
  parseFilterSchemaJson,
  parseColumnLabelsJson,
  parseColumnNameMappingJson,
  applyColumnNameMapping,
  validateReportMenuConfig,
  extractParamNames,
  buildReportSessionInject,
  loadFilterFieldOptionsItems,
  executeReportQuery,
  executeReportDetailQuery,
};
