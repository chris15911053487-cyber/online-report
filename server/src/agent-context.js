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

  const agentPrompt = agent && agent.systemPromptExtra ? agent.systemPromptExtra : '';
  return { skills, agentPrompt };
}

module.exports = { resolveAgentContext, toAgentSkillPayload };
