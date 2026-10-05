/**
 * 看板每日要点：把 Agent 关联看板的数据交给 AI 写 3~5 条要点，推送 IM 并附看板链接。
 *
 * - 取数与看板同口径：展开后的卡片 + 筛选默认值（服务端按中国日期解析）→ runNamedQuery（缓存 key 含角色）
 * - 权限：按推送对象的角色分组，每组按角色过滤看板（filterDashboardForRoles）后单独取数、单独写要点；
 *   卡片查询用了 @_loginUser 等会话变量时改为逐人取数、逐人写要点
 * - AI 只负责把已取到的数字写成要点，不再查数；数据里没有的数字不许写
 */
const { resolveToken } = require('./bi-tokens');
const { filterDashboardForRoles } = require('./bi-dashboards');
const { sessionParamsUsed } = require('./bi-queries');

const MAX_CARDS = 12;
const MAX_ROWS = 15;
const MAX_COLS = 8;
const MAX_INPUT_CHARS = 9000;

/** 筛选默认值（同前端 initialFilterValues） */
function initialFilterValues(filters, now = Date.now()) {
  const out = {};
  for (const f of filters || []) {
    let v = resolveToken(f.default, now);
    if (v == null && f.type === 'select' && f.options?.length) v = f.options[0].value;
    out[f.name] = v ?? null;
  }
  return out;
}

/** 卡片参数：'$filter.x' 取筛选值（同前端 resolveCardParams） */
function resolveCardParams(params, filterValues) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    out[k] = typeof v === 'string' && v.startsWith('$filter.') ? (filterValues[v.slice(8)] ?? null) : v;
  }
  return out;
}

/** 卡片用到的列（encoding 里出现的；都没有则取前几列） */
function cardColumns(card, resultColumns) {
  const e = card.encoding || {};
  const cols = [e.dimension, e.series, e.value, ...(e.values || []), e.compare, ...(e.columns || []).map((c) => c.column)].filter(Boolean);
  const uniq = [...new Set(cols)].filter((c) => resultColumns.includes(c));
  return (uniq.length > 0 ? uniq : resultColumns).slice(0, MAX_COLS);
}

const cell = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  return String(v).replace(/[\n,]/g, ' ').slice(0, 40);
};

/**
 * 按角色取看板数据。
 * @param {{ loaded: { dashboard, queries }, roles: string[], run: (query, params) => Promise<{columns, rows}>, now? }} args
 * @returns {Promise<{ label, filterValues, cards: { title, type, text }[] }>}
 */
async function collectDashboardData({ loaded, roles, run, now = Date.now() }) {
  const view = filterDashboardForRoles(loaded.dashboard, loaded.queries, roles);
  const byKey = new Map(loaded.queries.map((q) => [q.queryKey, q]));
  const filterValues = initialFilterValues(view.filters, now);
  const cards = [];
  for (const card of (view.cards || []).slice(0, MAX_CARDS)) {
    const query = byKey.get(card.queryKey);
    const title = card.title || query?.label || card.queryKey;
    let text;
    try {
      const r = await run(query, resolveCardParams(card.params, filterValues));
      const cols = cardColumns(card, r.columns || []);
      const sem = new Map((query?.columns || []).map((c) => [c.column, c]));
      const head = cols.map((c) => {
        const s = sem.get(c);
        const tag = [s?.label, s?.format === 'percent' ? '比例(0.12=12%)' : s?.unit].filter(Boolean).join('，');
        return tag ? `${c}(${tag})` : c;
      });
      const rows = (card.type === 'kpi' ? r.rows.slice(0, 1) : r.rows.slice(0, MAX_ROWS)).map((row) => cols.map((c) => cell(row[c])).join(','));
      const more = card.type !== 'kpi' && r.rows.length > MAX_ROWS ? `\n（共 ${r.rows.length} 行，仅列前 ${MAX_ROWS} 行）` : '';
      text = r.rows.length === 0 ? '（无数据）' : `${head.join(',')}\n${rows.join('\n')}${more}`;
    } catch (err) {
      text = `（取数失败：${String(err?.message || err).slice(0, 100)}）`;
    }
    const caliber = query?.caliberNote ? `\n口径：${String(query.caliberNote).replace(/^\s*口径(说明)?\s*[:：]\s*/, '').slice(0, 200)}` : '';
    cards.push({ title, type: card.type, text: `${text}${caliber}` });
  }
  return { label: view.label, filterValues, cards };
}

const DIGEST_SYSTEM = `你是企业经营分析助手。根据看板各卡片的数据，写今天的要点推送给管理者。
- 写 3~5 条，Markdown 无序列表，每条一句话，必须带具体数字（来自数据）
- 每张有数据的卡片至少写一条（卡片超过 5 张时挑变化最大、最值得注意的）
- 优先写：异常与显著变化（环比 / 对比列）、领先者与占比集中度、与上期的差异
- 不做没有业务意义的比较（如末位是第一名的几分之一、相差多少倍）
- 只能用给出的数据，不要编造、不要推测数据里没有的数字；某卡片取数失败或无数据就略过
- 金额超过 1 万用「万元」并保留 1~2 位小数；比例列是小数（0.12 = 12%）
- 不写空话套话，不写建议清单；只输出列表`;

function digestPrompt(data, focus) {
  const filters = Object.entries(data.filterValues).map(([k, v]) => `${k}=${v ?? ''}`).join('，');
  let body = data.cards.map((c, i) => `### ${i + 1}. ${c.title}（${c.type}）\n${c.text}`).join('\n\n');
  if (body.length > MAX_INPUT_CHARS) body = `${body.slice(0, MAX_INPUT_CHARS)}\n…（其余省略）`;
  return `看板：${data.label}${filters ? `（筛选：${filters}）` : ''}\n${focus ? `关注点：${focus}\n` : ''}\n${body}`;
}

/**
 * 写要点。llm(messages) → 文本。没有可用卡片时不调 AI。
 * @returns {Promise<string>} Markdown 列表
 */
async function writeDigest(llm, data, focus) {
  if (data.cards.length === 0) return '';
  const out = await llm([
    { role: 'system', content: DIGEST_SYSTEM },
    { role: 'user', content: digestPrompt(data, String(focus || '').trim().slice(0, 500)) },
  ]);
  return String(out || '').trim();
}

/** 推送正文：标题 + 要点 + 看板链接（PUBLIC_BASE_URL 未配置时提示在系统里打开） */
function digestMessage({ title, points, agentKey, agentLabel, baseUrl = process.env.PUBLIC_BASE_URL }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const link = base ? `[📊 打开看板](${base}/agents/${encodeURIComponent(agentKey)})` : `（在系统「Agent → ${agentLabel || agentKey}」查看看板）`;
  return `**${title}**\n\n${points || '（今天没有可写的要点：看板无数据或无权访问）'}\n\n${link}`;
}

/** 推送对象按角色集合分组：Map<'a,b', { roles, users }> */
function groupUsersByRoles(users) {
  const groups = new Map();
  for (const u of users) {
    const roles = [...new Set(u.roles || [])].sort();
    const key = roles.join(',');
    if (!groups.has(key)) groups.set(key, { roles, users: [] });
    groups.get(key).users.push(u);
  }
  return groups;
}

/** 看板卡片里有没有按登录用户取数的查询（SQL 用了 @_loginUser 等）：有则要点须逐人生成，不能按角色共用 */
function dashboardUsesSession(loaded) {
  const keys = new Set((loaded?.dashboard?.cards || []).map((c) => c.queryKey).filter(Boolean));
  return (loaded?.queries || []).some((q) => keys.has(q.queryKey) && sessionParamsUsed(q.sqlText).length > 0);
}

module.exports = {
  initialFilterValues,
  resolveCardParams,
  cardColumns,
  collectDashboardData,
  digestPrompt,
  writeDigest,
  digestMessage,
  groupUsersByRoles,
  dashboardUsesSession,
  DIGEST_SYSTEM,
};
