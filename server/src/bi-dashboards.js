/**
 * BI 看板：bi_dashboards 的校验与增删改查，以及按用户角色裁剪。
 *
 * 看板只描述「展示什么」：全局筛选 + 卡片；卡片通过 queryKey 引用查询库，不含 SQL。
 * 访问控制：看板本身不设角色，经由关联的 Agent（canUseAgent）进入；
 * 每张卡片 / 每级下钻再按其查询的 roles 过滤——用户看不到无权查询的卡片。
 */
const { sql } = require('./db');
const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');
const { canUseQuery, toPublicQuery } = require('./bi-queries');

const DASHBOARD_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CARD_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLUMN_RE = /^[^\s[\]"'`;]{1,128}$/;
const CARD_TYPES = new Set(['kpi', 'bar', 'line', 'pie', 'table']);
const FILTER_TYPES = new Set(['month', 'date', 'string', 'select']);
const FORMATS = new Set(['number', 'money', 'percent', 'integer']);
// 默认值支持的动态记号（前端按当天解析）
const DEFAULT_TOKENS = new Set(['$today', '$yesterday', '$thisMonth', '$lastMonth', '$monthStart', '$yearStart']);
const MAX_CARDS = 40;
const MAX_FILTERS = 10;
const MAX_DRILL = 5;
const MAX_OPTIONS = 100;

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
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function fail(error) {
  return { ok: false, error };
}

function normalizeFilters(input) {
  const arr = input == null ? [] : input;
  if (!Array.isArray(arr)) return fail('filters 须为数组');
  if (arr.length > MAX_FILTERS) return fail(`全局筛选不能超过 ${MAX_FILTERS} 个`);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (!isPlainObject(raw)) return fail('筛选项须为对象');
    const name = str(raw.name, 64);
    if (!NAME_RE.test(name)) return fail(`筛选项 name 非法：「${name}」`);
    if (seen.has(name)) return fail(`筛选项重复：「${name}」`);
    seen.add(name);
    const type = str(raw.type || 'string', 16).toLowerCase();
    if (!FILTER_TYPES.has(type)) return fail(`筛选项「${name}」type 须为 month / date / string / select`);
    const f = { name, label: str(raw.label || name, 64), type };
    if (raw.default !== undefined && raw.default !== null && raw.default !== '') {
      if (!isScalar(raw.default)) return fail(`筛选项「${name}」默认值须为简单值`);
      if (typeof raw.default === 'string' && raw.default.startsWith('$') && !DEFAULT_TOKENS.has(raw.default)) {
        return fail(`筛选项「${name}」默认值记号不支持：${raw.default}（可用 ${[...DEFAULT_TOKENS].join(' ')}）`);
      }
      f.default = raw.default;
    }
    if (type === 'select') {
      const opts = Array.isArray(raw.options) ? raw.options : [];
      if (opts.length === 0) return fail(`筛选项「${name}」为 select 时须配置 options`);
      if (opts.length > MAX_OPTIONS) return fail(`筛选项「${name}」选项不能超过 ${MAX_OPTIONS} 个`);
      f.options = [];
      for (const o of opts) {
        const value = isPlainObject(o) ? o.value : o;
        if (!isScalar(value) || value === null) return fail(`筛选项「${name}」选项值须为简单值`);
        f.options.push({ value, label: str(isPlainObject(o) ? o.label ?? value : value, 64) });
      }
    }
    out.push(f);
  }
  return { ok: true, value: out };
}

/** 参数映射：值为 "$filter.xxx"（须为已定义的筛选项）或简单常量 */
function normalizeParamMap(input, filterNames, where) {
  if (input == null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return fail(`${where} params 须为对象`);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!NAME_RE.test(k)) return fail(`${where} 参数名非法：「${k}」`);
    if (!isScalar(v)) return fail(`${where} 参数「${k}」须为简单值或 $filter.xxx`);
    if (typeof v === 'string' && v.startsWith('$filter.')) {
      const f = v.slice('$filter.'.length);
      if (!filterNames.has(f)) return fail(`${where} 参数「${k}」引用了不存在的筛选项：${f}`);
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

function column(v, where, field) {
  if (v == null || v === '') return { ok: true, value: undefined };
  const s = String(v).trim();
  if (!COLUMN_RE.test(s)) return fail(`${where} encoding.${field} 列名非法：「${s}」`);
  return { ok: true, value: s };
}

function normalizeEncoding(input, type, where) {
  const e = isPlainObject(input) ? input : {};
  const out = {};
  for (const f of ['dimension', 'value', 'compare', 'series', 'label']) {
    const c = column(e[f], where, f);
    if (!c.ok) return c;
    if (c.value) out[f] = c.value;
  }
  if (e.values != null) {
    if (!Array.isArray(e.values) || e.values.length > 10) return fail(`${where} encoding.values 须为 ≤10 个列名的数组`);
    out.values = [];
    for (const v of e.values) {
      const c = column(v, where, 'values');
      if (!c.ok) return c;
      if (c.value) out.values.push(c.value);
    }
  }
  if (e.columns != null) {
    if (!Array.isArray(e.columns) || e.columns.length > 50) return fail(`${where} encoding.columns 须为 ≤50 项的数组`);
    out.columns = [];
    for (const c0 of e.columns) {
      const name = isPlainObject(c0) ? c0.column : c0;
      const c = column(name, where, 'columns');
      if (!c.ok) return c;
      const item = { column: c.value };
      if (isPlainObject(c0)) {
        if (c0.label) item.label = str(c0.label, 64);
        if (c0.format) {
          if (!FORMATS.has(c0.format)) return fail(`${where} 列「${c.value}」format 不支持`);
          item.format = c0.format;
        }
      }
      out.columns.push(item);
    }
  }
  if (e.format != null && e.format !== '') {
    if (!FORMATS.has(e.format)) return fail(`${where} encoding.format 须为 ${[...FORMATS].join(' / ')}`);
    out.format = e.format;
  }
  if (e.unit) out.unit = str(e.unit, 16);
  if (e.scale != null) {
    const n = Number(e.scale);
    if (!Number.isFinite(n) || n <= 0) return fail(`${where} encoding.scale 须为正数（如 10000 表示按万显示）`);
    out.scale = n;
  }
  if (e.topN != null) {
    const n = Math.floor(Number(e.topN));
    if (!Number.isFinite(n) || n < 1 || n > 500) return fail(`${where} encoding.topN 须为 1~500`);
    out.topN = n;
  }
  if (e.horizontal != null) out.horizontal = !!e.horizontal;
  // 必需字段
  if (type === 'kpi' && !out.value) return fail(`${where} KPI 卡片须设置 encoding.value`);
  if (['bar', 'line', 'pie'].includes(type)) {
    if (!out.dimension) return fail(`${where} 图表卡片须设置 encoding.dimension`);
    if (!out.value && !(out.values && out.values.length)) return fail(`${where} 图表卡片须设置 encoding.value 或 values`);
  }
  return { ok: true, value: out };
}

function normalizeDrill(input, filterNames, knownQueries, where) {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return fail(`${where} drill 须为数组`);
  if (input.length > MAX_DRILL) return fail(`${where} 下钻不能超过 ${MAX_DRILL} 级`);
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const d = input[i];
    const w = `${where} 第 ${i + 1} 级下钻`;
    if (!isPlainObject(d)) return fail(`${w} 须为对象`);
    const queryKey = str(d.queryKey, 64).toLowerCase();
    if (!knownQueries.has(queryKey)) return fail(`${w} 引用了不存在的查询：「${queryKey}」`);
    const bind = isPlainObject(d.bind) ? d.bind : {};
    const outBind = {};
    for (const [p, c] of Object.entries(bind)) {
      if (!NAME_RE.test(p)) return fail(`${w} bind 参数名非法：「${p}」`);
      const cc = String(c ?? '').trim();
      if (!COLUMN_RE.test(cc)) return fail(`${w} bind「${p}」列名非法`);
      outBind[p] = cc;
    }
    const pm = normalizeParamMap(d.params, filterNames, w);
    if (!pm.ok) return pm;
    const type = str(d.type || 'table', 16).toLowerCase();
    if (!CARD_TYPES.has(type) || type === 'kpi') return fail(`${w} type 须为 bar / line / pie / table`);
    const enc = normalizeEncoding(d.encoding, type, w);
    if (!enc.ok) return enc;
    out.push({ queryKey, label: str(d.label || queryKey, 32), bind: outBind, params: pm.value, type, encoding: enc.value });
  }
  return { ok: true, value: out };
}

function normalizeCards(input, filters, knownQueries) {
  const arr = input == null ? [] : input;
  if (!Array.isArray(arr)) return fail('cards 须为数组');
  if (arr.length > MAX_CARDS) return fail(`卡片不能超过 ${MAX_CARDS} 张`);
  const filterNames = new Set(filters.map((f) => f.name));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (!isPlainObject(raw)) return fail(`第 ${i + 1} 张卡片须为对象`);
    const id = str(raw.id, 64);
    if (!CARD_ID_RE.test(id)) return fail(`第 ${i + 1} 张卡片 id 非法：「${id}」`);
    if (seen.has(id)) return fail(`卡片 id 重复：「${id}」`);
    seen.add(id);
    const where = `卡片「${id}」`;
    const type = str(raw.type, 16).toLowerCase();
    if (!CARD_TYPES.has(type)) return fail(`${where} type 须为 ${[...CARD_TYPES].join(' / ')}`);
    const title = str(raw.title, 64);
    if (!title) return fail(`${where} 标题不能为空`);
    const queryKey = str(raw.queryKey, 64).toLowerCase();
    if (!knownQueries.has(queryKey)) return fail(`${where} 引用了不存在的查询：「${queryKey}」`);
    const pm = normalizeParamMap(raw.params, filterNames, where);
    if (!pm.ok) return pm;
    const enc = normalizeEncoding(raw.encoding, type, where);
    if (!enc.ok) return enc;
    const drill = normalizeDrill(raw.drill, filterNames, knownQueries, where);
    if (!drill.ok) return drill;
    const lay = isPlainObject(raw.layout) ? raw.layout : {};
    const w = Math.min(12, Math.max(1, Math.floor(Number(lay.w) || (type === 'kpi' ? 3 : 6))));
    const h = Math.min(4, Math.max(1, Math.floor(Number(lay.h) || (type === 'kpi' ? 1 : 2))));
    out.push({
      id,
      type,
      title,
      subtitle: str(raw.subtitle, 128),
      queryKey,
      params: pm.value,
      encoding: enc.value,
      drill: drill.value,
      layout: { w, h },
    });
  }
  return { ok: true, value: out };
}

/** encoding 里引用的全部列名 */
function encodingColumns(enc) {
  const cols = [];
  for (const f of ['dimension', 'value', 'compare', 'series', 'label']) if (enc[f]) cols.push(enc[f]);
  for (const v of enc.values || []) cols.push(v);
  for (const c of enc.columns || []) cols.push(c.column);
  return cols;
}

/**
 * 引用完整性：卡片 / 下钻与查询定义对得上。queriesByKey：Map<queryKey, { label, params, columns }>。
 * - params / bind 的参数名须是该查询声明的参数；
 * - 必填且无默认值的参数须有来源（卡片：params；下钻：本级 params + 各级 bind 累积）；
 * - 查询登记了输出列时：encoding 用到的列、bind 取值的列须在其中（未登记列的旧查询跳过列检查）。
 * 返回问题列表（空 = 通过）。
 */
function checkDashboardRefs(dashboard, queriesByKey) {
  const problems = [];
  const paramNames = (q) => new Set((q.params || []).map((p) => p.name.toLowerCase()));
  const columnSet = (q) => ((q.columns || []).length > 0 ? new Set(q.columns.map((c) => c.column)) : null);
  const checkLevel = (where, q, params, encoding, provided) => {
    const names = paramNames(q);
    for (const k of Object.keys(params || {})) {
      if (!names.has(k.toLowerCase())) problems.push(`${where}：「${k}」不是查询「${q.label}」的参数`);
    }
    const have = new Set([...Object.keys(params || {}), ...provided].map((k) => k.toLowerCase()));
    for (const p of q.params || []) {
      if (p.required && p.default == null && !have.has(p.name.toLowerCase())) {
        problems.push(`${where}：查询「${q.label}」的必填参数「${p.label || p.name}」没有取值来源`);
      }
    }
    const cols = columnSet(q);
    if (cols) {
      for (const c of encodingColumns(encoding || {})) {
        if (!cols.has(c)) problems.push(`${where}：列「${c}」不在查询「${q.label}」的输出列中`);
      }
    }
  };
  for (const card of dashboard.cards || []) {
    const q = queriesByKey.get(card.queryKey);
    if (!q) continue;
    const where = `卡片「${card.title}」`;
    checkLevel(where, q, card.params, card.encoding, []);
    let source = q;
    const bound = [];
    (card.drill || []).forEach((d, i) => {
      const target = queriesByKey.get(d.queryKey);
      if (!target) return;
      const w = `${where} 第 ${i + 1} 级下钻「${d.label}」`;
      const names = paramNames(target);
      const srcCols = columnSet(source);
      for (const [p, col] of Object.entries(d.bind || {})) {
        if (!names.has(p.toLowerCase())) problems.push(`${w}：「${p}」不是查询「${target.label}」的参数`);
        if (srcCols && !srcCols.has(col)) problems.push(`${w}：取值列「${col}」不在上一级查询「${source.label}」的输出列中`);
        bound.push(p);
      }
      checkLevel(w, target, d.params, d.encoding, bound);
      source = target;
    });
  }
  return problems;
}

/**
 * 校验输入。knownQueries：已存在的 queryKey 集合（卡片与下钻引用必须存在）；
 * 传 Map<queryKey, 查询定义> 时还会做引用完整性检查（checkDashboardRefs）。
 * 返回 { ok, error?, value? }
 */
function validateDashboardInput(input, knownQueries) {
  const dashboardKey = str(input?.dashboardKey, 64).toLowerCase();
  if (!DASHBOARD_KEY_RE.test(dashboardKey)) {
    return fail('dashboardKey 须为小写字母开头、仅含小写字母/数字/下划线/连字符、≤64 字符');
  }
  const label = str(input?.label, 200);
  if (!label) return fail('显示名称不能为空');
  if (label.length > 128) return fail('显示名称不能超过 128 字符');
  const description = String(input?.description || '').trim();
  if (description.length > 1024) return fail('说明不能超过 1024 字符');
  const filters = normalizeFilters(input?.filters);
  if (!filters.ok) return filters;
  const byKey = knownQueries instanceof Map ? knownQueries : null;
  const known = byKey ? new Set(byKey.keys()) : knownQueries instanceof Set ? knownQueries : new Set(knownQueries || []);
  const cards = normalizeCards(input?.cards, filters.value, known);
  if (!cards.ok) return cards;
  if (byKey) {
    const problems = checkDashboardRefs({ cards: cards.value }, byKey);
    if (problems.length > 0) return fail(problems.slice(0, 5).join('；'));
  }
  return {
    ok: true,
    value: {
      dashboardKey,
      label,
      description,
      filters: filters.value,
      cards: cards.value,
      enabled: input?.enabled !== false,
    },
  };
}

function rowToDashboard(row) {
  return {
    id: Number(row.id),
    dashboardKey: String(row.dashboard_key),
    label: String(row.label || ''),
    description: String(row.description || ''),
    filters: safeParseJson(row.filters_json, []),
    cards: safeParseJson(row.cards_json, []),
    enabled: !!row.enabled,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const COLS = 'id, dashboard_key, label, description, filters_json, cards_json, enabled, updated_at';

async function listAllDashboards(pool) {
  try {
    const rs = await pool.request().query(`SELECT ${COLS} FROM dbo.bi_dashboards ORDER BY dashboard_key ASC`);
    return (rs.recordset || []).map(rowToDashboard);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function getDashboard(pool, dashboardKey) {
  const k = str(dashboardKey, 64).toLowerCase();
  if (!k) return null;
  try {
    const rs = await pool
      .request()
      .input('k', sql.NVarChar(64), k)
      .query(`SELECT ${COLS} FROM dbo.bi_dashboards WHERE dashboard_key = @k`);
    const row = rs.recordset && rs.recordset[0];
    return row ? rowToDashboard(row) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

async function upsertDashboard(pool, value) {
  await pool
    .request()
    .input('dashboard_key', sql.NVarChar(64), value.dashboardKey)
    .input('label', sql.NVarChar(128), value.label)
    .input('description', sql.NVarChar(1024), value.description)
    .input('filters_json', sql.NVarChar(sql.MAX), JSON.stringify(value.filters))
    .input('cards_json', sql.NVarChar(sql.MAX), JSON.stringify(value.cards))
    .input('enabled', sql.Bit, value.enabled)
    .query(`
      MERGE dbo.bi_dashboards AS t
      USING (SELECT @dashboard_key AS dashboard_key) AS s ON t.dashboard_key = s.dashboard_key
      WHEN MATCHED THEN UPDATE SET
        label = @label, description = @description, filters_json = @filters_json,
        cards_json = @cards_json, enabled = @enabled, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
      WHEN NOT MATCHED THEN
        INSERT (dashboard_key, label, description, filters_json, cards_json, enabled)
        VALUES (@dashboard_key, @label, @description, @filters_json, @cards_json, @enabled);
    `);
  return getDashboard(pool, value.dashboardKey);
}

async function deleteDashboard(pool, dashboardKey) {
  const rs = await pool
    .request()
    .input('k', sql.NVarChar(64), str(dashboardKey, 64).toLowerCase())
    .query(`DELETE FROM dbo.bi_dashboards WHERE dashboard_key = @k`);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

/**
 * 按用户角色裁剪看板：去掉无权 / 已停用 / 已删除查询的卡片；下钻链遇到无权的一级即截断
 * （后续级依赖前一级的点击，跳级没有意义）。附带卡片所用查询的公开元数据（口径、维度、参数，不含 SQL）。
 */
function filterDashboardForRoles(dashboard, queries, roles) {
  const byKey = new Map(queries.map((q) => [q.queryKey, q]));
  const usable = (k) => {
    const q = byKey.get(k);
    return !!q && q.enabled && canUseQuery(roles, q.roles);
  };
  const used = new Set();
  const cards = [];
  for (const card of dashboard.cards || []) {
    if (!usable(card.queryKey)) continue;
    const drill = [];
    for (const d of card.drill || []) {
      if (!usable(d.queryKey)) break;
      drill.push(d);
      used.add(d.queryKey);
    }
    used.add(card.queryKey);
    cards.push({ ...card, drill });
  }
  const queryMeta = {};
  for (const k of used) queryMeta[k] = toPublicQuery(byKey.get(k));
  return {
    dashboardKey: dashboard.dashboardKey,
    label: dashboard.label,
    description: dashboard.description,
    filters: dashboard.filters || [],
    cards,
    queries: queryMeta,
    hiddenCards: (dashboard.cards || []).length - cards.length,
  };
}

module.exports = {
  DASHBOARD_KEY_RE,
  CARD_TYPES,
  DEFAULT_TOKENS,
  validateDashboardInput,
  checkDashboardRefs,
  rowToDashboard,
  listAllDashboards,
  getDashboard,
  upsertDashboard,
  deleteDashboard,
  filterDashboardForRoles,
};
