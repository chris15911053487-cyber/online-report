/**
 * AI 起草 BI 查询 + 图表：管理员说一句需求，AI 读表结构写 SQL、试运行、自我修正，返回草稿（不保存）。
 * 草稿由前端填进查询 / 图表编辑器，人确认后才保存。
 *
 * 流程：
 *   1. 选表：AI 按 SAP B1 常识 + 本库自定义业务表清单，挑出需要的表（≤ MAX_TABLES）
 *   2. 读结构：从 INFORMATION_SCHEMA 取这些表的真实列与类型，附 CUFD 中用户自定义字段的说明
 *   3. 生成：查询（SQL、参数、列语义、口径、示例问法）+ 图表（类型、列映射）
 *   4. 校验与试运行：只读校验（validateQueryInput）→ 用示例参数试运行 → 图表引用检查；
 *      任一步失败把错误交回 AI 修正，最多 MAX_ATTEMPTS 轮
 *
 * 安全：仅管理员可调；SQL 仍走只读校验与参数绑定；用户 / 权限 / 本系统配置等表不给 AI 看，SQL 引用即拒绝。
 */
const { sql } = require('./db');
const { validateQueryInput, QUERY_KEY_RE } = require('./bi-queries');
const { validateChartInput, CHART_KEY_RE } = require('./bi-charts');

const MAX_TABLES = 6;
const MAX_COLUMNS_PER_TABLE = 500;
const MAX_ATTEMPTS = 3;
const SAMPLE_ROWS = 20;
const MAX_CUSTOM_TABLES = 200;

// 不给 AI 看、SQL 也不许引用的表：SAP 用户与权限、本系统自身的配置 / 日志表
const DENY_EXACT = new Set(
  ['OUSR', 'USR1', 'USR2', 'USR3', 'USR4', 'USR5', 'USR6', 'USR7', 'OUPT', 'UPT1', 'OHPS', 'UGR1', 'OUGR', 'AUSR', 'OUBR', 'nav_menu_items', 'agents', 'X_task_logs', 'user_preferences', 'user_roles', 'app_roles', 'app_settings'].map((s) => s.toLowerCase()),
);
const DENY_PREFIX = ['@tb_ousr', '@tb_usr', 'ai_', 'agent_', 'bi_', 'bot_', 'alert_', 'message_', 'scheduled_report', 'returnpro_', 'pro_sign_'];
// SAP B1 标准表 / 视图名（OINV、INV1、B1_xxxView 等），AI 自己认识，不必列出
const SAP_STD_RE = /^([A-Z][A-Z0-9]{2,4}|B1_\w+|DOC\d_\w+|\w+_LINK)$/;

function isDeniedTable(name) {
  const n = String(name || '').replace(/[[\]]/g, '').replace(/^dbo\./i, '').toLowerCase();
  return DENY_EXACT.has(n) || DENY_PREFIX.some((p) => n.startsWith(p));
}

/** SQL 里引用了禁用表（按 FROM / JOIN 后的标识符判断） */
function referencedDeniedTables(sqlText) {
  const out = new Set();
  const re = /\b(?:FROM|JOIN)\s+((?:\[?dbo\]?\.)?(\[[^\]]+\]|[@#\w]+))/gi;
  let m;
  while ((m = re.exec(String(sqlText || '')))) {
    const name = m[2].replace(/[[\]]/g, '');
    if (isDeniedTable(name)) out.add(name);
  }
  return [...out];
}

/** 从模型输出里取 JSON 对象（容忍 ```json 包裹和前后说明文字） */
function parseJsonObject(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1));
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }
}

/** 中国本地当月 YYYY-MM / 当天 YYYY-MM-DD（示例参数兜底） */
function chinaToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const ymd = d.toISOString().slice(0, 10);
  return { ymd, ym: ymd.slice(0, 7) };
}

/** 试运行用的参数：AI 给的示例值优先，其次默认值；必填的期间 / 日期兜底为本月 / 今天 */
function sampleParamsFor(params, given) {
  const out = {};
  const { ymd, ym } = chinaToday();
  const g = given && typeof given === 'object' ? given : {};
  for (const p of params || []) {
    const hit = Object.entries(g).find(([k]) => k.toLowerCase() === p.name.toLowerCase());
    if (hit && hit[1] !== '' && hit[1] != null) out[p.name] = hit[1];
    else if (p.default != null) continue;
    else if (p.type === 'date') out[p.name] = ymd;
    else if (/period|month|ym/i.test(p.name)) out[p.name] = ym;
  }
  return out;
}

function uniqueKey(base, taken, re) {
  let k = String(base || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z]+/, '');
  if (!re.test(k)) k = `ai_${Date.now().toString(36)}`;
  k = k.slice(0, 56);
  if (!taken.has(k)) return k;
  for (let n = 2; ; n++) if (!taken.has(`${k}_${n}`)) return `${k}_${n}`;
}

// ─── 读库 ───────────────────────────────────────────────────────────────────

/** 本库的自定义业务表 / 视图（非 SAP 标准命名、非本系统表），给 AI 选表参考 */
async function listCustomTables(pool) {
  const rs = await pool.request().query(`
    SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME`);
  return (rs.recordset || [])
    .filter((r) => !SAP_STD_RE.test(r.name) && !isDeniedTable(r.name))
    .slice(0, MAX_CUSTOM_TABLES)
    .map((r) => (r.type === 'VIEW' ? `${r.name}(视图)` : r.name));
}

/** 指定表的列结构（存在的才返回）+ 用户自定义字段说明 */
async function describeTables(pool, names) {
  const wanted = [...new Set(names.map((n) => String(n).replace(/[[\]]/g, '').replace(/^dbo\./i, '').trim()).filter(Boolean))]
    .filter((n) => !isDeniedTable(n))
    .slice(0, MAX_TABLES);
  if (wanted.length === 0) return [];
  const req = pool.request();
  const ph = wanted.map((n, i) => {
    req.input(`t${i}`, sql.NVarChar(128), n);
    return `@t${i}`;
  });
  const rs = await req.query(`
    SELECT c.TABLE_NAME AS tbl, c.COLUMN_NAME AS col, c.DATA_TYPE AS type, c.ORDINAL_POSITION AS pos
    FROM INFORMATION_SCHEMA.COLUMNS c
    WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME IN (${ph.join(', ')})
    ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);
  // 用户自定义字段说明（SAP B1 的 CUFD；不存在则忽略）
  const udf = new Map();
  try {
    const r2 = pool.request();
    const ph2 = wanted.map((n, i) => {
      r2.input(`u${i}`, sql.NVarChar(128), n);
      return `@u${i}`;
    });
    const u = await r2.query(`SELECT TableID AS tbl, 'U_' + AliasID AS col, Descr AS descr FROM CUFD WHERE TableID IN (${ph2.join(', ')})`);
    for (const row of u.recordset || []) udf.set(`${row.tbl}.${row.col}`, row.descr);
  } catch {
    /* 非 SAP 库 */
  }
  const byTable = new Map();
  for (const r of rs.recordset || []) {
    if (!byTable.has(r.tbl)) byTable.set(r.tbl, []);
    const list = byTable.get(r.tbl);
    if (list.length < MAX_COLUMNS_PER_TABLE) {
      const d = udf.get(`${r.tbl}.${r.col}`);
      list.push(d ? `${r.col}:${r.type}(${d})` : `${r.col}:${r.type}`);
    }
  }
  return [...byTable.entries()].map(([table, columns]) => ({ table, columns }));
}

// ─── 提示词 ─────────────────────────────────────────────────────────────────

const PICK_SYSTEM = `你是 SAP Business One（SQL Server）数据专家。根据用户的报表需求，挑出写 SQL 需要的表。
可以用 SAP B1 标准表（如 OINV/INV1 销售发票、ORIN 贷项、ORDR/RDR1 销售订单、ODLN 交货、OCRD 业务伙伴、OITM 物料、OSLP 销售员、OWOR 生产订单、OPCH 采购发票、OJDT/JDT1 日记账、OITW 仓库库存 等），也可以用下面列出的本库自定义表。
只返回 JSON：{"tables": ["OINV", "OCRD"], "reason": "一句话"}，最多 ${MAX_TABLES} 张表。`;

const GEN_SYSTEM = `你是 SAP Business One（SQL Server）BI 建模专家。根据需求与真实表结构，写一条「命名查询」和一张展示它的「图表」。

## SQL 规则（必须遵守）
- 只能是一条 SELECT 或 WITH ... SELECT；禁止 DECLARE / SET / INSERT / UPDATE / DELETE / EXEC / INTO / 临时表 / 多语句 / GO
- 只用给出的表与列；参数一律写 @name（如 @period），不要拼接常量；不要用 @@ 系统变量
- 期间参数用字符串 'YYYY-MM'，例如 CONVERT(char(7), T0.DocDate, 120) = @period；日期参数类型 date
- 排除已取消单据（CANCELED = 'N'）；金额按本币（DocTotal / LineTotal 等），说明里写清口径
- 输出列别名用英文字母开头、无空格（如 CardName、Amount、Qty），中文名写在 columns 的 label 里
- Top N 用 TOP (@top) 并给 top 参数默认值；结果行数通常 ≤ 200
- 期间 / 年份 / 日期参数不要写死默认值（会过时），设为必填，由看板筛选提供；示例值写在 sampleParams

## 列语义 columns
每个输出列一项：{"column": 别名, "label": 中文名, "role": "dimension|measure|time|attr", "format": "money|number|integer|percent"(度量才填), "unit": 可选, "scale": 可选(10000 = 按万显示)}
- dimension：可分组的名称（客户名、物料名）；time：日期 / 期间；measure：可汇总的数值；attr：编码等其它

## 图表 chart
- type：kpi（单个数）/ bar / line（时间趋势）/ pie（占比，类别 ≤ 8）/ table
- encoding：kpi 用 {"value": 度量列}；bar/line/pie 用 {"dimension": 维度列, "value": 度量列}，可加 "horizontal": true（横向条形，适合排名）、"topN"
- 列名必须是 SQL 的输出列别名
- params 只写固定值（一般留空 {}）；@period 等参数由看板上的同名筛选提供

## 输出（只返回 JSON，不要其它文字）
{
  "query": {
    "queryKey": "小写英文_下划线，如 sales_by_customer",
    "label": "中文名称",
    "description": "这条查询回答什么问题",
    "sqlText": "SELECT ...",
    "params": [{"name": "period", "type": "string|number|date|bool", "label": "期间", "required": true, "default": null}],
    "columns": [...],
    "caliberNote": "口径说明：取数范围、时间字段、是否含税、排除了什么",
    "sampleQuestions": ["用户可能怎么问，3~5 条"]
  },
  "sampleParams": {"period": "2026-08"},
  "chart": {"chartKey": "小写英文", "label": "图表标题", "type": "bar", "params": {}, "encoding": {...}},
  "notes": "给管理员的说明：做了哪些假设，需要确认什么"
}`;

// ─── 主流程 ─────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 *   - pool：mssql 连接池
 *   - llm(messages) → Promise<string>：调用模型，返回文本
 *   - existingQueries / existingCharts：已有定义（避免 key 冲突、提示可复用）
 *   - testRun(query, params) → Promise<{ columns, columnTypes, rows, rowCount }>
 *   - onProgress?(stage)：进度回调
 * @param {string} requirement 需求描述
 */
async function draftQueryAndChart(deps, requirement) {
  const { pool, llm, existingQueries = [], existingCharts = [], testRun, onProgress = () => {} } = deps;
  const need = String(requirement || '').trim();
  if (need.length < 4) throw new DraftError('请用一句话描述想看什么，比如「本月各客户销售额前 10」');
  if (need.length > 1000) throw new DraftError('需求描述不能超过 1000 字');

  // 1. 选表
  onProgress('选表');
  const custom = await listCustomTables(pool);
  const pickText = await llm([
    { role: 'system', content: PICK_SYSTEM },
    { role: 'user', content: `需求：${need}\n\n本库自定义表 / 视图：${custom.join('、') || '（无）'}` },
  ]);
  const pick = parseJsonObject(pickText);
  const tables = Array.isArray(pick?.tables) ? pick.tables.map(String) : [];
  if (tables.length === 0) throw new DraftError('AI 没有选出需要的表，请把需求说具体些（看什么数、按什么分）');

  // 2. 读结构
  onProgress('读表结构');
  const schema = await describeTables(pool, tables);
  if (schema.length === 0) throw new DraftError(`AI 选的表在库里都不存在或不允许使用：${tables.join('、')}`);
  const schemaText = schema.map((t) => `### ${t.table}\n${t.columns.join(', ')}`).join('\n\n');
  const existing = existingQueries.slice(0, 50).map((q) => `${q.queryKey}（${q.label}）`).join('、') || '（无）';

  // 3~4. 生成 → 校验 → 试运行 → 修正
  const messages = [
    { role: 'system', content: GEN_SYSTEM },
    { role: 'user', content: `需求：${need}\n\n已有命名查询（不要重复 queryKey）：${existing}\n\n可用表结构（列:类型(自定义字段说明)）：\n${schemaText}` },
  ];
  const queryKeys = new Set(existingQueries.map((q) => q.queryKey));
  const chartKeys = new Set(existingCharts.map((c) => c.chartKey));
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onProgress(attempt === 1 ? '生成查询与图表' : `第 ${attempt} 次修正`);
    const text = await llm(messages);
    messages.push({ role: 'assistant', content: text });
    const out = parseJsonObject(text);
    const fix = (msg) => {
      lastError = msg;
      messages.push({ role: 'user', content: `${msg}\n请修正后按同样的 JSON 格式完整返回。` });
    };
    if (!out || !out.query || !out.chart) {
      fix('返回内容不是要求的 JSON（需要 query、chart 两部分）。');
      continue;
    }
    const q = { ...out.query, queryKey: uniqueKey(out.query.queryKey, queryKeys, QUERY_KEY_RE), roles: [], cacheSecs: 300, enabled: true };
    const qv = validateQueryInput(q);
    if (!qv.ok) {
      fix(`查询校验失败：${qv.error}`);
      continue;
    }
    const denied = referencedDeniedTables(qv.value.sqlText);
    if (denied.length > 0) {
      fix(`不允许使用这些表：${denied.join('、')}。`);
      continue;
    }
    const sampleParams = sampleParamsFor(qv.value.params, out.sampleParams);
    let result;
    try {
      onProgress('试运行');
      result = await testRun(qv.value, sampleParams);
    } catch (err) {
      fix(`SQL 试运行报错：${String(err?.message || err).slice(0, 500)}（示例参数：${JSON.stringify(sampleParams)}）`);
      continue;
    }
    // 列语义以试运行的实际输出列为准：AI 标注过的保留，缺的补上
    const given = new Map((qv.value.columns || []).map((c) => [c.column, c]));
    const missing = result.columns.filter((c) => !given.has(c));
    const columns = result.columns.map((c) => given.get(c) || { column: c, label: '', role: 'attr' });
    const query = { ...qv.value, columns };
    const chartInput = { ...out.chart, chartKey: uniqueKey(out.chart.chartKey || query.queryKey, chartKeys, CHART_KEY_RE), queryKey: query.queryKey, drill: [] };
    const cv = validateChartInput(chartInput, new Map([[query.queryKey, query]]));
    if (!cv.ok) {
      fix(`图表配置有误：${cv.error}。SQL 的实际输出列为：${result.columns.join(', ')}。`);
      continue;
    }
    return {
      query,
      chart: cv.value,
      sample: { columns: result.columns, columnTypes: result.columnTypes || {}, rows: (result.rows || []).slice(0, SAMPLE_ROWS), rowCount: result.rowCount ?? (result.rows || []).length },
      sampleParams,
      notes: String(out.notes || '').slice(0, 1000),
      unlabeledColumns: missing,
      tables: schema.map((t) => t.table),
      attempts: attempt,
    };
  }
  throw new DraftError(`AI 修正 ${MAX_ATTEMPTS} 次仍未成功：${lastError}`);
}

class DraftError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BI_DRAFT_FAILED';
  }
}

module.exports = {
  draftQueryAndChart,
  DraftError,
  isDeniedTable,
  referencedDeniedTables,
  parseJsonObject,
  sampleParamsFor,
  uniqueKey,
  describeTables,
  listCustomTables,
};
