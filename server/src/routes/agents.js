/**
 * Agent 中心 API。
 *
 * - 用户侧：GET /agents（列表页）、GET /agents/:agentKey（运行页配置）
 * - 管理侧：/admin/agents CRUD（仅管理员）
 *
 * 对话仍复用 POST /ai/agent/chat（携带 agentKey），此处不提供对话接口。
 */
const { getPool } = require('../db');
const { getUserRolesFromRequest, resolveUserRoles, loadKnownRoleKeys } = require('../roles');
const { listAllSkills } = require('../agent-skills');
const {
  listAllAgents,
  listAgentsForRoles,
  getAgent,
  canUseAgent,
  validateAgentInput,
  upsertAgent,
  deleteAgent,
} = require('../agents');
const { getDashboard } = require('../bi-dashboards');

/** 用户侧只暴露展示与交互需要的字段，不下发 system_prompt_extra / skills 等内部配置 */
function toPublicAgent(agent) {
  return {
    agentKey: agent.agentKey,
    label: agent.label,
    subtitle: agent.subtitle,
    description: agent.description,
    icon: agent.icon,
    themeColor: agent.themeColor,
    welcomeMd: agent.welcomeMd,
    layoutMode: agent.layoutMode,
    quickPrompts: agent.quickPrompts,
    defaultPrompt: agent.defaultEnabled ? agent.defaultPrompt : '',
    defaultEnabled: agent.defaultEnabled,
    defaultCacheSecs: agent.defaultCacheSecs,
    // 关联了看板时，前端进入即显示看板，不再自动执行 defaultPrompt
    dashboardKey: agent.dashboardKey || '',
  };
}

async function agentsRoutes(fastify) {
  // ---------- 用户侧 ----------

  /** 当前用户可见的 agent 列表（Agent 页） */
  fastify.get('/agents', { preHandler: [fastify.authenticate] }, async (request) => {
    const pool = await getPool();
    // 优先读库解析角色，保证改过角色后无需等 JWT 过期；失败时回退 JWT 内角色
    let roles;
    try {
      roles = await resolveUserRoles(pool, request.user?.username);
    } catch {
      roles = getUserRolesFromRequest(request.user);
    }
    const items = await listAgentsForRoles(pool, roles);
    return { items: items.map(toPublicAgent) };
  });

  /** 单个 agent 的运行配置 */
  fastify.get('/agents/:agentKey', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const pool = await getPool();
    const agent = await getAgent(pool, request.params.agentKey);
    if (!agent || !agent.enabled) {
      return reply.code(404).send({ error: 'Agent 不存在或未启用' });
    }
    let roles;
    try {
      roles = await resolveUserRoles(pool, request.user?.username);
    } catch {
      roles = getUserRolesFromRequest(request.user);
    }
    if (!canUseAgent(roles, agent.roles)) {
      return reply.code(403).send({ error: '无权使用该 Agent' });
    }
    return { agent: toPublicAgent(agent) };
  });

  // ---------- 管理侧 ----------

  /** 全部 agent（含内部配置）；同时下发 skill/角色候选，供配置界面下拉使用 */
  fastify.get('/admin/agents', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const [items, skills, knownRoles] = await Promise.all([
      listAllAgents(pool),
      listAllSkills(pool),
      loadKnownRoleKeys(pool),
    ]);
    return {
      items,
      availableSkills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        roles: s.roles,
      })),
      availableRoles: [...knownRoles].filter((r) => r !== 'admin').sort(),
    };
  });

  /** 新增或更新（按 agentKey 幂等） */
  fastify.post('/admin/agents', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const parsed = validateAgentInput(request.body || {});
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const pool = await getPool();

    // 关联 skill 必须真实存在，避免配了错名字导致 Agent 静默没能力
    if (parsed.value.skills.length > 0) {
      const all = await listAllSkills(pool);
      const known = new Set(all.map((s) => s.name));
      const missing = parsed.value.skills.filter((n) => !known.has(n));
      if (missing.length > 0) {
        return reply.code(400).send({ error: `关联的 skill 不存在：${missing.join('、')}` });
      }
    }

    // 可见角色须为 app_roles 中已定义的角色；admin 无需显式配置
    if (parsed.value.roles.length > 0) {
      const known = await loadKnownRoleKeys(pool);
      const bad = parsed.value.roles.filter((r) => !known.has(r));
      if (bad.length > 0) {
        return reply.code(400).send({ error: `未定义的角色：${bad.join('、')}` });
      }
    }

    // 关联的看板必须存在
    if (parsed.value.dashboardKey) {
      const d = await getDashboard(pool, parsed.value.dashboardKey);
      if (!d) return reply.code(400).send({ error: `关联的看板不存在：${parsed.value.dashboardKey}` });
    }

    const saved = await upsertAgent(pool, parsed.value);
    return { agent: saved };
  });

  fastify.delete('/admin/agents/:agentKey', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const removed = await deleteAgent(pool, request.params.agentKey);
    if (!removed) return reply.code(404).send({ error: 'Agent 不存在' });
    return { success: true };
  });
}

module.exports = agentsRoutes;
