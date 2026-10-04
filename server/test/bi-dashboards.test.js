const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDashboardInput, filterDashboardForRoles } = require('../src/bi-dashboards');

const knownCharts = new Set(['ar_kpi', 'ar_by_cust']);
const base = {
  dashboardKey: 'finance',
  label: '财务看板',
  filters: [
    { name: 'period', label: '期间', type: 'month', default: '$thisMonth' },
    { name: 'company', type: 'select', options: [{ value: 'A', label: '甲公司' }, 'B'] },
  ],
  cards: [
    { chartKey: 'ar_kpi' },
    { id: 'ar', chartKey: 'AR_BY_CUST', title: '应收按客户（本部）', params: { company: '$filter.company', top: 10 }, layout: { w: 99, h: 0 } },
  ],
};

test('合法看板：卡片为图表引用；id 缺省取 chartKey；布局夹紧；select 选项', () => {
  const r = validateDashboardInput(base, { charts: knownCharts });
  assert.equal(r.ok, true, r.error);
  const [kpi, bar] = r.value.cards;
  assert.deepEqual(kpi, { id: 'ar_kpi', chartKey: 'ar_kpi' }, '未写的项不保存，运行时用图表默认');
  assert.equal(bar.chartKey, 'ar_by_cust');
  assert.equal(bar.title, '应收按客户（本部）');
  assert.deepEqual(bar.params, { company: '$filter.company', top: 10 });
  assert.deepEqual(bar.layout, { w: 12, h: 2 }, 'w 夹紧到 12；h=0 视为未设置');
  assert.deepEqual(r.value.filters[1].options, [{ value: 'A', label: '甲公司' }, { value: 'B', label: 'B' }]);
});

test('同一图表放两次：id 自动去重', () => {
  const r = validateDashboardInput({ ...base, cards: [{ chartKey: 'ar_kpi' }, { chartKey: 'ar_kpi' }] }, { charts: knownCharts });
  assert.deepEqual(r.value.cards.map((c) => c.id), ['ar_kpi', 'ar_kpi_2']);
});

test('看板校验：各种错误', () => {
  const card = base.cards[1];
  const cases = [
    [{ dashboardKey: 'Bad Key' }, /dashboardKey/],
    [{ label: '' }, /显示名称/],
    [{ filters: [{ name: 'p', type: 'week' }] }, /type/],
    [{ filters: [{ name: 'p', type: 'month', default: '$tomorrow' }] }, /记号不支持/],
    [{ filters: [{ name: 'c', type: 'select' }] }, /options/],
    [{ cards: [{ ...card, chartKey: 'nope' }] }, /不存在的图表/],
    [{ cards: [{ ...card, chartKey: '' }] }, /未选择图表/],
    [{ cards: [card, card] }, /重复/],
    [{ cards: [{ ...card, id: '1bad' }] }, /id 非法/],
    [{ cards: [{ ...card, params: { period: '$filter.nope' } }] }, /不存在的筛选项/],
    [{ cards: [{ ...card, params: { x: { a: 1 } } }] }, /简单值/],
  ];
  for (const [patch, re] of cases) {
    const r = validateDashboardInput({ ...base, ...patch }, { charts: knownCharts });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, re, JSON.stringify(patch));
  }
});

test('按角色裁剪（作用于展开后的卡片）：删无权卡片；下钻遇无权一级即截断；附公开元数据（无 SQL）', () => {
  const dashboard = {
    dashboardKey: 'finance',
    label: 'x',
    filters: [],
    missingCharts: 1,
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
  assert.equal(fin.hiddenCards, 4, '含 1 张引用了已停用 / 已删除图表的卡片');
  assert.deepEqual(Object.keys(fin.queries), ['fin_ar']);
  assert.equal(JSON.stringify(fin).includes('secret'), false);

  const both = filterDashboardForRoles(dashboard, queries, ['finance', 'cost-viewer']);
  assert.deepEqual(both.cards.map((c) => c.id), ['a', 'b']);
  assert.equal(both.cards[0].drill.length, 2);

  const admin = filterDashboardForRoles(dashboard, queries, ['admin']);
  assert.deepEqual(admin.cards.map((c) => c.id), ['a', 'b'], '停用/已删除的查询对管理员也隐藏');
});
