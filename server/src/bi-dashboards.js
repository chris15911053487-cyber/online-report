/**
 * BI 看板：bi_dashboards 的校验与增删改查，以及按用户角色裁剪。
 *
 * 看板只描述「组合与排版」：全局筛选 + 卡片；卡片引用图表库（chartKey），图表再引用查询库，看板不含 SQL 与列映射。
 * 运行时经 bi-charts.js expandDashboard() 展开为完整卡片。
 * 访问控制：看板本身不设角色，经由关联的 Agent（canUseAgent）进入；
 * 每张卡片 / 每级下钻再按其查询的 roles 过滤——用户看不到无权查询的卡片。
 */
const { sql } = require('./db');
const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');
const { canUseQuery, toPublicQuery, listAllQueries } = require('./bi-queries');
const { normalizeParamMap, checkCardRefs, expandDashboard, listAllCharts } = require('./bi-charts');

const DASHBOARD_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CARD_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FILTER_TYPES = new Set(['month', 'year', 'date', 'string', 'select']);
// 默认值支持的动态记号（前端按当天解析）
// 默认值动态记号：与服务端解析（bi-tokens.js）、前端 resolveDefaultToken 同一清单
const DEFAULT_TOKENS = new Set(require('./bi-tokens').TOKENS);
const MAX_CARDS = 40;
const MAX_FILTERS = 10;
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
    if (!FILTER_TYPES.has(type)) return fail(`筛选项「${name}」type 须为 month / year / date / string / select`);
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

/**
 * 看板里的卡片 = 对图表库的引用：{ id, chartKey, title?, params?, layout? }。
 * params 只在需要时覆盖（同名筛选会自动绑定，见 bi-charts.js resolveCard）；layout 不填用图表默认尺寸。
 */
function normalizeCardRefs(input, filters, knownCharts) {
  const arr = input == null ? [] : input;
  if (!Array.isArray(arr)) return fail('cards 须为数组');
  if (arr.length > MAX_CARDS) return fail(`卡片不能超过 ${MAX_CARDS} 张`);
  const filterNames = new Set(filters.map((f) => f.name));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (!isPlainObject(raw)) return fail(`第 ${i + 1} 张卡片须为对象`);
    const chartKey = str(raw.chartKey, 64).toLowerCase();
    if (!chartKey) return fail(`第 ${i + 1} 张卡片未选择图表`);
    if (knownCharts && !knownCharts.has(chartKey)) return fail(`第 ${i + 1} 张卡片引用了不存在的图表：「${chartKey}」`);
    let id = str(raw.id, 64);
    if (!id) {
      id = /^[a-z]/.test(chartKey) ? chartKey : `c_${chartKey}`;
      for (let n = 2; seen.has(id); n++) id = `${chartKey}_${n}`;
    }
    if (!CARD_ID_RE.test(id)) return fail(`第 ${i + 1} 张卡片 id 非法：「${id}」`);
    if (seen.has(id)) return fail(`卡片 id 重复：「${id}」`);
    seen.add(id);
    const where = `卡片「${id}」`;
    const pm = normalizeParamMap(raw.params, filterNames, where);
    if (!pm.ok) return pm;
    const ref = { id, chartKey };
    const title = str(raw.title, 64);
    if (title) ref.title = title;
    if (Object.keys(pm.value).length > 0) ref.params = pm.value;
    if (isPlainObject(raw.layout)) {
      ref.layout = {
        w: Math.min(12, Math.max(1, Math.floor(Number(raw.layout.w) || 6))),
        h: Math.min(4, Math.max(1, Math.floor(Number(raw.layout.h) || 2))),
      };
    }
    out.push(ref);
  }
  return { ok: true, value: out };
}

/**
 * 引用完整性（作用于展开后的完整卡片）：参数存在、必填参数有来源、用到的列在输出列中。
 * 返回问题列表（空 = 通过）。
 */
function checkDashboardRefs(dashboard, queriesByKey) {
  const problems = [];
  for (const card of dashboard.cards || []) {
    if (!queriesByKey.get(card.queryKey)) continue;
    problems.push(...checkCardRefs(card, queriesByKey, `卡片「${card.title}」`));
  }
  return problems;
}

/**
 * 校验输入。ctx.charts：已有图表（Set 或 Map<chartKey, 图表>，卡片引用必须存在）；
 * 同时传 Map 形式的 ctx.charts 与 ctx.queries 时，展开卡片并做引用完整性检查（checkDashboardRefs）。
 * 返回 { ok, error?, value? }
 */
function validateDashboardInput(input, ctx = {}) {
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
  const chartMap = ctx.charts instanceof Map ? ctx.charts : null;
  const knownCharts = chartMap ? new Set(chartMap.keys()) : ctx.charts instanceof Set ? ctx.charts : null;
  const cards = normalizeCardRefs(input?.cards, filters.value, knownCharts);
  if (!cards.ok) return cards;
  if (chartMap && ctx.queries instanceof Map) {
    const expanded = expandDashboard({ filters: filters.value, cards: cards.value }, chartMap, ctx.queries);
    const problems = checkDashboardRefs(expanded, ctx.queries);
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
    hiddenCards: (dashboard.missingCharts || 0) + (dashboard.cards || []).length - cards.length,
  };
}

/**
 * 读看板并把图表引用展开成完整卡片（运行时：Agent 看板、AI 查询目录都用它）。
 * 返回 { dashboard: 展开后的看板, queries: 全部查询 }；看板不存在返回 null。
 */
async function loadExpandedDashboard(pool, dashboardKey) {
  const dashboard = await getDashboard(pool, dashboardKey);
  if (!dashboard) return null;
  const [charts, queries] = await Promise.all([listAllCharts(pool), listAllQueries(pool)]);
  return { dashboard: expandDashboard(dashboard, charts, queries), queries };
}

module.exports = {
  DASHBOARD_KEY_RE,
  DEFAULT_TOKENS,
  validateDashboardInput,
  checkDashboardRefs,
  rowToDashboard,
  listAllDashboards,
  getDashboard,
  upsertDashboard,
  deleteDashboard,
  filterDashboardForRoles,
  loadExpandedDashboard,
};
