const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChartInput, resolveCard, expandDashboard } = require('../src/bi-charts');
const { validateDashboardInput } = require('../src/bi-dashboards');

const queries = new Map([
  ['sales_by_cust', {
    queryKey: 'sales_by_cust', label: '销售按客户',
    params: [{ name: 'period', required: true }, { name: 'top', type: 'number', default: 20 }, { name: 'slpCode' }],
    columns: [{ column: 'CardCode', role: 'attr' }, { column: 'CardName', role: 'dimension' }, { column: 'Amount', role: 'measure' }],
  }],
  ['sales_docs', {
    queryKey: 'sales_docs', label: '销售单据',
    params: [{ name: 'Period', required: true }, { name: 'cardCode', required: true }],
    columns: [{ column: 'DocNum', role: 'attr' }],
  }],
]);

const chartInput = {
  chartKey: 'sales_top_cust',
  label: '客户销售额 Top',
  type: 'bar',
  queryKey: 'sales_by_cust',
  params: { top: 10 },
  encoding: { dimension: 'CardName', value: 'Amount', horizontal: true },
  drill: [{ queryKey: 'sales_docs', label: '单据', bind: { cardCode: 'CardCode' } }],
};

test('图表校验：合法输入；默认尺寸按类型', () => {
  const r = validateChartInput(chartInput, queries);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value.size, { w: 6, h: 2 });
  assert.equal(r.value.drill[0].type, 'table');
  const kpi = validateChartInput({ ...chartInput, chartKey: 'k', type: 'kpi', encoding: { value: 'Amount' }, drill: [], size: { w: 4, h: 3 } }, queries);
  assert.deepEqual(kpi.value.size, { w: 4, h: 1 }, 'KPI 高度固定为 1');
});

test('图表校验：必填参数可以没有来源（由看板同名筛选提供）', () => {
  const r = validateChartInput({ ...chartInput, params: {} }, queries);
  assert.equal(r.ok, true, r.error);
});

test('图表校验：各种错误', () => {
  const cases = [
    [{ chartKey: 'Bad Key' }, /chartKey/],
    [{ label: '' }, /标题/],
    [{ type: 'gauge' }, /type/],
    [{ queryKey: 'nope' }, /不存在的查询/],
    [{ params: { period: '$filter.period' } }, /只能写固定值/],
    [{ params: { foo: 1 } }, /「foo」不是查询/],
    [{ encoding: { value: 'Amount' } }, /dimension/],
    [{ encoding: { dimension: 'Customer', value: 'Amount' } }, /列「Customer」不在/],
    [{ encoding: { dimension: 'a;b', value: 'v' } }, /列名非法/],
    [{ encoding: { dimension: 'CardName', value: 'Amount', format: 'bytes' } }, /format/],
    [{ type: 'kpi', encoding: {} }, /KPI/],
    [{ drill: [{ queryKey: 'nope' }] }, /下钻.*不存在的查询/],
    [{ drill: [{ queryKey: 'sales_docs', type: 'kpi' }] }, /下钻 type/],
    [{ drill: [{ queryKey: 'sales_docs', bind: { cardCode: 'x y' } }] }, /bind/],
    [{ drill: [{ queryKey: 'sales_docs', bind: { cardCode: 'Nope' } }] }, /取值列「Nope」/],
    [{ drill: [{ queryKey: 'sales_docs', params: { period: '$filter.period' } }] }, /只能写固定值/],
  ];
  for (const [patch, re] of cases) {
    const r = validateChartInput({ ...chartInput, ...patch }, queries);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, re, JSON.stringify(patch));
  }
});

const chart = validateChartInput(chartInput, queries).value;
const filters = [{ name: 'period', type: 'month' }, { name: 'TOP', type: 'string' }, { name: 'cardcode', type: 'string' }];

test('展开：同名筛选自动绑定（大小写不敏感）；图表固定值优先于筛选；看板覆盖优先于一切', () => {
  const card = resolveCard({ id: 'c1' }, chart, filters, queries);
  assert.deepEqual(card.params, { top: 10, period: '$filter.period' }, 'top 由图表固定，不被同名筛选 TOP 覆盖；slpCode 无同名筛选不传');
  assert.equal(card.title, chart.label);
  assert.deepEqual(card.layout, chart.size);
  assert.equal(card.chartKey, 'sales_top_cust');

  const over = resolveCard({ id: 'c1', title: '大客户', params: { TOP: 5, slpCode: '$filter.period' }, layout: { w: 12, h: 3 } }, chart, filters, queries);
  assert.deepEqual(over.params, { period: '$filter.period', TOP: 5, slpCode: '$filter.period' }, '覆盖按大小写不敏感替换图表固定值');
  assert.equal(over.title, '大客户');
  assert.deepEqual(over.layout, { w: 12, h: 3 });
});

test('展开：下钻参数优先取上一级点中行（bind），其次同名筛选', () => {
  const card = resolveCard({ id: 'c1' }, chart, filters, queries);
  assert.deepEqual(card.drill[0].bind, { cardCode: 'CardCode' });
  assert.deepEqual(card.drill[0].params, { Period: '$filter.period' }, 'cardCode 已由 bind 提供，不绑定同名筛选 cardcode');
  const over = resolveCard({ id: 'c1', params: { period: '2026-09', cardCode: 'X' } }, chart, filters, queries);
  assert.deepEqual(over.drill[0].params, { period: '2026-09' }, '看板覆盖也作用于下钻同名参数，但不压过 bind');
});

test('展开整板：引用缺失 / 停用的图表跳过并计数', () => {
  const charts = [chart, { ...chart, chartKey: 'off', enabled: false }];
  const d = expandDashboard({ filters, cards: [{ id: 'a', chartKey: 'sales_top_cust' }, { id: 'b', chartKey: 'off' }, { id: 'c', chartKey: 'ghost' }] }, charts, queries);
  assert.deepEqual(d.cards.map((c) => c.id), ['a']);
  assert.equal(d.missingCharts, 2);
});

test('看板保存：必填参数既无同名筛选也无覆盖 → 报错；加上筛选即通过', () => {
  const ctx = { charts: new Map([[chart.chartKey, chart]]), queries };
  const dash = { dashboardKey: 'sales', label: '销售', cards: [{ chartKey: 'sales_top_cust' }] };
  const bad = validateDashboardInput({ ...dash, filters: [] }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /必填参数「period」没有取值来源/);
  assert.equal(validateDashboardInput({ ...dash, filters: [{ name: 'period', type: 'month' }] }, ctx).ok, true);
  assert.equal(validateDashboardInput({ ...dash, filters: [], cards: [{ chartKey: 'sales_top_cust', params: { period: '2026-09' } }] }, ctx).ok, true, '也可在看板里写固定值');
});
