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
const { loadExpandedDashboard } = require('./bi-dashboards');
const { canUseQuery } = require('./bi-queries');

const MAX_CATALOG_QUERIES = 30;
const MAX_CATALOG_CHARS = 6000;

const ROLE_LABEL = { dimension: '维度', time: '时间', measure: '度量', attr: '属性' };
const MAX_CATALOG_SAMPLES = 3;

/** 输出列语义 → 一行：列名(中文名,角色,单位) */
function formatColumns(columns) {
  return (columns || [])
    .map((c) => {
      const tags = [c.label, ROLE_LABEL[c.role] || '', c.format === 'percent' ? '百分比' : '', c.unit || ''].filter(Boolean);
      return tags.length ? `${c.column}(${tags.join(',')})` : c.column;
    })
    .join(', ');
}

/**
 * 命名查询目录（给模型看的说明，不含 SQL）：该 Agent 看板用到的查询（卡片 + 下钻），按用户角色过滤。
 * 带上语义层：输出列（中文名 / 角色 / 单位）、口径、示例问法，让模型知道每个查询能回答什么、结果列是什么意思。
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
    const caliber = String(q.caliberNote || '').replace(/^\s*口径(说明)?\s*[:：]\s*/, '');
    const block = [];
    let line = `- \`${q.queryKey}\` ${q.label}`;
    if (q.description) line += `：${q.description}`;
    block.push(line);
    if (q.columns && q.columns.length > 0) {
      block.push(`  参数：${params || '无'}${caliber ? `；口径：${caliber}` : ''}`);
      block.push(`  输出列：${formatColumns(q.columns)}`);
    } else {
      const dims = (q.dimensions || []).map((d) => (d.label ? `${d.column}(${d.label})` : d.column)).join(', ');
      block.push(`  参数：${params || '无'}${dims ? `；维度列：${dims}` : ''}${caliber ? `；口径：${caliber}` : ''}`);
    }
    const samples = (q.sampleQuestions || []).slice(0, MAX_CATALOG_SAMPLES);
    if (samples.length > 0) block.push(`  可回答：${samples.join('；')}`);
    if ([...lines, ...block].join('\n').length > MAX_CATALOG_CHARS) {
      lines.push('- （其余查询未列出）');
      break;
    }
    lines.push(...block);
  }
  return lines.join('\n');
}

/** 看板（已展开）用到、启用且该角色组合有权访问的命名查询，按 key 排序 */
function catalogQueriesFor(loaded, userRoles) {
  if (!loaded || !loaded.dashboard.enabled) return [];
  const keys = new Set();
  for (const c of loaded.dashboard.cards || []) {
    if (c.queryKey) keys.add(c.queryKey);
    for (const d of c.drill || []) if (d.queryKey) keys.add(d.queryKey);
  }
  if (keys.size === 0) return [];
  return loaded.queries
    .filter((q) => keys.has(q.queryKey) && q.enabled && canUseQuery(userRoles, q.roles))
    .sort((a, b) => a.queryKey.localeCompare(b.queryKey));
}

/** 取 Agent 关联看板用到、且用户有权访问的命名查询 */
async function loadAgentQueryCatalog(pool, agent, userRoles) {
  if (!agent || !agent.dashboardKey) return [];
  return catalogQueriesFor(await loadExpandedDashboard(pool, agent.dashboardKey), userRoles);
}

/**
 * 配置页预览：按 Agent 的每个可见角色，给出 AI 会看到的目录、看不到的卡片 / 下钻（规则同 filterDashboardForRoles）。
 * agentRoles 为空 = 仅管理员。
 */
function previewAgentCatalog(loaded, agentRoles) {
  const roles = agentRoles && agentRoles.length > 0 ? agentRoles : ['admin'];
  const byKey = new Map((loaded?.queries || []).map((q) => [q.queryKey, q]));
  const usable = (k, r) => {
    const q = byKey.get(k);
    return !!q && q.enabled && canUseQuery([r], q.roles);
  };
  const views = roles.map((role) => {
    const queries = catalogQueriesFor(loaded, [role]);
    const hidden = [];
    for (const c of loaded?.dashboard?.cards || []) {
      if (!usable(c.queryKey, role)) {
        hidden.push({ title: c.title || c.id, queryKey: c.queryKey, reason: byKey.get(c.queryKey)?.enabled === false ? '查询已停用' : '无查询权限' });
        continue;
      }
      const lost = (c.drill || []).findIndex((d) => !usable(d.queryKey, role));
      if (lost >= 0) hidden.push({ title: `${c.title || c.id} · 第 ${lost + 1} 层下钻起`, queryKey: c.drill[lost].queryKey, reason: '无查询权限' });
    }
    return { role, queryKeys: queries.map((q) => q.queryKey), catalog: formatQueryCatalog(queries), hidden };
  });
  // 示例问法汇总（看板全部查询，去重），用于一键生成快捷提问
  const seen = new Set();
  const samples = [];
  for (const q of catalogQueriesFor(loaded, ['admin'])) {
    for (const question of q.sampleQuestions || []) {
      if (seen.has(question)) continue;
      seen.add(question);
      samples.push({ queryKey: q.queryKey, queryLabel: q.label, question });
    }
  }
  return { enabled: !!loaded?.dashboard?.enabled, views, samples };
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

module.exports = { resolveAgentContext, toAgentSkillPayload, formatQueryCatalog, previewAgentCatalog };
