const test = require('node:test');
const assert = require('node:assert/strict');
const { initialFilterValues, resolveCardParams, cardColumns, collectDashboardData, writeDigest, digestMessage, groupUsersByRoles } = require('../src/bi-digest');

// 2026-10-01 00:30 中国时间（UTC 仍是 9 月 30 日）
const NOW = Date.UTC(2026, 8, 30, 16, 30);

test('筛选默认值按中国日期；select 无默认取第一个选项；卡片参数取筛选值', () => {
  const fv = initialFilterValues([{ name: 'period', type: 'month', default: '$thisMonth' }, { name: 'region', type: 'select', options: [{ value: 'N' }, { value: 'S' }] }, { name: 'x', type: 'text' }], NOW);
  assert.deepEqual(fv, { period: '2026-10', region: 'N', x: null });
  assert.deepEqual(resolveCardParams({ period: '$filter.period', top: 5, r: '$filter.nope' }, fv), { period: '2026-10', top: 5, r: null });
});

test('cardColumns：只取 encoding 用到且结果里有的列；都没有取前几列', () => {
  assert.deepEqual(cardColumns({ encoding: { dimension: 'CardName', value: 'Amount', compare: 'Ghost' } }, ['CardCode', 'CardName', 'Amount']), ['CardName', 'Amount']);
  assert.deepEqual(cardColumns({ encoding: {} }, ['a', 'b']), ['a', 'b']);
});

const loaded = {
  dashboard: {
    dashboardKey: 'sales', label: '销售看板', enabled: true,
    filters: [{ name: 'period', type: 'month', default: '$thisMonth' }],
    cards: [
      { id: 'k', title: '本月销售额', type: 'kpi', queryKey: 'kpi', params: { period: '$filter.period' }, encoding: { value: 'Amount', compare: 'Prev' }, drill: [] },
      { id: 't', title: '客户排名', type: 'bar', queryKey: 'top', params: { period: '$filter.period', top: 20 }, encoding: { dimension: 'CardName', value: 'Amount' }, drill: [] },
      { id: 'c', title: '成本', type: 'kpi', queryKey: 'cost', params: {}, encoding: { value: 'Cost' }, drill: [] },
      { id: 'e', title: '坏卡片', type: 'table', queryKey: 'bad', params: {}, encoding: {}, drill: [] },
    ],
  },
  queries: [
    { queryKey: 'kpi', enabled: true, roles: ['sales'], columns: [{ column: 'Amount', label: '销售额', role: 'measure', unit: '元' }], caliberNote: '口径：含税' },
    { queryKey: 'top', enabled: true, roles: ['sales'], columns: [] },
    { queryKey: 'cost', enabled: true, roles: ['cost-viewer'], columns: [] },
    { queryKey: 'bad', enabled: true, roles: ['sales'], columns: [] },
  ],
};

test('collectDashboardData：按角色过滤卡片；KPI 只取 1 行；排名超 15 行截断；取数失败记一句；口径去掉前缀', async () => {
  const calls = [];
  const run = async (q, p) => {
    calls.push([q.queryKey, p]);
    if (q.queryKey === 'bad') throw new Error('boom');
    if (q.queryKey === 'kpi') return { columns: ['Amount', 'Prev'], rows: [{ Amount: 1234.567, Prev: 1000 }, { Amount: 9, Prev: 9 }] };
    return { columns: ['CardCode', 'CardName', 'Amount'], rows: Array.from({ length: 18 }, (_, i) => ({ CardCode: `C${i}`, CardName: `客户,${i}`, Amount: 100 - i })) };
  };
  const d = await collectDashboardData({ loaded, roles: ['sales'], run, now: NOW });
  assert.equal(d.label, '销售看板');
  assert.deepEqual(d.cards.map((c) => c.title), ['本月销售额', '客户排名', '坏卡片'], '成本卡片无权，不取数');
  assert.deepEqual(calls[0], ['kpi', { period: '2026-10' }]);
  assert.equal(d.cards[0].text, 'Amount(销售额，元),Prev\n1234.57,1000\n口径：含税');
  assert.match(d.cards[1].text, /^CardName,Amount\n客户 0,100\n/);
  assert.match(d.cards[1].text, /共 18 行，仅列前 15 行/);
  assert.match(d.cards[2].text, /取数失败：boom/);
});

test('writeDigest：带筛选、关注点与数据；没有卡片不调 AI', async () => {
  let seen;
  const out = await writeDigest(async (m) => { seen = m; return ' - 要点一 \n'; }, { label: '销售看板', filterValues: { period: '2026-10' }, cards: [{ title: 'KPI', type: 'kpi', text: 'Amount\n1' }] }, '重点看大客户');
  assert.equal(out, '- 要点一');
  assert.match(seen[0].content, /3~5 条/);
  assert.match(seen[1].content, /看板：销售看板（筛选：period=2026-10）\n关注点：重点看大客户/);
  assert.match(seen[1].content, /### 1\. KPI（kpi）\nAmount\n1/);
  assert.equal(await writeDigest(async () => { throw new Error('不该调用'); }, { label: 'x', filterValues: {}, cards: [] }), '');
});

test('digestMessage：有站点地址带看板链接，否则提示在系统里打开；无要点有兜底', () => {
  assert.equal(digestMessage({ title: '销售日报', points: '- a', agentKey: 'sales-analysis', baseUrl: 'https://r.example.com/' }), '**销售日报**\n\n- a\n\n[📊 打开看板](https://r.example.com/agents/sales-analysis)');
  assert.match(digestMessage({ title: 't', points: '', agentKey: 'k', agentLabel: '销售分析', baseUrl: '' }), /今天没有可写的要点[\s\S]*在系统「Agent → 销售分析」查看看板/);
});

test('groupUsersByRoles：角色集合相同的人合并（顺序无关）', () => {
  const g = groupUsersByRoles([{ userCode: 'a', roles: ['x', 'y'] }, { userCode: 'b', roles: ['y', 'x', 'x'] }, { userCode: 'c', roles: [] }]);
  assert.deepEqual([...g.values()].map((v) => [v.roles, v.users.map((u) => u.userCode)]), [[['x', 'y'], ['a', 'b']], [[], ['c']]]);
});

test('dashboardUsesSession：只看卡片用到的查询是否用了 @_loginUser', () => {
  const { dashboardUsesSession } = require('../src/bi-digest');
  const queries = [
    { queryKey: 'mine', sqlText: 'SELECT 1 WHERE U_Owner = @_loginUser' },
    { queryKey: 'all', sqlText: 'SELECT 1' },
  ];
  assert.equal(dashboardUsesSession({ dashboard: { cards: [{ queryKey: 'all' }] }, queries }), false);
  assert.equal(dashboardUsesSession({ dashboard: { cards: [{ queryKey: 'all' }, { queryKey: 'mine' }] }, queries }), true);
  assert.equal(dashboardUsesSession(null), false);
});
