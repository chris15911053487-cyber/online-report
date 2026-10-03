/**
 * 组装一次 Agent 对话所需的 skill 清单与 Agent 专属指令。
 * 被 /ai/agent/chat 路由与 agentChatCore（bot / 定时报告）共用，保证两处行为一致，
 * 且每次对话只查一次 agents 表。
 *
 * 规则（与此前两处内联实现保持一致）：
 * - 未指定 agentKey：注入用户角色可用的全部 skill；
 * - 指定 agentKey 且 Agent 存在、启用、关联了 skill：取「Agent 关联 skill ∩ 角色可用 skill」；
 * - 指定 agentKey 但 Agent 不存在 / 未启用 / 未关联 skill：skills 为空（只做一般问答）；
 * - 读取 Agent 失败：退回全部角色可用 skill，且不带专属指令；
 * - 专属指令 systemPromptExtra 只要 Agent 存在就带上。
 */
const { listSkillsForRoles } = require('./agent-skills');
const { getAgent } = require('./agents');
const { getDashboard } = require('./bi-dashboards');
const { listAllQueries, canUseQuery } = require('./bi-queries');

const MAX_CATALOG_QUERIES = 30;
const MAX_CATALOG_CHARS = 6000;

/**
 * 命名查询目录（给模型看的说明，不含 SQL）：该 Agent 看板用到的查询（卡片 + 下钻），按用户角色过滤。
 * 内容对同一 Agent + 同一角色组合逐字稳定（按 queryKey 排序），不破坏 system prompt 前缀缓存。
 */
function formatQueryCatalog(queries) {
  if (!queries || queries.length === 0) return '';
  const lines = [
    '### 可用命名查询（与看板同一口径，回答相关问题时优先用 run_named_query）',
    '',
  ];
  for (const q of queries.slice(0, MAX_CATALOG_QUERIES)) {
    const params = (q.params || [])
      .map((p) => `${p.name}:${p.type}${p.required ? '（必填）' : ''}${p.default != null ? `=${p.default}` : ''}`)
      .join(', ');
    const dims = (q.dimensions || []).map((d) => (d.label ? `${d.column}(${d.label})` : d.column)).join(', ');
    let line = `- \`${q.queryKey}\` ${q.label}`;
    if (q.description) line += `：${q.description}`;
    lines.push(line);
    lines.push(`  参数：${params || '无'}${dims ? `；维度列：${dims}` : ''}${q.caliberNote ? `；口径：${q.caliberNote}` : ''}`);
    if (lines.join('\n').length > MAX_CATALOG_CHARS) {
      lines.splice(-2, 2, '- （其余查询未列出）');
      break;
    }
  }
  return lines.join('\n');
}

/** 取 Agent 关联看板用到、且用户有权访问的命名查询 */
async function loadAgentQueryCatalog(pool, agent, userRoles) {
  if (!agent || !agent.dashboardKey) return [];
  const dashboard = await getDashboard(pool, agent.dashboardKey);
  if (!dashboard || !dashboard.enabled) return [];
  const keys = new Set();
  for (const c of dashboard.cards || []) {
    if (c.queryKey) keys.add(c.queryKey);
    for (const d of c.drill || []) if (d.queryKey) keys.add(d.queryKey);
  }
  if (keys.size === 0) return [];
  const all = await listAllQueries(pool);
  return all
    .filter((q) => keys.has(q.queryKey) && q.enabled && canUseQuery(userRoles, q.roles))
    .sort((a, b) => a.queryKey.localeCompare(b.queryKey));
}

/** skill → 传给 ai-agent 的精简结构（资源只传清单，内容由 Agent 按需读取） */
function toAgentSkillPayload(s) {
  return {
    name: s.name,
    description: s.description,
    bodyMd: s.bodyMd,
    producesDocument: s.producesDocument,
    allowedTables: s.allowedTables || [],
    resources: Object.entries(s.resources || {}).map(([p, r]) => ({
      path: p,
      size: Number(r?.size) || (typeof r?.content === 'string' ? r.content.length : 0),
    })),
  };
}

/**
 * @param {object} pool
 * @param {{ agentKey?: string|null, userRoles: string[], log?: object }} opts
 * @returns {Promise<{ skills: object[], agentPrompt: string }>}
 */
async function resolveAgentContext(pool, { agentKey, userRoles, log }) {
  let agent = null;
  let agentLoadFailed = false;
  if (agentKey) {
    try {
      agent = await getAgent(pool, agentKey);
    } catch (err) {
      agentLoadFailed = true;
      log?.warn?.({ err: err?.message }, 'resolveAgentContext: getAgent failed, using all skills');
    }
  }

  let skills = [];
  try {
    const allSkills = await listSkillsForRoles(pool, userRoles);
    if (!agentKey || agentLoadFailed) {
      skills = allSkills;
    } else if (agent && agent.enabled && agent.skills && agent.skills.length > 0) {
      const agentSkillSet = new Set(agent.skills);
      skills = allSkills.filter((s) => agentSkillSet.has(s.name));
    }
    skills = skills.map(toAgentSkillPayload);
  } catch {
    skills = [];
  }

  let agentPrompt = agent && agent.systemPromptExtra ? agent.systemPromptExtra : '';

  // 关联了看板：附上命名查询目录，追问时用同一查询复查，数字与看板一致
  if (agent && agent.enabled && agent.dashboardKey) {
    try {
      const catalog = formatQueryCatalog(await loadAgentQueryCatalog(pool, agent, userRoles));
      if (catalog) agentPrompt = agentPrompt ? `${agentPrompt}\n\n${catalog}` : catalog;
    } catch (err) {
      log?.warn?.({ err: err?.message }, 'resolveAgentContext: load query catalog failed');
    }
  }
  return { skills, agentPrompt };
}

module.exports = { resolveAgentContext, toAgentSkillPayload, formatQueryCatalog };
