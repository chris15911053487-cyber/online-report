const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 用 require.cache 注入桩，避免加载真实 db
function stub(rel, exports) {
  const file = require.resolve(path.join('../src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const SKILLS = [
  { name: 'a', description: 'da', bodyMd: 'ba', producesDocument: false, allowedTables: ['T1'], resources: { 'r.md': { content: 'xyz' } } },
  { name: 'b', description: 'db', bodyMd: 'bb', producesDocument: true, resources: {} },
];
let agentImpl;
let getAgentCalls = 0;
stub('agent-skills.js', { listSkillsForRoles: async () => SKILLS });
stub('agents.js', {
  getAgent: async (...args) => {
    getAgentCalls += 1;
    return agentImpl(...args);
  },
});
let dashboardImpl = async () => null;
let queriesImpl = async () => [];
stub('bi-dashboards.js', {
  loadExpandedDashboard: async (...a) => {
    const dashboard = await dashboardImpl(...a);
    return dashboard ? { dashboard, queries: await queriesImpl() } : null;
  },
});
stub('bi-queries.js', {
  listAllQueries: async (...a) => queriesImpl(...a),
  canUseQuery: (u, q) => u.includes('admin') || q.some((r) => u.includes(r)),
});
const { resolveAgentContext, formatQueryCatalog } = require('../src/agent-context');

const run = (agentKey) => {
  getAgentCalls = 0;
  return resolveAgentContext({}, { agentKey, userRoles: ['operator'] });
};

test('未指定 agentKey：全部 skill，不查 agents 表', async () => {
  const r = await run(undefined);
  assert.deepEqual(r.skills.map((s) => s.name), ['a', 'b']);
  assert.equal(r.agentPrompt, '');
  assert.equal(getAgentCalls, 0);
});

test('映射：资源只传清单，allowedTables 缺省为空数组', async () => {
  const r = await run(undefined);
  assert.deepEqual(r.skills[0].resources, [{ path: 'r.md', size: 3 }]);
  assert.deepEqual(r.skills[1].allowedTables, []);
  assert.equal(r.skills[0].bodyMd, 'ba');
});

test('Agent 存在且启用：取关联 skill 交集，带专属指令，且只查一次', async () => {
  agentImpl = async () => ({ enabled: true, skills: ['b', 'zzz'], systemPromptExtra: 'EXTRA' });
  const r = await run('sales');
  assert.deepEqual(r.skills.map((s) => s.name), ['b']);
  assert.equal(r.agentPrompt, 'EXTRA');
  assert.equal(getAgentCalls, 1);
});

test('Agent 未关联 skill：skills 为空，专属指令仍带上', async () => {
  agentImpl = async () => ({ enabled: true, skills: [], systemPromptExtra: 'EXTRA' });
  const r = await run('chat');
  assert.deepEqual(r.skills, []);
  assert.equal(r.agentPrompt, 'EXTRA');
});

test('Agent 未启用：skills 为空（沿用原行为）', async () => {
  agentImpl = async () => ({ enabled: false, skills: ['a'], systemPromptExtra: '' });
  const r = await run('off');
  assert.deepEqual(r.skills, []);
});

test('Agent 不存在：skills 为空', async () => {
  agentImpl = async () => null;
  const r = await run('nope');
  assert.deepEqual(r.skills, []);
  assert.equal(r.agentPrompt, '');
});

test('读取 Agent 失败：退回全部 skill，无专属指令', async () => {
  agentImpl = async () => {
    throw new Error('db down');
  };
  const r = await run('sales');
  assert.deepEqual(r.skills.map((s) => s.name), ['a', 'b']);
  assert.equal(r.agentPrompt, '');
});


// ---- 关联看板：命名查询目录 ----
const Q = (queryKey, roles, extra = {}) => ({
  queryKey, label: queryKey.toUpperCase(), description: '', params: [{ name: 'period', type: 'string', required: true }],
  dimensions: [{ column: 'CardCode', label: '客户' }], caliberNote: '按过账日期', roles, enabled: true, sqlText: 'SELECT secret', ...extra,
});

test('关联看板：目录只含看板用到、启用且有权的查询；按 key 排序；不含 SQL；追加在专属指令之后', async () => {
  agentImpl = async () => ({ enabled: true, skills: [], systemPromptExtra: 'EXTRA', dashboardKey: 'finance' });
  dashboardImpl = async () => ({
    enabled: true,
    cards: [
      { queryKey: 'z_ar', drill: [{ queryKey: 'b_docs' }, { queryKey: 'cost' }] },
      { queryKey: 'off' },
    ],
  });
  queriesImpl = async () => [Q('z_ar', ['operator']), Q('b_docs', ['operator']), Q('cost', ['cost-viewer']), Q('off', ['operator'], { enabled: false }), Q('unused', ['operator'])];
  const r = await run('fin');
  assert.ok(r.agentPrompt.startsWith('EXTRA\n\n### 可用命名查询'));
  const keys = [...r.agentPrompt.matchAll(/- `([a-z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['b_docs', 'z_ar']);
  assert.equal(r.agentPrompt.includes('secret'), false);
  assert.match(r.agentPrompt, /参数：period:string（必填）；维度列：CardCode\(客户\)；口径：按过账日期/);
});

test('关联看板但看板停用 / 读取失败：不加目录，不影响 skill', async () => {
  agentImpl = async () => ({ enabled: true, skills: ['a'], systemPromptExtra: '', dashboardKey: 'finance' });
  dashboardImpl = async () => ({ enabled: false, cards: [{ queryKey: 'z_ar' }] });
  let r = await run('fin');
  assert.equal(r.agentPrompt, '');
  dashboardImpl = async () => { throw new Error('db'); };
  r = await run('fin');
  assert.equal(r.agentPrompt, '');
  assert.deepEqual(r.skills.map((s) => s.name), ['a']);
});

test('formatQueryCatalog：空列表为空串；超长截断', () => {
  assert.equal(formatQueryCatalog([]), '');
  const many = Array.from({ length: 30 }, (_, i) => Q(`q${String(i).padStart(2, '0')}`, [], { description: 'x'.repeat(300) }));
  const s = formatQueryCatalog(many);
  assert.ok(s.length < 6600);
  assert.match(s, /其余查询未列出/);
});
