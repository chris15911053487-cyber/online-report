const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDashboardInput, filterDashboardForRoles } = require('../src/bi-dashboards');

const known = new Set(['fin_ar', 'fin_ar_docs', 'fin_cost', 'fin_kpi']);
const base = {
  dashboardKey: 'finance',
  label: '财务看板',
  filters: [
    { name: 'period', label: '期间', type: 'month', default: '$thisMonth' },
    { name: 'company', type: 'select', options: [{ value: 'A', label: '甲公司' }, 'B'] },
  ],
  cards: [
    { id: 'kpi_ar', type: 'kpi', title: '应收', queryKey: 'fin_kpi', params: { period: '$filter.period' }, encoding: { value: 'AR', compare: 'PrevAR', format: 'money', scale: 10000, unit: '万' } },
    {
      id: 'ar_by_cust',
      type: 'bar',
      title: '应收按客户',
      queryKey: 'fin_ar',
      params: { period: '$filter.period', top: 10 },
      encoding: { dimension: 'CardName', value: 'Balance' },
      drill: [{ queryKey: 'fin_ar_docs', bind: { cardCode: 'CardCode' }, label: '单据', params: { period: '$filter.period' } }],
      layout: { w: 99, h: 0 },
    },
  ],
};

test('合法看板：规范化默认值、布局夹紧、select 选项', () => {
  const r = validateDashboardInput(base, known);
  assert.equal(r.ok, true, r.error);
  const [kpi, bar] = r.value.cards;
  assert.deepEqual(kpi.layout, { w: 3, h: 1 });
  assert.deepEqual(bar.layout, { w: 12, h: 2 }, 'w 夹紧到 12；h=0 视为未设置，用图表默认 2');
  assert.equal(bar.drill[0].type, 'table');
  assert.deepEqual(r.value.filters[1].options, [{ value: 'A', label: '甲公司' }, { value: 'B', label: 'B' }]);
  assert.equal(kpi.encoding.scale, 10000);
});

test('看板校验：各种错误', () => {
  const card = base.cards[1];
  const cases = [
    [{ dashboardKey: 'Bad Key' }, /dashboardKey/],
    [{ label: '' }, /显示名称/],
    [{ filters: [{ name: 'p', type: 'week' }] }, /type/],
    [{ filters: [{ name: 'p', type: 'month', default: '$tomorrow' }] }, /记号不支持/],
    [{ filters: [{ name: 'c', type: 'select' }] }, /options/],
    [{ cards: [{ ...card, queryKey: 'nope' }] }, /不存在的查询/],
    [{ cards: [{ ...card, type: 'gauge' }] }, /type/],
    [{ cards: [{ ...card, title: '' }] }, /标题/],
    [{ cards: [card, card] }, /重复/],
    [{ cards: [{ ...card, params: { period: '$filter.nope' } }] }, /不存在的筛选项/],
    [{ cards: [{ ...card, params: { x: { a: 1 } } }] }, /简单值/],
    [{ cards: [{ ...card, encoding: { value: 'Balance' } }] }, /dimension/],
    [{ cards: [{ ...card, encoding: { dimension: 'a;b', value: 'v' } }] }, /列名非法/],
    [{ cards: [{ ...card, encoding: { dimension: 'd', value: 'v', format: 'bytes' } }] }, /format/],
    [{ cards: [{ ...base.cards[0], encoding: {} }] }, /KPI/],
    [{ cards: [{ ...card, drill: [{ queryKey: 'nope' }] }] }, /下钻.*不存在的查询/],
    [{ cards: [{ ...card, drill: [{ queryKey: 'fin_ar_docs', type: 'kpi' }] }] }, /下钻 type/],
    [{ cards: [{ ...card, drill: [{ queryKey: 'fin_ar_docs', bind: { cardCode: 'x y' } }] }] }, /bind/],
  ];
  for (const [patch, re] of cases) {
    const r = validateDashboardInput({ ...base, ...patch }, known);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, re, JSON.stringify(patch));
  }
});

test('按角色裁剪：删无权卡片；下钻遇无权一级即截断；附公开元数据（无 SQL）', () => {
  const dashboard = {
    dashboardKey: 'finance',
    label: 'x',
    filters: [],
    cards: [
      { id: 'a', queryKey: 'fin_ar', drill: [{ queryKey: 'fin_cost' }, { queryKey: 'fin_ar_docs' }] },
      { id: 'b', queryKey: 'fin_cost', drill: [] },
      { id: 'c', queryKey: 'fin_disabled', drill: [] },
      { id: 'd', queryKey: 'fin_deleted', drill: [] },
    ],
  };
  const q = (queryKey, roles, enabled = true) => ({ queryKey, roles, enabled, sqlText: 'SELECT secret', label: queryKey, params: [], dimensions: [] });
  const queries = [q('fin_ar', ['finance']), q('fin_cost', ['cost-viewer']), q('fin_ar_docs', ['finance']), q('fin_disabled', ['finance'], false)];

  const fin = filterDashboardForRoles(dashboard, queries, ['finance']);
  assert.deepEqual(fin.cards.map((c) => c.id), ['a']);
  assert.deepEqual(fin.cards[0].drill, [], '第 1 级无权 → 后续级一并截断');
  assert.equal(fin.hiddenCards, 3);
  assert.deepEqual(Object.keys(fin.queries), ['fin_ar']);
  assert.equal(JSON.stringify(fin).includes('secret'), false);

  const both = filterDashboardForRoles(dashboard, queries, ['finance', 'cost-viewer']);
  assert.deepEqual(both.cards.map((c) => c.id), ['a', 'b']);
  assert.equal(both.cards[0].drill.length, 2);

  const admin = filterDashboardForRoles(dashboard, queries, ['admin']);
  assert.deepEqual(admin.cards.map((c) => c.id), ['a', 'b'], '停用/已删除的查询对管理员也隐藏');
});
