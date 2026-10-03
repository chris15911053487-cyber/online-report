/**
 * BI 看板 API。
 *
 * 用户侧：
 *   - GET  /agents/:agentKey/dashboard  进入 Agent 时取其关联看板（按 Agent 门禁 + 查询角色裁剪卡片）
 *   - POST /bi/query                    卡片 / 下钻取数（命名查询 + 参数），走结果缓存
 * 管理侧（仅管理员）：
 *   - /admin/bi/queries     查询库增删改查 + 试运行（不走缓存）
 *   - /admin/bi/dashboards  看板增删改查
 */
const { getPool } = require('../db');
const { getUserRolesFromRequest, resolveUserRoles, loadKnownRoleKeys } = require('../roles');
const { getAgent, listAllAgents, canUseAgent } = require('../agents');
const {
  listAllQueries,
  getQuery,
  validateQueryInput,
  upsertQuery,
  deleteQuery,
  canUseQuery,
} = require('../bi-queries');
const { runNamedQuery, testRunQuery, BiParamError } = require('../bi-exec');
const {
  listAllDashboards,
  getDashboard,
  validateDashboardInput,
  upsertDashboard,
  deleteDashboard,
  filterDashboardForRoles,
} = require('../bi-dashboards');

/** 优先读库解析角色（改过角色无需等 JWT 过期）；失败回退 JWT 内角色 */
async function rolesOf(pool, request) {
  try {
    return await resolveUserRoles(pool, request.user?.username);
  } catch {
    return getUserRolesFromRequest(request.user);
  }
}

/** 查询执行失败：参数错误 400；SQL 错误只对管理员返回详情，避免向普通用户泄露表结构 */
function sendQueryError(request, reply, err, roles) {
  if (err instanceof BiParamError) return reply.code(400).send({ error: err.message, code: err.code });
  request.log.error({ err: err.message }, '[bi] 查询执行失败');
  const isAdmin = (roles || []).includes('admin');
  return reply.code(500).send({
    error: isAdmin ? `查询执行失败：${err.message}` : '查询执行失败，请联系管理员',
    code: 'BI_QUERY_FAILED',
  });
}

/** 查询库里被看板（卡片或下钻）引用的位置 */
function findQueryReferences(dashboards, queryKey) {
  const refs = [];
  for (const d of dashboards) {
    for (const c of d.cards || []) {
      if (c.queryKey === queryKey || (c.drill || []).some((x) => x.queryKey === queryKey)) {
        refs.push(`${d.label}/${c.title}`);
      }
    }
  }
  return refs;
}

async function biRoutes(fastify) {
  // ---------- 用户侧 ----------

  fastify.get('/agents/:agentKey/dashboard', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const pool = await getPool();
    const agent = await getAgent(pool, request.params.agentKey);
    if (!agent || !agent.enabled) return reply.code(404).send({ error: 'Agent 不存在或未启用' });
    const roles = await rolesOf(pool, request);
    if (!canUseAgent(roles, agent.roles)) return reply.code(403).send({ error: '无权使用该 Agent' });
    if (!agent.dashboardKey) return reply.code(404).send({ error: '该 Agent 未关联看板', code: 'BI_NO_DASHBOARD' });
    const dashboard = await getDashboard(pool, agent.dashboardKey);
    if (!dashboard || !dashboard.enabled) {
      return reply.code(404).send({ error: '关联的看板不存在或未启用', code: 'BI_NO_DASHBOARD' });
    }
    const queries = await listAllQueries(pool);
    return { dashboard: filterDashboardForRoles(dashboard, queries, roles) };
  });

  fastify.post('/bi/query', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body || {};
    const pool = await getPool();
    const query = await getQuery(pool, body.queryKey);
    if (!query || !query.enabled) return reply.code(404).send({ error: '查询不存在或未启用', code: 'BI_NO_QUERY' });
    const roles = await rolesOf(pool, request);
    if (!canUseQuery(roles, query.roles)) return reply.code(403).send({ error: '无权访问该数据', code: 'BI_FORBIDDEN' });
    try {
      const r = await runNamedQuery({ pool, query, params: body.params, roles, refresh: body.refresh === true });
      return {
        queryKey: query.queryKey,
        columns: r.columns,
        rows: r.rows,
        rowCount: r.rowCount,
        truncated: r.truncated,
        asOf: r.asOf,
        cached: r.cached,
        stale: r.stale,
        params: r.params,
      };
    } catch (err) {
      return sendQueryError(request, reply, err, roles);
    }
  });

  // ---------- 管理侧：查询库 ----------

  fastify.get('/admin/bi/queries', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const [items, knownRoles] = await Promise.all([listAllQueries(pool), loadKnownRoleKeys(pool)]);
    return { items, availableRoles: [...knownRoles].filter((r) => r !== 'admin').sort() };
  });

  fastify.post('/admin/bi/queries', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const parsed = validateQueryInput(request.body || {});
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const pool = await getPool();
    if (parsed.value.roles.length > 0) {
      const known = await loadKnownRoleKeys(pool);
      const bad = parsed.value.roles.filter((r) => !known.has(r));
      if (bad.length > 0) return reply.code(400).send({ error: `未定义的角色：${bad.join('、')}` });
    }
    return { query: await upsertQuery(pool, parsed.value) };
  });

  /** 试运行：用表单里（可未保存）的定义执行，最多 50 行，不走缓存 */
  fastify.post('/admin/bi/queries/test', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const body = request.body || {};
    const parsed = validateQueryInput(body.query || {});
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const pool = await getPool();
    try {
      return await testRunQuery(pool, parsed.value, body.params, 50);
    } catch (err) {
      return sendQueryError(request, reply, err, ['admin']);
    }
  });

  fastify.delete('/admin/bi/queries/:queryKey', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const key = String(request.params.queryKey || '').toLowerCase();
    const refs = findQueryReferences(await listAllDashboards(pool), key);
    if (refs.length > 0) {
      return reply.code(409).send({ error: `该查询仍被看板使用：${refs.slice(0, 5).join('、')}`, code: 'BI_QUERY_IN_USE' });
    }
    const removed = await deleteQuery(pool, key);
    if (!removed) return reply.code(404).send({ error: '查询不存在' });
    return { success: true };
  });

  // ---------- 管理侧：看板 ----------

  fastify.get('/admin/bi/dashboards', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const [items, queries, agents] = await Promise.all([listAllDashboards(pool), listAllQueries(pool), listAllAgents(pool)]);
    return {
      items: items.map((d) => ({
        ...d,
        usedByAgents: agents.filter((a) => a.dashboardKey === d.dashboardKey).map((a) => a.agentKey),
      })),
      availableQueries: queries.map((q) => ({ queryKey: q.queryKey, label: q.label, enabled: q.enabled, dimensions: q.dimensions, params: q.params })),
    };
  });

  fastify.post('/admin/bi/dashboards', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const queries = await listAllQueries(pool);
    const parsed = validateDashboardInput(request.body || {}, new Set(queries.map((q) => q.queryKey)));
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return { dashboard: await upsertDashboard(pool, parsed.value) };
  });

  fastify.delete('/admin/bi/dashboards/:dashboardKey', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const key = String(request.params.dashboardKey || '').toLowerCase();
    const agents = (await listAllAgents(pool)).filter((a) => a.dashboardKey === key);
    if (agents.length > 0) {
      return reply.code(409).send({ error: `该看板仍被 Agent 关联：${agents.map((a) => a.label).join('、')}`, code: 'BI_DASHBOARD_IN_USE' });
    }
    const removed = await deleteDashboard(pool, key);
    if (!removed) return reply.code(404).send({ error: '看板不存在' });
    return { success: true };
  });
}

module.exports = biRoutes;
module.exports.findQueryReferences = findQueryReferences;
