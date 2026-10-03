/**
 * 看板点击上下文（BI context）的服务端规范化：前端组装、网关只放行白名单字段并限长，
 * 再透传给 ai-agent（注入本轮用户消息，不进 system prompt）。
 *
 * 形状：
 * {
 *   dashboardKey, cardId, cardTitle, queryKey, queryLabel, caliberNote,
 *   path: ["应收按客户", "甲 · 单据"],          // 下钻路径（面包屑）
 *   point: { "客户": "甲", "余额": 1200000 },   // 点中元素：维度值与相关数值（标签 → 值）
 *   filters: { "期间": "2026-09" },             // 当前全局筛选（标签 → 值）
 *   params: { "period": "2026-09" },            // 该级查询的实际参数（参数名 → 值），AI 可原样复用
 *   intent: "explain" | "ask"
 * }
 */

const MAX_STR = 200;
const MAX_NOTE = 600;
const MAX_ENTRIES = 20;
const MAX_PATH = 6;
const MAX_JSON_CHARS = 4000;
const KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CARD_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const INTENTS = new Set(['explain', 'ask']);

function str(v, max = MAX_STR) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function scalar(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return str(v);
  return undefined; // 对象/数组一律丢弃
}

/** 简单键值表：键限长，值只允许标量 */
function scalarMap(input, max = MAX_ENTRIES) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    const key = str(k, 64);
    const val = scalar(v);
    if (!key || val === undefined) continue;
    out[key] = val;
    if (++n >= max) break;
  }
  return n > 0 ? out : undefined;
}

/**
 * 规范化前端传来的 context；不合法或为空返回 null（调用方按无上下文处理，不报错）。
 */
function normalizeBiContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ctx = {};
  const dashboardKey = str(raw.dashboardKey, 64).toLowerCase();
  if (KEY_RE.test(dashboardKey)) ctx.dashboardKey = dashboardKey;
  const cardId = str(raw.cardId, 64);
  if (CARD_ID_RE.test(cardId)) ctx.cardId = cardId;
  const queryKey = str(raw.queryKey, 64).toLowerCase();
  if (KEY_RE.test(queryKey)) ctx.queryKey = queryKey;
  for (const k of ['cardTitle', 'queryLabel']) {
    const v = str(raw[k]);
    if (v) ctx[k] = v;
  }
  const note = str(raw.caliberNote, MAX_NOTE);
  if (note) ctx.caliberNote = note;
  if (Array.isArray(raw.path)) {
    const path = raw.path.map((p) => str(p, 80)).filter(Boolean).slice(0, MAX_PATH);
    if (path.length) ctx.path = path;
  }
  for (const k of ['point', 'filters', 'params']) {
    const m = scalarMap(raw[k]);
    if (m) ctx[k] = m;
  }
  if (INTENTS.has(raw.intent)) ctx.intent = raw.intent;

  // 至少要知道是哪张卡片 / 哪个查询，否则没有意义
  if (!ctx.cardTitle && !ctx.queryKey) return null;

  // 总量兜底：超长时依次丢弃次要字段
  for (const k of ['params', 'filters', 'caliberNote', 'path']) {
    if (JSON.stringify(ctx).length <= MAX_JSON_CHARS) break;
    delete ctx[k];
  }
  if (JSON.stringify(ctx).length > MAX_JSON_CHARS) return null;
  return ctx;
}

/** 模型档位：目前只有 'fast'（点击解读用快模型）；其它值一律视为默认 */
function normalizeMode(raw) {
  return raw === 'fast' ? 'fast' : undefined;
}

module.exports = { normalizeBiContext, normalizeMode, MAX_JSON_CHARS };
