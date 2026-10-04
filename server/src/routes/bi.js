/**
 * BI 看板 API。
 *
 * 用户侧：
 *   - GET  /agents/:agentKey/dashboard  进入 Agent 时取其关联看板（按 Agent 门禁 + 查询角色裁剪卡片）
 *   - POST /bi/query                    卡片 / 下钻取数（命名查询 + 参数），走结果缓存
 * 管理侧（仅管理员）：
 *   - /admin/bi/queries     查询库增删改查 + 试运行（不走缓存）
 *   - /admin/bi/charts      图表库增删改查（图表引用查询；看板引用图表）
 *   - /admin/bi/dashboards  看板增删改查
 *   - POST /admin/bi/ai/draft         AI 起草查询 + 1~3 张图表（读表结构、试运行、自我修正）
 *   - POST /admin/bi/ai/draft-from-sql 对话里 Agent 临时写的 SQL → 参数化成命名查询 + 推荐图表（收藏到看板）
 *   - POST /admin/bi/ai/revise-query  按一句话修改查询（改 SQL 后试运行、自我修正）
 *   - POST /admin/bi/ai/enrich-query  补全语义层（列中文名 / 角色 / 格式、说明、口径、示例问法）
 *   以上 AI 接口都只返回草稿，不保存
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
  toPublicQuery,
} = require('../bi-queries');
const { runNamedQuery, testRunQuery, BiParamError } = require('../bi-exec');
const { draftQueryAndChart, draftFromSql, reviseQuery, enrichQuery, DraftError } = require('../bi-draft');
const { aiService } = require('../ai');
const {
  listAllDashboards,
  validateDashboardInput,
  checkDashboardRefs,
  upsertDashboard,
  deleteDashboard,
  filterDashboardForRoles,
  loadExpandedDashboard,
} = require('../bi-dashboards');
const {
  listAllCharts,
  validateChartInput,
  checkChartRefs,
  upsertChart,
  deleteChart,
  chartUsesQuery,
  expandDashboard,
} = require('../bi-charts');

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

/** 用到某查询的图表（主查询或下钻） */
function findQueryReferences(charts, queryKey) {
  return charts.filter((c) => chartUsesQuery(c, queryKey)).map((c) => c.label);
}

/** 引用某图表的看板 */
function dashboardsUsingChart(dashboards, chartKey) {
  return dashboards.filter((d) => (d.cards || []).some((c) => c.chartKey === chartKey));
}

/**
 * 影响分析：改了查询 / 图表后，引用它们的图表与看板是否还对得上（只提示，不阻止保存）。
 * changedCharts：受影响的图表 key 集合。
 */
async function impactWarnings(pool, changedCharts) {
  if (changedCharts.size === 0) return [];
  const [charts, queries, dashboards] = await Promise.all([listAllCharts(pool), listAllQueries(pool), listAllDashboards(pool)]);
  const queryMap = new Map(queries.map((q) => [q.queryKey, q]));
  const warnings = [];
  for (const c of charts) if (changedCharts.has(c.chartKey)) warnings.push(...checkChartRefs(c, queryMap));
  for (const d of dashboards) {
    if (!(d.cards || []).some((c) => changedCharts.has(c.chartKey))) continue;
    const expanded = expandDashboard(d, charts, queryMap);
    const own = { cards: expanded.cards.filter((c) => changedCharts.has(c.chartKey)) };
    for (const p of checkDashboardRefs(own, queryMap)) warnings.push(`看板「${d.label}」${p}`);
  }
  return [...new Set(warnings)].slice(0, 20);
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
    const loaded = await loadExpandedDashboard(pool, agent.dashboardKey);
    if (!loaded || !loaded.dashboard.enabled) {
      return reply.code(404).send({ error: '关联的看板不存在或未启用', code: 'BI_NO_DASHBOARD' });
    }
    return { dashboard: filterDashboardForRoles(loaded.dashboard, loaded.queries, roles) };
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
    const saved = await upsertQuery(pool, parsed.value);
    // 影响分析：改了参数 / 输出列后，用到它的图表、引用这些图表的看板是否还对得上
    const using = (await listAllCharts(pool)).filter((c) => chartUsesQuery(c, saved.queryKey));
    const warnings = await impactWarnings(pool, new Set(using.map((c) => c.chartKey)));
    return { query: saved, warnings };
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
    const refs = findQueryReferences(await listAllCharts(pool), key);
    if (refs.length > 0) {
      return reply.code(409).send({ error: `该查询仍被图表使用：${refs.slice(0, 5).join('、')}`, code: 'BI_QUERY_IN_USE' });
    }
    const removed = await deleteQuery(pool, key);
    if (!removed) return reply.code(404).send({ error: '查询不存在' });
    return { success: true };
  });

  // ---------- 管理侧：图表 ----------

  /** 公开元数据（不含 SQL）：参数、输出列语义（下拉与格式继承）、口径（预览） */
  const queryOptions = (queries) => queries.map((q) => ({ ...toPublicQuery(q), enabled: q.enabled }));

  fastify.get('/admin/bi/charts', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const [items, queries, dashboards] = await Promise.all([listAllCharts(pool), listAllQueries(pool), listAllDashboards(pool)]);
    return {
      items: items.map((c) => ({ ...c, usedByDashboards: dashboardsUsingChart(dashboards, c.chartKey).map((d) => d.label) })),
      availableQueries: queryOptions(queries),
    };
  });

  fastify.post('/admin/bi/charts', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const queries = await listAllQueries(pool);
    const parsed = validateChartInput(request.body || {}, new Map(queries.map((q) => [q.queryKey, q])));
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const saved = await upsertChart(pool, parsed.value);
    // 看板里的同名筛选 / 必填参数来源可能因此对不上：只提示
    const warnings = (await impactWarnings(pool, new Set([saved.chartKey]))).filter((w) => w.startsWith('看板'));
    return { chart: saved, warnings };
  });

  fastify.delete('/admin/bi/charts/:chartKey', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const key = String(request.params.chartKey || '').toLowerCase();
    const used = dashboardsUsingChart(await listAllDashboards(pool), key);
    if (used.length > 0) {
      return reply.code(409).send({ error: `该图表仍被看板使用：${used.map((d) => d.label).join('、')}`, code: 'BI_CHART_IN_USE' });
    }
    const removed = await deleteChart(pool, key);
    if (!removed) return reply.code(404).send({ error: '图表不存在' });
    return { success: true };
  });

  // ---------- 管理侧：AI 起草 ----------

  const llm = async (messages) => {
    const r = await aiService.generateChat(messages, { maxTokens: 4000, temperature: 0.2 });
    if (!r.success) throw new DraftError(r.fallback || r.error || 'AI 服务不可用');
    return r.content;
  };
  /** AI 接口统一错误处理：DraftError（需求不清、修正失败等）400，其它 500 */
  const aiRoute = (fn) => async (request, reply) => {
    try {
      return await fn(request, await getPool());
    } catch (err) {
      if (err instanceof DraftError) return reply.code(400).send({ error: err.message, code: err.code });
      request.log.error({ err: err.message }, '[bi] AI 接口失败');
      return reply.code(500).send({ error: `AI 处理失败：${err.message}`, code: 'BI_DRAFT_FAILED' });
    }
  };
  const testRun = (pool) => (q, params) => testRunQuery(pool, q, params, 50);

  fastify.post(
    '/admin/bi/ai/draft',
    { preHandler: [fastify.requireAdmin] },
    aiRoute(async (request, pool) => {
      const [existingQueries, existingCharts] = await Promise.all([listAllQueries(pool), listAllCharts(pool)]);
      const draft = await draftQueryAndChart({ pool, llm, existingQueries, existingCharts, testRun: testRun(pool) }, (request.body || {}).requirement);
      return { draft };
    }),
  );

  fastify.post(
    '/admin/bi/ai/draft-from-sql',
    { preHandler: [fastify.requireAdmin] },
    aiRoute(async (request, pool) => {
      const body = request.body || {};
      const [existingQueries, existingCharts] = await Promise.all([listAllQueries(pool), listAllCharts(pool)]);
      const draft = await draftFromSql({ pool, llm, existingQueries, existingCharts, testRun: testRun(pool) }, { sql: body.sql, question: body.question });
      return { draft };
    }),
  );

  fastify.post(
    '/admin/bi/ai/revise-query',
    { preHandler: [fastify.requireAdmin] },
    aiRoute(async (request, pool) => {
      const body = request.body || {};
      return { revision: await reviseQuery({ pool, llm, testRun: testRun(pool) }, body.query, body.instruction) };
    }),
  );

  fastify.post(
    '/admin/bi/ai/enrich-query',
    { preHandler: [fastify.requireAdmin] },
    aiRoute(async (request, pool) => {
      const body = request.body || {};
      return { semantics: await enrichQuery({ llm, testRun: testRun(pool) }, body.query, body.params) };
    }),
  );

  // ---------- 管理侧：看板 ----------

  fastify.get('/admin/bi/dashboards', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const [items, charts, queries, agents] = await Promise.all([
      listAllDashboards(pool),
      listAllCharts(pool),
      listAllQueries(pool),
      listAllAgents(pool),
    ]);
    return {
      items: items.map((d) => ({
        ...d,
        usedByAgents: agents.filter((a) => a.dashboardKey === d.dashboardKey).map((a) => a.agentKey),
      })),
      // 看板编辑器：可选图表（含完整定义，用于展开预览与参数来源提示）+ 查询公开元数据
      availableCharts: charts,
      availableQueries: queryOptions(queries),
    };
  });

  fastify.post('/admin/bi/dashboards', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const [charts, queries] = await Promise.all([listAllCharts(pool), listAllQueries(pool)]);
    const parsed = validateDashboardInput(request.body || {}, {
      charts: new Map(charts.map((c) => [c.chartKey, c])),
      queries: new Map(queries.map((q) => [q.queryKey, q])),
    });
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
