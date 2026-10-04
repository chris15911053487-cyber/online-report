/**
 * BI 路由：真实 fastify + 真实 bi-queries / bi-dashboards / bi-exec / agents 模块，
 * db 换成内存假 pool（按 SQL 文本分派），roles 由请求头 x-test-roles 决定。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function stub(rel, exports) {
  const file = require.resolve(path.join('../src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// ---- 内存「数据库」----
const db = { queries: new Map(), charts: new Map(), dashboards: new Map(), agents: new Map(), execCount: 0, lastInputs: null };
const fakeSql = new Proxy({}, { get: (_t, k) => (k === 'MAX' ? -1 : (...a) => ({ type: k, a })) });
fakeSql.MAX = -1;

function queryRow(v) {
  return {
    id: 1, query_key: v.queryKey, label: v.label, description: v.description || '', sql_text: v.sqlText,
    params_json: JSON.stringify(v.params || []), dimensions_json: JSON.stringify(v.dimensions || []),
    caliber_note: v.caliberNote || '', cache_secs: v.cacheSecs ?? 300, roles_json: JSON.stringify(v.roles || []),
    enabled: v.enabled === false ? 0 : 1, updated_at: v.updatedAt || new Date('2026-10-01'),
  };
}

function makeRequest() {
  const inputs = {};
  const handlers = {};
  const req = {
    input(name, _type, value) { inputs[name] = value; return req; },
    on(ev, fn) { handlers[ev] = fn; return req; },
    cancel() {},
    async query(q) {
      if (req.stream) {
        // 命名查询执行（流式）
        db.execCount += 1;
        db.lastInputs = { ...inputs };
        setImmediate(() => {
          if (/RAISE_ERROR/.test(q)) return handlers.error(new Error('Invalid column name Foo'));
          handlers.recordset({ CardCode: {}, Balance: {} });
          handlers.row({ CardCode: 'C001', Balance: 100 + db.execCount });
          handlers.done();
        });
        return undefined;
      }
      if (/FROM dbo\.bi_queries ORDER BY/.test(q)) return { recordset: [...db.queries.values()] };
      if (/MERGE dbo\.bi_queries/.test(q)) {
        db.queries.set(inputs.query_key, queryRow({
          queryKey: inputs.query_key, label: inputs.label, sqlText: inputs.sql_text,
          params: JSON.parse(inputs.params_json), dimensions: JSON.parse(inputs.dimensions_json), caliberNote: inputs.caliber_note,
          cacheSecs: inputs.cache_secs, roles: JSON.parse(inputs.roles_json), enabled: inputs.enabled,
          updatedAt: new Date(),
        }));
        return {};
      }
      if (/DELETE FROM dbo\.bi_queries/.test(q)) return { rowsAffected: [db.queries.delete(inputs.k) ? 1 : 0] };
      if (/FROM dbo\.bi_charts WHERE/.test(q)) return { recordset: db.charts.has(inputs.k) ? [db.charts.get(inputs.k)] : [] };
      if (/FROM dbo\.bi_charts ORDER BY/.test(q)) return { recordset: [...db.charts.values()] };
      if (/MERGE dbo\.bi_charts/.test(q)) {
        db.charts.set(inputs.chart_key, { id: 1, ...inputs, enabled: inputs.enabled ? 1 : 0 });
        return {};
      }
      if (/DELETE FROM dbo\.bi_charts/.test(q)) return { rowsAffected: [db.charts.delete(inputs.k) ? 1 : 0] };
      if (/FROM dbo\.bi_dashboards WHERE/.test(q)) return { recordset: db.dashboards.has(inputs.k) ? [db.dashboards.get(inputs.k)] : [] };
      if (/FROM dbo\.bi_dashboards ORDER BY/.test(q)) return { recordset: [...db.dashboards.values()] };
      if (/MERGE dbo\.bi_dashboards/.test(q)) {
        db.dashboards.set(inputs.dashboard_key, {
          id: 1, dashboard_key: inputs.dashboard_key, label: inputs.label, description: inputs.description,
          filters_json: inputs.filters_json, cards_json: inputs.cards_json, enabled: inputs.enabled ? 1 : 0,
        });
        return {};
      }
      if (/DELETE FROM dbo\.bi_dashboards/.test(q)) return { rowsAffected: [db.dashboards.delete(inputs.k) ? 1 : 0] };
      if (/FROM dbo\.agents WHERE/.test(q)) return { recordset: db.agents.has(inputs.k) ? [db.agents.get(inputs.k)] : [] };
      if (/FROM dbo\.agents/.test(q)) return { recordset: [...db.agents.values()] };
      throw new Error('unexpected query: ' + q.slice(0, 80));
    },
  };
  return req;
}
const pool = { request: makeRequest };

stub('db.js', { getPool: async () => pool, sql: fakeSql });
const realRoles = (() => {
  // roles.js 依赖 db.js（已桩）；只借用其纯函数
  return require('../src/roles');
})();
stub('roles.js', {
  ...realRoles,
  resolveUserRoles: async () => { throw new Error('use header'); },
  getUserRolesFromRequest: (user) => user.roles,
  loadKnownRoleKeys: async () => new Set(['finance', 'cost-viewer', 'operator']),
});

const { invalidateQueryDefs } = require('../src/bi-queries');
const { invalidateBiCache } = require('../src/bi-exec');

let app;
let base;
test.before(async () => {
  const Fastify = require('fastify');
  app = Fastify();
  app.decorate('authenticate', async (request) => {
    request.user = { username: 'U1', roles: String(request.headers['x-test-roles'] || 'operator').split(',') };
  });
  app.decorate('requireAdmin', async (request, reply) => {
    if (request.headers['x-test-roles'] !== 'admin') return reply.code(403).send({ error: '需要管理员权限' });
    request.user = { username: 'A', roles: ['admin'] };
  });
  await app.register(require('../src/routes/bi'));
  await app.register(require('../src/routes/agents'));
  await app.register(require('../src/routes/ai-agent'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => app.close());

async function call(method, url, roles, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-roles': roles },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const arQuery = {
  queryKey: 'fin_ar',
  label: '应收按客户',
  sqlText: 'SELECT CardCode, Balance FROM V_AR WHERE Period = @period',
  params: [{ name: 'period', type: 'string', required: true }],
  dimensions: [{ column: 'CardCode', label: '客户' }],
  caliberNote: '按过账日期',
  cacheSecs: 60,
  roles: ['finance'],
};

test('查询库管理：非管理员 403；校验失败 400；未定义角色 400；保存成功', async () => {
  invalidateQueryDefs();
  assert.equal((await call('POST', '/admin/bi/queries', 'finance', arQuery)).status, 403);
  const bad = await call('POST', '/admin/bi/queries', 'admin', { ...arQuery, sqlText: 'DELETE FROM X' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /SELECT/);
  const badRole = await call('POST', '/admin/bi/queries', 'admin', { ...arQuery, roles: ['nobody'] });
  assert.equal(badRole.status, 400);
  const ok = await call('POST', '/admin/bi/queries', 'admin', arQuery);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.query.queryKey, 'fin_ar');
  const list = await call('GET', '/admin/bi/queries', 'admin');
  assert.equal(list.body.items.length, 1);
  assert.ok(list.body.availableRoles.includes('finance'));
});

test('POST /bi/query：权限、参数校验、缓存、错误不泄露详情', async () => {
  invalidateBiCache();
  db.execCount = 0;
  const forbidden = await call('POST', '/bi/query', 'operator', { queryKey: 'fin_ar', params: { period: '2026-09' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await call('POST', '/bi/query', 'finance', { queryKey: 'nope' })).status, 404);
  const missing = await call('POST', '/bi/query', 'finance', { queryKey: 'fin_ar', params: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /必填/);
  assert.equal(db.execCount, 0);

  const a = await call('POST', '/bi/query', 'finance', { queryKey: 'fin_ar', params: { period: '2026-09', evil: 'x' } });
  assert.equal(a.status, 200);
  assert.equal(a.body.cached, false);
  assert.deepEqual(a.body.columns, ['CardCode', 'Balance']);
  assert.deepEqual(db.lastInputs, { period: '2026-09' }, '只绑定声明过的参数');
  const b = await call('POST', '/bi/query', 'finance', { queryKey: 'fin_ar', params: { period: '2026-09' } });
  assert.equal(b.body.cached, true);
  assert.equal(db.execCount, 1);
  // 角色集合不同不共享缓存
  await call('POST', '/bi/query', 'finance,cost-viewer', { queryKey: 'fin_ar', params: { period: '2026-09' } });
  assert.equal(db.execCount, 2);
  // refresh 强制重查
  const r = await call('POST', '/bi/query', 'finance', { queryKey: 'fin_ar', params: { period: '2026-09' }, refresh: true });
  assert.equal(r.body.cached, false);
  assert.equal(db.execCount, 3);

  // SQL 错误：普通用户看不到详情，管理员可以
  await call('POST', '/admin/bi/queries', 'admin', { ...arQuery, queryKey: 'fin_err', sqlText: 'SELECT RAISE_ERROR FROM X WHERE p = @period' });
  const e1 = await call('POST', '/bi/query', 'finance', { queryKey: 'fin_err', params: { period: 'x' } });
  assert.equal(e1.status, 500);
  assert.equal(e1.body.error.includes('Foo'), false);
  const e2 = await call('POST', '/bi/query', 'admin', { queryKey: 'fin_err', params: { period: 'x' } });
  assert.match(e2.body.error, /Foo/);
});

test('试运行：用未保存的定义执行，不进缓存', async () => {
  invalidateBiCache();
  db.execCount = 0;
  const t1 = await call('POST', '/admin/bi/queries/test', 'admin', { query: { ...arQuery, queryKey: 'draft' }, params: { period: '2026-09' } });
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  assert.equal(t1.body.rowCount, 1);
  assert.ok(t1.body.durationMs >= 0);
  await call('POST', '/admin/bi/queries/test', 'admin', { query: { ...arQuery, queryKey: 'draft' }, params: { period: '2026-09' } });
  assert.equal(db.execCount, 2);
  const bad = await call('POST', '/admin/bi/queries/test', 'admin', { query: { ...arQuery, sqlText: 'SELECT 1; DROP TABLE X' } });
  assert.equal(bad.status, 400);
});

test('图表 + 看板 + Agent 关联：校验、按角色裁剪、门禁、删除保护', async () => {
  await call('POST', '/admin/bi/queries', 'admin', { ...arQuery, queryKey: 'fin_cost', roles: ['cost-viewer'] });
  // 图表：引用查询；period 不写，由看板同名筛选提供
  assert.equal((await call('POST', '/admin/bi/charts', 'operator', {})).status, 403);
  const badChart = await call('POST', '/admin/bi/charts', 'admin', { chartKey: 'x', label: 'X', type: 'kpi', queryKey: 'ghost', encoding: { value: 'Balance' } });
  assert.equal(badChart.status, 400);
  const arChart = { chartKey: 'ar', label: '应收', type: 'bar', queryKey: 'fin_ar', encoding: { dimension: 'CardCode', value: 'Balance' } };
  assert.equal((await call('POST', '/admin/bi/charts', 'admin', arChart)).status, 200);
  assert.equal((await call('POST', '/admin/bi/charts', 'admin', { chartKey: 'cost', label: '成本', type: 'kpi', queryKey: 'fin_cost', encoding: { value: 'Balance' } })).status, 200);

  const dash = {
    dashboardKey: 'finance',
    label: '财务看板',
    filters: [{ name: 'period', type: 'month', default: '$thisMonth' }],
    cards: [{ chartKey: 'ar' }, { chartKey: 'cost' }],
  };
  assert.equal((await call('POST', '/admin/bi/dashboards', 'admin', { ...dash, cards: [{ chartKey: 'ghost' }] })).status, 400);
  const noFilter = await call('POST', '/admin/bi/dashboards', 'admin', { ...dash, filters: [] });
  assert.equal(noFilter.status, 400, '必填参数 period 没有同名筛选');
  assert.match(noFilter.body.error, /period/);
  assert.equal((await call('POST', '/admin/bi/dashboards', 'admin', dash)).status, 200);

  // Agent 关联不存在的看板 → 400；关联存在的 → 写入 dashboard_key
  const agentBody = { agentKey: 'finance-analysis', label: '财务分析', roles: ['finance'], dashboardKey: 'ghost' };
  assert.equal((await call('POST', '/admin/agents', 'admin', agentBody)).status, 400);
  db.agents.set('finance-analysis', {
    id: 1, agent_key: 'finance-analysis', label: '财务分析', layout_mode: 'canvas', skills_json: '[]',
    quick_prompts_json: '[]', roles_json: '["finance"]', enabled: 1, sort_order: 1, dashboard_key: 'finance',
  });

  const agentPub = await call('GET', '/agents/finance-analysis', 'finance');
  assert.equal(agentPub.body.agent.dashboardKey, 'finance');

  assert.equal((await call('GET', '/agents/finance-analysis/dashboard', 'operator')).status, 403);
  const fin = await call('GET', '/agents/finance-analysis/dashboard', 'finance');
  assert.equal(fin.status, 200);
  assert.deepEqual(fin.body.dashboard.cards.map((c) => c.id), ['ar']);
  assert.deepEqual(fin.body.dashboard.cards[0].params, { period: '$filter.period' }, '下发展开后的完整卡片');
  assert.equal(fin.body.dashboard.cards[0].type, 'bar');
  assert.equal(fin.body.dashboard.queries.fin_ar.caliberNote, '按过账日期');
  assert.equal(JSON.stringify(fin.body).includes('V_AR'), false, '不下发 SQL');
  const both = await call('GET', '/agents/finance-analysis/dashboard', 'finance,cost-viewer');
  assert.deepEqual(both.body.dashboard.cards.map((c) => c.id), ['ar', 'cost']);

  // 删除保护：查询被图表引用 → 409；图表被看板引用 → 409；看板被 Agent 关联 → 409
  assert.equal((await call('DELETE', '/admin/bi/queries/fin_ar', 'admin')).status, 409);
  const delChart = await call('DELETE', '/admin/bi/charts/ar', 'admin');
  assert.equal(delChart.status, 409);
  assert.match(delChart.body.error, /财务看板/);
  const charts = await call('GET', '/admin/bi/charts', 'admin');
  assert.deepEqual(charts.body.items.find((c) => c.chartKey === 'ar').usedByDashboards, ['财务看板']);

  // 影响分析：查询改名参数后，保存成功但提示受影响的看板卡片
  const changed = await call('POST', '/admin/bi/queries', 'admin', { ...arQuery, sqlText: 'SELECT CardCode, Balance FROM V_AR WHERE Period = @ym', params: [{ name: 'ym', type: 'string', required: true }] });
  assert.equal(changed.status, 200);
  assert.ok(changed.body.warnings.some((w) => /看板「财务看板」.*必填参数/.test(w)), JSON.stringify(changed.body.warnings));
  await call('POST', '/admin/bi/queries', 'admin', arQuery);
  const delDash = await call('DELETE', '/admin/bi/dashboards/finance', 'admin');
  assert.equal(delDash.status, 409);
  assert.match(delDash.body.error, /财务分析/);
  const list = await call('GET', '/admin/bi/dashboards', 'admin');
  assert.deepEqual(list.body.items[0].usedByAgents, ['finance-analysis']);

  // 未关联看板的 Agent
  db.agents.set('plain', { ...db.agents.get('finance-analysis'), agent_key: 'plain', dashboard_key: null });
  const none = await call('GET', '/agents/plain/dashboard', 'finance');
  assert.equal(none.status, 404);
  assert.equal(none.body.code, 'BI_NO_DASHBOARD');
});


test('internal named-query：scoped token 门禁、参数校验、与 /bi/query 共用缓存', async () => {
  const { signScopedToken } = require('../src/ai-scoped-token');
  invalidateBiCache();
  db.execCount = 0;
  const post = async (token, body) => {
    const res = await fetch(base + '/ai/agent/internal/named-query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-scoped-token': token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const tok = (roles) => signScopedToken({ userCode: 'U1', roles, conversationId: 'c1' });

  assert.equal((await post(null, { queryKey: 'fin_ar' })).status, 401);
  assert.equal((await post(tok(['operator']), { queryKey: 'fin_ar', params: { period: '2026-09' } })).status, 403);
  assert.equal((await post(tok(['finance']), { queryKey: 'ghost' })).status, 404);
  const bad = await post(tok(['finance']), { queryKey: 'fin_ar', params: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /必填/);

  // 先由看板取一次 → Agent 用同参数、同角色调用命中同一份缓存
  await call('POST', '/bi/query', 'finance', { queryKey: 'fin_ar', params: { period: '2026-08' } });
  assert.equal(db.execCount, 1);
  const r = await post(tok(['finance']), { queryKey: 'FIN_AR', params: { period: '2026-08' }, maxRows: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cached, true);
  assert.equal(db.execCount, 1, '与看板共用缓存，不重复查库');
  assert.equal(r.body.caliberNote, '按过账日期');
  assert.deepEqual(r.body.columns, ['CardCode', 'Balance']);
  assert.equal(JSON.stringify(r.body).includes('V_AR'), false, '不回传 SQL');
});
