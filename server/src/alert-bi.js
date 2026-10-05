/**
 * 基于 BI 命名查询的预警（alert_rules.bi_check_json）。
 *
 * 规则 = 命名查询 + 参数（可用 $thisMonth 等动态值）+ 判断条件（阈值，或与上一期比的变化额 / 变化率）。
 * 运行时确定性计算，不调 AI；去重、冷却、推送、卡片模板沿用 alert-engine。
 * 「一句话设预警」只在配置时用 AI：选查询、写条件与频率、卡片模板 → 校验 → 按当前数据试算 → 人补推送对象后保存。
 *
 * bi_check_json：
 *   { queryKey, params: { period: '$thisMonth' }, match: 'all' | 'any',
 *     conditions: [{ column, op: '>'|'>='|'<'|'<='|'='|'!=', value: number, change?: 'abs'|'pct' }],
 *     compare?: { param: 'period', shift: -1, by?: ['CardCode'] }    // 有 change 条件时必填：参数往前推一期再查一次，按维度对齐
 *             | { mode: 'prevRow', orderBy?: 'Period' } }             // 或：趋势类结果（每行一个期间）与上一行比
 * 命中行会补上 {列}_prev、{列}_change、{列}_change_pct，卡片模板可直接引用。
 *
 * 事件触发规则：参数可写 '$event.字段'（如 { docEntry: '$event.DocEntry' }），事件发生时用事件数据代入；
 * 命中行合并事件字段（查询列优先），卡片模板两边的字段都能引用。
 */
const cron = require('node-cron');
const { resolveTokens, shiftPeriod, TOKENS } = require('./bi-tokens');
const { BiParamError, resolveParams, executeQuery } = require('./bi-exec');
const { getQuery } = require('./bi-queries');
const { formatQueryCatalog } = require('./agent-context');
const { parseJsonObject } = require('./bi-draft');

/** 业务代码里已接入 emitAlertEvent 的事件（名称 → 说明与字段），给管理页提示与 AI 选用 */
const KNOWN_EVENTS = {
  'pro-sign-save': { label: '合并报工保存（接单 / 完工 / 暂停 / 恢复）', fields: ['DocEntry', 'SignType', 'StepCode', 'StepName', 'UserCode', 'LineCount'] },
};

const EVENT_REF_RE = /^\$event\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;

/** 参数里的 '$event.字段' 用事件数据代入（没有事件数据时为 null） */
function resolveEventRefs(params, eventRow) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    const m = typeof v === 'string' ? EVENT_REF_RE.exec(v) : null;
    out[k] = m ? (eventRow ? (eventRow[m[1]] ?? null) : null) : v;
  }
  return out;
}

/** 规则是否引用了事件字段（只能用于事件触发） */
function usesEventRefs(check) {
  return Object.values(check?.params || {}).some((v) => typeof v === 'string' && EVENT_REF_RE.test(v));
}

const OPS = new Set(['>', '>=', '<', '<=', '=', '!=']);
const OP_TEXT = { '>': '大于', '>=': '大于等于', '<': '小于', '<=': '小于等于', '=': '等于', '!=': '不等于' };
const MAX_CONDITIONS = 5;
const MAX_ATTEMPTS = 3;
const PREVIEW_ROWS = 10;

class AlertDraftError extends Error {}

/**
 * 校验 bi_check。query 为命名查询定义（有列语义时校验列名）。
 * @returns {{ ok: true, value } | { ok: false, error }}
 */
function normalizeBiCheck(input, query) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'bi_check 须为对象' };
  const queryKey = String(input.queryKey || '').trim().toLowerCase();
  if (!queryKey) return { ok: false, error: '缺少 queryKey' };
  if (query && query.queryKey !== queryKey) return { ok: false, error: `查询不匹配：${queryKey}` };
  if (query && query.enabled === false) return { ok: false, error: `查询已停用：${queryKey}` };

  const defs = new Map((query?.params || []).map((p) => [p.name.toLowerCase(), p]));
  const params = {};
  for (const [k, v] of Object.entries(input.params && typeof input.params === 'object' ? input.params : {})) {
    const def = defs.get(k.toLowerCase());
    if (query && !def) return { ok: false, error: `查询「${queryKey}」没有参数 @${k}` };
    if (typeof v === 'string' && v.startsWith('$') && !TOKENS.includes(v) && !EVENT_REF_RE.test(v)) {
      return { ok: false, error: `参数 ${k} 的动态值「${v}」不认识，可用：${TOKENS.join(' ')}，事件规则还可用 $event.字段` };
    }
    if (v != null && v !== '') params[def ? def.name : k] = v;
  }
  for (const def of query?.params || []) {
    if (def.required && def.default == null && params[def.name] == null) {
      return { ok: false, error: `必填参数 @${def.name} 没有值（可用动态值如 $thisMonth）` };
    }
  }

  const known = query && query.columns && query.columns.length > 0 ? new Set(query.columns.map((c) => c.column)) : null;
  const rawConds = Array.isArray(input.conditions) ? input.conditions : [];
  if (rawConds.length === 0) return { ok: false, error: '至少要有一个判断条件' };
  if (rawConds.length > MAX_CONDITIONS) return { ok: false, error: `判断条件不能超过 ${MAX_CONDITIONS} 个` };
  const conditions = [];
  for (const c of rawConds) {
    const column = String(c?.column || '').trim();
    if (!column) return { ok: false, error: '条件缺少列名' };
    if (known && !known.has(column)) return { ok: false, error: `条件里的列「${column}」不在查询输出列中：${[...known].join(', ')}` };
    const op = String(c.op || '').trim();
    if (!OPS.has(op)) return { ok: false, error: `条件运算符须为 ${[...OPS].join(' ')}` };
    const value = Number(c.value);
    if (c.value === '' || c.value == null || !Number.isFinite(value)) return { ok: false, error: `条件「${column}」的比较值须为数字` };
    const cond = { column, op, value };
    if (c.change) {
      if (c.change !== 'abs' && c.change !== 'pct') return { ok: false, error: 'change 须为 abs（变化额）或 pct（变化率 %）' };
      cond.change = c.change;
    }
    conditions.push(cond);
  }

  let compare;
  if (conditions.some((c) => c.change) && input.compare?.mode === 'prevRow') {
    const orderBy = String(input.compare.orderBy || '').trim() || (query?.columns || []).find((c) => c.role === 'time')?.column || '';
    if (orderBy && known && !known.has(orderBy)) return { ok: false, error: `compare.orderBy 的列「${orderBy}」不在输出列中` };
    compare = { mode: 'prevRow', ...(orderBy ? { orderBy } : {}) };
  } else if (conditions.some((c) => c.change)) {
    const param = String(input.compare?.param || '').trim();
    const def = defs.get(param.toLowerCase());
    if (!param || (query && !def)) return { ok: false, error: '与上期比较须指定 compare.param（按哪个期间参数往前推）；趋势类查询（每行一个期间）用 {"mode":"prevRow"} 与上一行比' };
    const shift = Number(input.compare?.shift ?? -1);
    if (!Number.isInteger(shift) || shift === 0 || Math.abs(shift) > 24) return { ok: false, error: 'compare.shift 须为非零整数（-1 = 上一期）' };
    const by = (Array.isArray(input.compare?.by) ? input.compare.by : []).map((x) => String(x).trim()).filter(Boolean);
    for (const b of by) if (known && !known.has(b)) return { ok: false, error: `compare.by 的列「${b}」不在输出列中` };
    compare = { param: def ? def.name : param, shift, by };
  }
  const match = input.match === 'any' ? 'any' : 'all';
  return { ok: true, value: { queryKey, params, conditions, match, ...(compare ? { compare } : {}) } };
}

/** 对比上期时用来对齐两期行的列：显式 by > 维度 / 属性列（不含时间列） > 单行直接对齐 */
function joinColumns(check, query) {
  if (check.compare?.by?.length) return check.compare.by;
  return (query?.columns || []).filter((c) => c.role === 'dimension' || c.role === 'attr').map((c) => c.column);
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function test(op, a, b) {
  if (a == null || !Number.isFinite(a)) return false;
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '=': return a === b;
    case '!=': return a !== b;
    default: return false;
  }
}

/**
 * 评估：run(params) → Promise<{ columns, rows }>（调用方负责执行命名查询）。
 * @returns {Promise<{ matched: object[], total: number, params: object, prevParams?: object }>}
 */
async function evaluateBiCheck(check, query, run, now = Date.now(), eventRow = null) {
  if (!eventRow && usesEventRefs(check)) throw new BiParamError('条件引用了事件字段（$event.xxx），只能用于事件触发规则；试算请填示例事件数据');
  const params = resolveTokens(resolveEventRefs(check.params, eventRow), now);
  const cur = await run(params);
  let rows = (cur.rows || []).map((r) => ({ ...r }));
  let prevParams;
  const measured = [...new Set(check.conditions.filter((c) => c.change).map((c) => c.column))];
  const fillChange = (r, p) => {
    for (const col of measured) {
      const a = num(r[col]);
      const b = p ? num(p[col]) : null;
      r[`${col}_prev`] = b;
      r[`${col}_change`] = a != null && b != null ? round(a - b) : null;
      r[`${col}_change_pct`] = a != null && b != null && b !== 0 ? round(((a - b) / Math.abs(b)) * 100, 1) : null;
    }
  };
  if (check.compare?.mode === 'prevRow') {
    const ob = check.compare.orderBy;
    if (ob) rows = rows.slice().sort((x, y) => String(x[ob] ?? '').localeCompare(String(y[ob] ?? ''), 'zh', { numeric: true }));
    rows.forEach((r, i) => fillChange(r, rows[i - 1]));
  } else if (check.compare) {
    prevParams = { ...params, [check.compare.param]: shiftPeriod(params[check.compare.param], check.compare.shift) };
    if (prevParams[check.compare.param] == null) throw new BiParamError(`参数 ${check.compare.param} 的值「${params[check.compare.param]}」认不出期间格式，无法往前推`);
    const prev = await run(prevParams);
    const cols = joinColumns(check, query);
    const keyOf = (r) => cols.map((c) => String(r[c] ?? '')).join('\u0001');
    const prevMap = new Map();
    (prev.rows || []).forEach((r, i) => prevMap.set(cols.length ? keyOf(r) : String(i), r));
    rows.forEach((r, i) => fillChange(r, prevMap.get(cols.length ? keyOf(r) : String(i))));
  }
  const hit = (r) => {
    const res = check.conditions.map((c) => {
      const v = c.change === 'abs' ? r[`${c.column}_change`] : c.change === 'pct' ? r[`${c.column}_change_pct`] : num(r[c.column]);
      return test(c.op, v, c.value);
    });
    return check.match === 'any' ? res.some(Boolean) : res.every(Boolean);
  };
  return { matched: rows.filter(hit), total: rows.length, params, ...(prevParams ? { prevParams } : {}) };
}

/** 规则的中文描述（列表 / 确认页展示） */
function describeBiCheck(check, query) {
  const label = (col) => query?.columns?.find((c) => c.column === col)?.label || col;
  const paramText = Object.entries(check.params || {}).map(([k, v]) => `${k}=${v}`).join('，');
  const conds = check.conditions.map((c) => {
    const vs = check.compare?.mode === 'prevRow' ? '较上一行' : '较上期';
    const what = c.change === 'pct' ? `${label(c.column)}${vs}变化率` : c.change === 'abs' ? `${label(c.column)}${vs}变化额` : label(c.column);
    return `${what}${OP_TEXT[c.op]} ${c.value}${c.change === 'pct' ? '%' : ''}`;
  });
  return `查询「${query?.label || check.queryKey}」${paramText ? `（${paramText}）` : ''}中，${conds.join(check.match === 'any' ? ' 或 ' : ' 且 ')}的行`;
}

/** 执行命名查询（预警用：不走看板缓存，按系统身份，不做角色过滤；@_loginUser 绑定为系统用户，同 SQL 模板预警） */
function queryRunner(pool) {
  const systemUser = process.env.ALERT_SYSTEM_USER || 'SYSTEM';
  const session = { userCode: systemUser, displayName: systemUser };
  return (query, params) => executeQuery(pool, query, resolveParams(query.params, params), { session });
}

/** 引擎调用：按规则的 bi_check_json 取命中行 */
async function evaluateRuleBiCheck(pool, rule, eventRows = null) {
  let raw;
  try {
    raw = JSON.parse(rule.bi_check_json);
  } catch {
    throw new Error('bi_check_json 不是合法 JSON');
  }
  const query = await getQuery(pool, String(raw?.queryKey || '').toLowerCase());
  if (!query) throw new Error(`命名查询不存在：${raw?.queryKey}`);
  const cv = normalizeBiCheck(raw, query);
  if (!cv.ok) throw new Error(cv.error);
  const run = queryRunner(pool);
  return evaluateForEvents(cv.value, query, (p) => run(query, p), eventRows);
}

/**
 * 定时：直接评估。事件：每条事件数据代入参数评估（参数相同的只查一次），命中行合并事件字段（查询列优先）。
 */
async function evaluateForEvents(check, query, run, eventRows, now = Date.now()) {
  if (!eventRows) return (await evaluateBiCheck(check, query, run, now)).matched;
  const rows = Array.isArray(eventRows) ? eventRows : [eventRows];
  const seen = new Set();
  const out = [];
  for (const ev of rows.length ? rows : [{}]) {
    const key = JSON.stringify(resolveEventRefs(check.params, ev));
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await evaluateBiCheck(check, query, run, now, ev);
    for (const m of r.matched) out.push({ ...ev, ...m });
  }
  return out;
}

// ─── 一句话设预警（AI 只出草稿） ───────────────────────────────────────────

const DRAFT_SYSTEM = `你是企业 BI 预警配置助手。管理员用一句话描述想被提醒的情况，你从「可用命名查询」里选一条，写出预警规则。
运行时由程序执行这条查询并按条件判断，命中的行推送消息；你不能写 SQL。

## 输出（只返回 JSON）
{
  "name": "规则名称（简短）",
  "description": "一句话说明",
  "check": {
    "queryKey": "从目录中选",
    "params": {"period": "$thisMonth"},
    "conditions": [{"column": "输出列名", "op": "<", "value": 10000}],
    "match": "all",
    "compare": {"param": "period", "shift": -1}
  },
  "keyColumn": "去重列：区分不同行的列（维度编码如 CardCode；趋势类用时间列如 Period；单值类留空）",
  "trigger": "cron（定时检查）或 event（业务事件发生时检查，只能从「可用事件」里选）",
  "cron": "trigger 为 cron 时填 node-cron 表达式（5 段：分 时 日 月 周），如每天 9 点 \\"0 9 * * *\\"、工作日 8:30 \\"30 8 * * 1-5\\"、每小时 \\"0 * * * *\\"",
  "event": "trigger 为 event 时填事件名",
  "sampleEvent": "trigger 为 event 时给一份示例事件数据（字段同事件说明），用于试算",
  "cooldownMinutes": 1440,
  "cardTitle": "卡片标题，可用 {列名} 占位",
  "cardBody": "卡片正文 Markdown，每行一个要点，用 {列名} 占位",
  "notes": "需要管理员确认的假设（没有可留空）"
}

## 规则
- 参数值用动态值，不要写死日期：$today $yesterday $thisMonth $lastMonth $monthStart $yearStart $thisYear $lastYear；必填参数都要给值
- 「每次 xx 时 / xx 之后马上」这类需求用 event：参数可写 "$event.字段" 取事件数据（如 {"docEntry": "$event.DocEntry"}），卡片里也能用 {事件字段}；定时检查用 cron，不能用 $event
- 阈值条件：{"column","op","value"}，op 只能是 > >= < <= = !=，value 是数字；金额等按查询原始单位（如元），1 万 = 10000；标为「比例,1=100%」的列阈值写小数（5% → 0.05，100% → 1），卡片里比例列直接写 {列名}，不要再加 %
- 环比 / 较上期：条件加 "change": "pct"（变化率，value 写百分数，如下降超过 20% → op "<=", value -20）或 "abs"（变化额），并给 compare，二选一：
  - 结果按维度分行（每行一个客户 / 物料…）且有期间参数：{"param": "period", "shift": -1}，程序把参数往前推一期再查一次、按维度对齐（shift -12 配合月份参数 = 同比）
  - 趋势类结果（每行一个期间，如每月一行）：{"mode": "prevRow"}，按时间列排序后每行与上一行比（如每月与上个月比）
- 有 change 条件时，卡片里可用 {列名_prev}（上期值）、{列名_change}（变化额）、{列名_change_pct}（变化率 %）
- 多个条件默认都满足（match all），「或」用 any
- 冷却时间（分钟）不小于检查间隔，避免同一行反复提醒：每天检查 ≥ 1440，每周检查 ≥ 10080；会反复命中历史期间的规则（如「今年哪个月…」）给 43200（30 天）
- 卡片正文简洁，写清是谁 / 什么数 / 阈值，例如「- 客户：{CardName}\\n- 本月销售额：{Amount} 元（上月 {Amount_prev}，变化 {Amount_change_pct}%）」`;

/**
 * @param {{ llm, queries, run: (query, params) => Promise<{columns, rows}>, now? }} deps
 *   queries：可选的命名查询（含语义层）
 * @param {string} instruction 一句话
 * @returns 草稿：{ rule: { name, description, cron_expr, key_column, cooldown_minutes, card_title_template, card_body_template, bi_check }, summary, notes, preview: { matched, total, params, prevParams }, attempts }
 */
async function draftAlertRule(deps, instruction) {
  const { llm, queries, run, now = Date.now() } = deps;
  const text = String(instruction || '').trim();
  if (text.length < 4) throw new AlertDraftError('请用一句话描述什么情况下提醒，比如「本月有客户销售额比上月下降超过 30% 时，每天 9 点提醒」');
  if (text.length > 1000) throw new AlertDraftError('描述不能超过 1000 字');
  const usable = (queries || []).filter((q) => q.enabled !== false).sort((a, b) => a.queryKey.localeCompare(b.queryKey));
  if (usable.length === 0) throw new AlertDraftError('查询库里还没有可用的命名查询，请先在「BI 看板管理」里建查询');
  const byKey = new Map(usable.map((q) => [q.queryKey, q]));
  const catalog = formatQueryCatalog(usable).replace(/^### .*\n\n/, '');

  const messages = [
    { role: 'system', content: DRAFT_SYSTEM },
    {
      role: 'user',
      content: `需求：${text}\n\n可用命名查询：\n${catalog}\n\n可用事件：\n${Object.entries(KNOWN_EVENTS)
        .map(([k, e]) => `- ${k}：${e.label}；字段 ${e.fields.join(', ')}`)
        .join('\n')}`,
    },
  ];
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await llm(messages);
    messages.push({ role: 'assistant', content: reply });
    const fix = (msg) => {
      lastError = msg;
      messages.push({ role: 'user', content: `${msg}\n请修正后按同样的 JSON 格式完整返回。` });
    };
    const out = parseJsonObject(reply);
    if (!out || !out.check) {
      fix('返回内容不是要求的 JSON（需要 check 部分）。');
      continue;
    }
    const query = byKey.get(String(out.check.queryKey || '').trim().toLowerCase());
    if (!query) {
      fix(`queryKey「${out.check.queryKey}」不在可用命名查询中。`);
      continue;
    }
    const cv = normalizeBiCheck(out.check, query);
    if (!cv.ok) {
      fix(`规则校验失败：${cv.error}`);
      continue;
    }
    const isEvent = out.trigger === 'event';
    const eventName = isEvent ? String(out.event || '').trim() : '';
    const cronExpr = isEvent ? '' : String(out.cron || '').trim();
    if (isEvent) {
      const ev = KNOWN_EVENTS[eventName];
      if (!ev) {
        fix(`事件「${eventName}」不在可用事件中：${Object.keys(KNOWN_EVENTS).join('、')}。`);
        continue;
      }
      const bad = Object.values(cv.value.params)
        .map((v) => (typeof v === 'string' ? EVENT_REF_RE.exec(v)?.[1] : null))
        .filter((f) => f && !ev.fields.includes(f));
      if (bad.length) {
        fix(`事件「${eventName}」没有字段：${bad.join('、')}；可用 ${ev.fields.join(', ')}。`);
        continue;
      }
    } else if (usesEventRefs(cv.value)) {
      fix('定时规则不能用 $event.字段；要按事件触发请把 trigger 设为 event。');
      continue;
    } else if (!cron.validate(cronExpr)) {
      fix(`cron 表达式「${cronExpr}」无效，须为 5 段 node-cron 表达式。`);
      continue;
    }
    // 没给去重列时自动补（维度 / 属性列 → 时间列）：引擎无去重列时冷却不生效，会反复提醒同一行
    const keyColumn =
      String(out.keyColumn || '').trim() || joinColumns({}, query)[0] || (query.columns || []).find((c) => c.role === 'time')?.column || '';
    if (keyColumn && query.columns?.length && !query.columns.some((c) => c.column === keyColumn)) {
      fix(`去重列「${keyColumn}」不在查询输出列中。`);
      continue;
    }
    let preview;
    const sampleEvent = isEvent && out.sampleEvent && typeof out.sampleEvent === 'object' ? out.sampleEvent : null;
    try {
      const r = await evaluateBiCheck(cv.value, query, (p) => run(query, p), now, isEvent ? sampleEvent || {} : null);
      preview = { ...r, matched: r.matched.slice(0, PREVIEW_ROWS), matchedCount: r.matched.length, ...(isEvent ? { sampleEvent } : {}) };
    } catch (err) {
      fix(`按当前数据试算报错：${String(err?.message || err).slice(0, 300)}`);
      continue;
    }
    const cooldown = Math.min(Math.max(Math.round(Number(out.cooldownMinutes) || 1440), 1), 60 * 24 * 31);
    return {
      rule: {
        name: String(out.name || '').trim().slice(0, 128) || query.label,
        description: String(out.description || '').trim().slice(0, 512),
        trigger_type: isEvent ? 'event' : 'cron',
        cron_expr: cronExpr,
        event_name: eventName,
        key_column: keyColumn,
        cooldown_minutes: cooldown,
        card_title_template: String(out.cardTitle || '').trim().slice(0, 256) || `⚠️ ${query.label}`,
        card_body_template: String(out.cardBody || '').trim().slice(0, 4000),
        bi_check: cv.value,
      },
      summary: describeBiCheck(cv.value, query),
      notes: String(out.notes || '').slice(0, 1000),
      preview,
      attempts: attempt,
    };
  }
  throw new AlertDraftError(`AI 修正 ${MAX_ATTEMPTS} 次仍未成功：${lastError}`);
}

module.exports = {
  KNOWN_EVENTS,
  resolveEventRefs,
  usesEventRefs,
  evaluateForEvents,
  normalizeBiCheck,
  evaluateRuleBiCheck,
  queryRunner,
  evaluateBiCheck,
  describeBiCheck,
  draftAlertRule,
  joinColumns,
  AlertDraftError,
};
