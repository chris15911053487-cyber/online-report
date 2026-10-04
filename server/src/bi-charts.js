/**
 * BI 图表库：bi_charts 的校验与增删改查，以及「看板引用 → 完整卡片」的展开。
 *
 * 三层：查询（数据与口径）→ 图表（怎么展示：引用一个查询 + 类型 + 列映射 + 下钻）→ 看板（筛选 + 选哪些图表 + 排版）。
 * 图表不认识任何看板：参数只能写固定值，其余由看板里**同名筛选自动提供**（大小写不敏感）；
 * 看板引用图表时可按需覆盖个别参数（$filter.xxx 或固定值）、标题与尺寸。
 * 运行时由 expandDashboard() 把引用展开成完整卡片，前端渲染、下钻、AI 上下文都只认展开后的卡片。
 */
const { sql } = require('./db');
const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');

const CHART_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLUMN_RE = /^[^\s[\]"'`;]{1,128}$/;
const CARD_TYPES = new Set(['kpi', 'bar', 'line', 'pie', 'table']);
const FORMATS = new Set(['number', 'money', 'percent', 'integer']);
const MAX_DRILL = 5;

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

// ─── 校验：参数映射 / 列映射 / 下钻（看板引用覆盖参数时也用 normalizeParamMap） ───

/**
 * 参数映射：值为简单常量，或 "$filter.xxx"（须为 filterNames 中的筛选项）。
 * filterNames 为 null 表示不在看板里（图表本身），此时不允许 $filter 引用。
 */
function normalizeParamMap(input, filterNames, where) {
  if (input == null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return fail(`${where} params 须为对象`);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!NAME_RE.test(k)) return fail(`${where} 参数名非法：「${k}」`);
    if (!isScalar(v)) return fail(`${where} 参数「${k}」须为简单值或 $filter.xxx`);
    if (typeof v === 'string' && v.startsWith('$filter.')) {
      if (!filterNames) return fail(`${where} 参数「${k}」只能写固定值；看板筛选按同名自动提供`);
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
  if (type === 'kpi' && !out.value) return fail(`${where} KPI 须设置 encoding.value`);
  if (['bar', 'line', 'pie'].includes(type)) {
    if (!out.dimension) return fail(`${where} 图表须设置 encoding.dimension`);
    if (!out.value && !(out.values && out.values.length)) return fail(`${where} 图表须设置 encoding.value 或 values`);
  }
  return { ok: true, value: out };
}

function normalizeDrill(input, knownQueries, where) {
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
    const pm = normalizeParamMap(d.params, null, w);
    if (!pm.ok) return pm;
    const type = str(d.type || 'table', 16).toLowerCase();
    if (!CARD_TYPES.has(type) || type === 'kpi') return fail(`${w} type 须为 bar / line / pie / table`);
    const enc = normalizeEncoding(d.encoding, type, w);
    if (!enc.ok) return enc;
    out.push({ queryKey, label: str(d.label || queryKey, 32), bind: outBind, params: pm.value, type, encoding: enc.value });
  }
  return { ok: true, value: out };
}

/** 按类型的默认宽度（12 栅格）：KPI 1/4；折线 / 表格整行；饼图 1/3；柱状半宽（与前端 defaultChartSize 一致） */
const DEFAULT_WIDTH = { kpi: 3, line: 12, table: 12, pie: 4, bar: 6 };

function normalizeSize(input, type) {
  const s = isPlainObject(input) ? input : {};
  const w = Math.min(12, Math.max(1, Math.floor(Number(s.w) || DEFAULT_WIDTH[type] || 6)));
  const h = type === 'kpi' ? 1 : Math.min(4, Math.max(1, Math.floor(Number(s.h) || 2)));
  return { w, h };
}

/**
 * 校验图表。knownQueries：Set 或 Map<queryKey, 查询定义>（传 Map 时还会做引用完整性检查，
 * 但不要求必填参数有来源——那由看板的同名筛选提供，保存看板时再查）。
 * 返回 { ok, error?, value? }
 */
function validateChartInput(input, knownQueries) {
  const chartKey = str(input?.chartKey, 64).toLowerCase();
  if (!CHART_KEY_RE.test(chartKey)) {
    return fail('chartKey 须为小写字母开头、仅含小写字母/数字/下划线/连字符、≤64 字符');
  }
  const label = str(input?.label, 200);
  if (!label) return fail('标题不能为空');
  if (label.length > 64) return fail('标题不能超过 64 字符');
  const subtitle = str(input?.subtitle, 128);
  const description = String(input?.description || '').trim();
  if (description.length > 1024) return fail('说明不能超过 1024 字符');
  const type = str(input?.type, 16).toLowerCase();
  if (!CARD_TYPES.has(type)) return fail(`type 须为 ${[...CARD_TYPES].join(' / ')}`);
  const byKey = knownQueries instanceof Map ? knownQueries : null;
  const known = byKey ? new Set(byKey.keys()) : knownQueries instanceof Set ? knownQueries : new Set(knownQueries || []);
  const queryKey = str(input?.queryKey, 64).toLowerCase();
  if (!known.has(queryKey)) return fail(`引用了不存在的查询：「${queryKey}」`);
  const where = '图表';
  const pm = normalizeParamMap(input?.params, null, where);
  if (!pm.ok) return pm;
  const enc = normalizeEncoding(input?.encoding, type, where);
  if (!enc.ok) return enc;
  const drill = normalizeDrill(input?.drill, known, where);
  if (!drill.ok) return drill;
  const value = {
    chartKey,
    label,
    subtitle,
    description,
    type,
    queryKey,
    params: pm.value,
    encoding: enc.value,
    drill: drill.value,
    size: normalizeSize(input?.size, type),
    enabled: input?.enabled !== false,
  };
  if (byKey) {
    const problems = checkChartRefs(value, byKey);
    if (problems.length > 0) return fail(problems.slice(0, 5).join('；'));
  }
  return { ok: true, value };
}

// ─── 引用完整性 ─────────────────────────────────────────────────────────────

/** encoding 里引用的全部列名 */
function encodingColumns(enc) {
  const cols = [];
  for (const f of ['dimension', 'value', 'compare', 'series', 'label']) if (enc[f]) cols.push(enc[f]);
  for (const v of enc.values || []) cols.push(v);
  for (const c of enc.columns || []) cols.push(c.column);
  return cols;
}

/**
 * 卡片（图表或展开后的看板卡片）与查询定义是否对得上。queriesByKey：Map<queryKey, { label, params, columns }>。
 * - params / bind 的参数名须是该查询声明的参数；
 * - requireSources：必填且无默认值的参数须有来源（卡片：params；下钻：本级 params + 各级 bind 累积）；
 * - 查询登记了输出列时：encoding 用到的列、bind 取值的列须在其中（未登记列的旧查询跳过列检查）。
 * 返回问题列表（空 = 通过）。
 */
function checkCardRefs(card, queriesByKey, where, { requireSources = true } = {}) {
  const problems = [];
  const paramNames = (q) => new Set((q.params || []).map((p) => p.name.toLowerCase()));
  const columnSet = (q) => ((q.columns || []).length > 0 ? new Set(q.columns.map((c) => c.column)) : null);
  const checkLevel = (w, q, params, encoding, provided) => {
    const names = paramNames(q);
    for (const k of Object.keys(params || {})) {
      if (!names.has(k.toLowerCase())) problems.push(`${w}：「${k}」不是查询「${q.label}」的参数`);
    }
    if (requireSources) {
      const have = new Set([...Object.keys(params || {}), ...provided].map((k) => k.toLowerCase()));
      for (const p of q.params || []) {
        if (p.required && p.default == null && !have.has(p.name.toLowerCase())) {
          problems.push(`${w}：查询「${q.label}」的必填参数「${p.label || p.name}」没有取值来源`);
        }
      }
    }
    const cols = columnSet(q);
    if (cols) {
      for (const c of encodingColumns(encoding || {})) {
        if (!cols.has(c)) problems.push(`${w}：列「${c}」不在查询「${q.label}」的输出列中`);
      }
    }
  };
  const q = queriesByKey.get(card.queryKey);
  if (!q) return [`${where}：查询「${card.queryKey}」不存在`];
  checkLevel(where, q, card.params, card.encoding, []);
  let source = q;
  const bound = [];
  (card.drill || []).forEach((d, i) => {
    const w = `${where} 第 ${i + 1} 级下钻「${d.label}」`;
    const target = queriesByKey.get(d.queryKey);
    if (!target) {
      problems.push(`${w}：查询「${d.queryKey}」不存在`);
      return;
    }
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
  return problems;
}

/** 图表自身的检查：不要求必填参数有来源（由看板同名筛选提供） */
function checkChartRefs(chart, queriesByKey) {
  return checkCardRefs(chart, queriesByKey, `图表「${chart.label}」`, { requireSources: false });
}

// ─── 展开：看板引用 + 图表 → 完整卡片 ───────────────────────────────────────

/** 查询参数里没取值的，按名称（大小写不敏感）找同名筛选，绑定为 $filter.xxx */
function autoBindFilters(paramDefs, filters, taken) {
  const byLower = new Map((filters || []).map((f) => [f.name.toLowerCase(), f.name]));
  const out = {};
  for (const p of paramDefs || []) {
    const k = p.name.toLowerCase();
    if (taken.has(k)) continue;
    const f = byLower.get(k);
    if (f) out[p.name] = `$filter.${f}`;
  }
  return out;
}

const lowerKeys = (o) => new Set(Object.keys(o || {}).map((k) => k.toLowerCase()));
const withoutKeys = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.has(k.toLowerCase())));

/**
 * 看板里的一项引用 { id, chartKey, title?, params?, layout? } + 图表定义 → 完整卡片
 * { id, chartKey, type, title, subtitle, queryKey, params, encoding, drill, layout }。
 * 参数优先级：看板覆盖 > 图表固定值 > 同名筛选自动绑定。
 * 下钻：上一级点中行的列（bind）最优先；看板覆盖同样作用于下钻里同名的参数；其后为该级固定值、同名筛选。
 */
function resolveCard(ref, chart, filters, queriesByKey) {
  const overrides = ref.params || {};
  const overrideKeys = lowerKeys(overrides);
  const fixed = withoutKeys(chart.params, overrideKeys);
  const q = queriesByKey.get(chart.queryKey);
  const taken = new Set([...overrideKeys, ...lowerKeys(fixed)]);
  const params = { ...fixed, ...autoBindFilters(q?.params, filters, taken), ...overrides };
  const bound = new Set();
  const drill = (chart.drill || []).map((d) => {
    for (const k of Object.keys(d.bind || {})) bound.add(k.toLowerCase());
    const target = queriesByKey.get(d.queryKey);
    const targetNames = new Set((target?.params || []).map((p) => p.name.toLowerCase()));
    const over = Object.fromEntries(
      Object.entries(overrides).filter(([k]) => targetNames.has(k.toLowerCase()) && !bound.has(k.toLowerCase())),
    );
    const own = withoutKeys(d.params, new Set([...lowerKeys(over), ...bound]));
    const t = new Set([...bound, ...lowerKeys(own), ...lowerKeys(over)]);
    return { ...d, params: { ...own, ...autoBindFilters(target?.params, filters, t), ...over } };
  });
  return {
    id: ref.id,
    chartKey: chart.chartKey,
    type: chart.type,
    title: ref.title || chart.label,
    subtitle: chart.subtitle || '',
    queryKey: chart.queryKey,
    params,
    encoding: chart.encoding,
    drill,
    layout: ref.layout || chart.size || normalizeSize(null, chart.type),
  };
}

/**
 * 把看板的图表引用展开成完整卡片。引用了不存在 / 已停用图表的项跳过（计入 missingCharts）。
 * charts：图表数组或 Map<chartKey, 图表>；queries：查询数组或 Map。
 */
function expandDashboard(dashboard, charts, queries) {
  const chartMap = charts instanceof Map ? charts : new Map((charts || []).map((c) => [c.chartKey, c]));
  const queryMap = queries instanceof Map ? queries : new Map((queries || []).map((q) => [q.queryKey, q]));
  const cards = [];
  let missingCharts = 0;
  for (const ref of dashboard.cards || []) {
    const chart = chartMap.get(ref.chartKey);
    if (!chart || chart.enabled === false) {
      missingCharts += 1;
      continue;
    }
    cards.push(resolveCard(ref, chart, dashboard.filters || [], queryMap));
  }
  return { ...dashboard, cards, missingCharts };
}

// ─── 增删改查 ───────────────────────────────────────────────────────────────

function rowToChart(row) {
  const type = String(row.chart_type || 'table');
  return {
    id: Number(row.id),
    chartKey: String(row.chart_key),
    label: String(row.label || ''),
    subtitle: String(row.subtitle || ''),
    description: String(row.description || ''),
    type,
    queryKey: String(row.query_key || ''),
    params: safeParseJson(row.params_json, {}),
    encoding: safeParseJson(row.encoding_json, {}),
    drill: safeParseJson(row.drill_json, []),
    size: normalizeSize(safeParseJson(row.size_json, null), type),
    enabled: !!row.enabled,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const COLS = 'id, chart_key, label, subtitle, description, chart_type, query_key, params_json, encoding_json, drill_json, size_json, enabled, updated_at';

async function listAllCharts(pool) {
  try {
    const rs = await pool.request().query(`SELECT ${COLS} FROM dbo.bi_charts ORDER BY chart_key ASC`);
    return (rs.recordset || []).map(rowToChart);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function getChart(pool, chartKey) {
  const k = str(chartKey, 64).toLowerCase();
  if (!k) return null;
  try {
    const rs = await pool.request().input('k', sql.NVarChar(64), k).query(`SELECT ${COLS} FROM dbo.bi_charts WHERE chart_key = @k`);
    const row = rs.recordset && rs.recordset[0];
    return row ? rowToChart(row) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

async function upsertChart(pool, value) {
  await pool
    .request()
    .input('chart_key', sql.NVarChar(64), value.chartKey)
    .input('label', sql.NVarChar(64), value.label)
    .input('subtitle', sql.NVarChar(128), value.subtitle)
    .input('description', sql.NVarChar(1024), value.description)
    .input('chart_type', sql.NVarChar(16), value.type)
    .input('query_key', sql.NVarChar(64), value.queryKey)
    .input('params_json', sql.NVarChar(sql.MAX), JSON.stringify(value.params))
    .input('encoding_json', sql.NVarChar(sql.MAX), JSON.stringify(value.encoding))
    .input('drill_json', sql.NVarChar(sql.MAX), JSON.stringify(value.drill))
    .input('size_json', sql.NVarChar(64), JSON.stringify(value.size))
    .input('enabled', sql.Bit, value.enabled)
    .query(`
      MERGE dbo.bi_charts AS t
      USING (SELECT @chart_key AS chart_key) AS s ON t.chart_key = s.chart_key
      WHEN MATCHED THEN UPDATE SET
        label = @label, subtitle = @subtitle, description = @description, chart_type = @chart_type,
        query_key = @query_key, params_json = @params_json, encoding_json = @encoding_json,
        drill_json = @drill_json, size_json = @size_json, enabled = @enabled, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
      WHEN NOT MATCHED THEN
        INSERT (chart_key, label, subtitle, description, chart_type, query_key, params_json, encoding_json, drill_json, size_json, enabled)
        VALUES (@chart_key, @label, @subtitle, @description, @chart_type, @query_key, @params_json, @encoding_json, @drill_json, @size_json, @enabled);
    `);
  return getChart(pool, value.chartKey);
}

async function deleteChart(pool, chartKey) {
  const rs = await pool
    .request()
    .input('k', sql.NVarChar(64), str(chartKey, 64).toLowerCase())
    .query(`DELETE FROM dbo.bi_charts WHERE chart_key = @k`);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

/** 图表是否用到某查询（主查询或任一级下钻） */
function chartUsesQuery(chart, queryKey) {
  return chart.queryKey === queryKey || (chart.drill || []).some((d) => d.queryKey === queryKey);
}

module.exports = {
  CHART_KEY_RE,
  CARD_TYPES,
  normalizeParamMap,
  normalizeEncoding,
  normalizeDrill,
  normalizeSize,
  validateChartInput,
  checkCardRefs,
  checkChartRefs,
  encodingColumns,
  resolveCard,
  expandDashboard,
  rowToChart,
  listAllCharts,
  getChart,
  upsertChart,
  deleteChart,
  chartUsesQuery,
};
