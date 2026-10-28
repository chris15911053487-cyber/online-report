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

test('图表校验：下钻打开方式 open 可选，不写时不落库', () => {
  const r = validateChartInput(chartInput, queries);
  assert.equal('open' in r.value.drill[0], false);
  const p = validateChartInput({ ...chartInput, drill: [{ ...chartInput.drill[0], open: 'inline' }] }, queries);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.value.drill[0].open, 'inline');
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
    [{ drill: [{ queryKey: 'sales_docs', open: 'popup' }] }, /open 须为/],
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
  // 年份筛选 + 今年 / 去年记号；未知记号报错
  const yr = validateDashboardInput({ ...dash, filters: [{ name: 'period', type: 'month' }, { name: 'year', type: 'year', default: '$lastYear' }] }, ctx);
  assert.equal(yr.ok, true, yr.error);
  assert.match(validateDashboardInput({ ...dash, filters: [{ name: 'period', type: 'month', default: '$nextYear' }] }, ctx).error, /默认值记号不支持：\$nextYear/);
  assert.equal(validateDashboardInput({ ...dash, filters: [], cards: [{ chartKey: 'sales_top_cust', params: { period: '2026-09' } }] }, ctx).ok, true, '也可在看板里写固定值');
});

test('图表校验：encoding.labels 只接受 show / hide，auto 视为不写', () => {
  const enc = (labels) => validateChartInput({ ...chartInput, encoding: { ...chartInput.encoding, labels } }, queries);
  assert.equal(enc('show').value.encoding.labels, 'show');
  assert.equal(enc('hide').value.encoding.labels, 'hide');
  assert.equal(enc('auto').value.encoding.labels, undefined);
  assert.equal(enc('value').ok, false);
  const pie = (labels) => validateChartInput({ ...chartInput, type: 'pie', encoding: { ...chartInput.encoding, labels } }, queries);
  assert.equal(pie('value').value.encoding.labels, 'value');
  assert.equal(pie('both').value.encoding.labels, 'both');
  assert.equal(pie('hide').value.encoding.labels, 'hide');
  assert.equal(pie('show').ok, false);
  assert.equal(enc('always').ok, false);
});

test('图表校验：右轴（柱线组合）只能放数值列的一部分；系列列 / 横向 / 饼图不能用', () => {
  const q = new Map([['yoy', {
    queryKey: 'yoy', label: '同比', params: [],
    columns: [{ column: '月份', role: 'time' }, { column: '本期', role: 'measure' }, { column: '对比期', role: 'measure' }, { column: '增长率', role: 'measure', format: 'percent' }],
  }]]);
  const base = { chartKey: 'yoy_trend', label: '月度同比', type: 'bar', queryKey: 'yoy', params: {} };
  const run = (encoding, type = 'bar') => validateChartInput({ ...base, type, encoding }, q);
  const ok = run({ dimension: '月份', values: ['本期', '对比期', '增长率'], rightAxis: ['增长率', '增长率'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.encoding.rightAxis, ['增长率'], '去重');
  assert.equal(run({ dimension: '月份', values: ['本期', '增长率'], rightAxis: ['增长率'] }, 'line').ok, true, '折线也可以');
  assert.match(run({ dimension: '月份', values: ['本期'], rightAxis: ['增长率'] }).error, /须是数值列之一/);
  assert.match(run({ dimension: '月份', values: ['本期', '增长率'], rightAxis: ['本期', '增长率'] }).error, /至少留一个数值列在左轴/);
  assert.match(run({ dimension: '月份', values: ['本期', '增长率'], rightAxis: ['增长率'], series: '本期' }).error, /系列列/);
  assert.match(run({ dimension: '月份', values: ['本期', '增长率'], rightAxis: ['增长率'], horizontal: true }).error, /横向/);
  assert.match(run({ dimension: '月份', value: '本期', rightAxis: ['本期'] }, 'pie').error, /只有柱状/);
});

test('图表校验：堆叠只用于柱状图，且要有两个以上柱状数值列或系列列', () => {
  const q = new Map([['yoy', {
    queryKey: 'yoy', label: '同比', params: [],
    columns: [{ column: '月份', role: 'time' }, { column: '本期', role: 'measure' }, { column: '对比期', role: 'measure' }, { column: '增长率', role: 'measure', format: 'percent' }],
  }]]);
  const base = { chartKey: 'yoy_stack', label: '堆叠', type: 'bar', queryKey: 'yoy', params: {} };
  const run = (encoding, type = 'bar') => validateChartInput({ ...base, type, encoding }, q);
  assert.equal(run({ dimension: '月份', values: ['本期', '对比期'], stack: 'normal' }).value.encoding.stack, 'normal');
  assert.equal(run({ dimension: '月份', values: ['本期', '对比期'], stack: true }).value.encoding.stack, 'normal', 'true 视为 normal');
  assert.equal(run({ dimension: '月份', value: '本期', series: '增长率', stack: 'percent' }).value.encoding.stack, 'percent', '系列列透视可堆叠');
  assert.equal(run({ dimension: '月份', values: ['本期', '对比期'], stack: false }).value.encoding.stack, undefined);
  assert.match(run({ dimension: '月份', values: ['本期', '对比期'], stack: 'up' }).error, /stack 须为/);
  assert.match(run({ dimension: '月份', value: '本期', stack: 'normal' }).error, /至少两个/);
  assert.match(run({ dimension: '月份', values: ['本期', '增长率'], rightAxis: ['增长率'], stack: 'normal' }).error, /至少两个/, '右轴的列不算');
  assert.match(run({ dimension: '月份', values: ['本期', '对比期'], stack: 'normal' }, 'line').error, /只有柱状图/);
});

test('图表校验：瀑布图一个数值列，可设末尾合计 / 小计；合计 / 小计只用于瀑布图', () => {
  const q = new Map([['pl', {
    queryKey: 'pl', label: '利润表', params: [],
    columns: [{ column: '项目', role: 'dimension' }, { column: '金额', role: 'measure' }, { column: '去年', role: 'measure' }],
  }]]);
  const base = { chartKey: 'pl_waterfall', label: '收入到利润', type: 'waterfall', queryKey: 'pl', params: {} };
  const run = (encoding, type = 'waterfall') => validateChartInput({ ...base, type, encoding }, q);
  const ok = run({ dimension: '项目', value: '金额', total: ' 营业利润 ', subtotals: ['毛利', '毛利', ''], trend: 'up-bad' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.value.encoding.total, '营业利润');
  assert.deepEqual(ok.value.encoding.subtotals, ['毛利'], '去重、去空');
  assert.equal(ok.value.size.w, 8, '默认 2/3 宽');
  assert.match(run({ value: '金额' }).error, /dimension/);
  assert.match(run({ dimension: '项目', values: ['金额', '去年'] }).error, /只能选一个数值列/);
  assert.match(run({ dimension: '项目', value: '金额', series: '去年' }).error, /需要选横向/);
  const panels = run({ dimension: '项目', value: '金额', series: '去年', horizontal: true });
  assert.equal(panels.ok, true, panels.error);
  assert.equal(panels.value.encoding.horizontal, true, '横向瀑布图可按分栏列拆开');
  assert.match(run({ dimension: '项目', value: '金额', subtotals: '毛利' }).error, /subtotals 须为/);
  assert.match(run({ dimension: '项目', value: '金额', total: '合计' }, 'bar').error, /只有瀑布图/);
  assert.match(run({ dimension: '项目', value: 'Ghost' }).error, /Ghost/, '数值列须在输出列中');
});

test('图表校验：表格数据条列（可设各列同一比例）；引用检查包含数据条列', () => {
  const t = validateChartInput({ ...chartInput, type: 'table', drill: [], encoding: { barColumns: ['Amount', 'Amount'], barShared: 1 } }, queries);
  assert.equal(t.ok, true, t.error);
  assert.deepEqual(t.value.encoding.barColumns, ['Amount']);
  assert.equal(t.value.encoding.barShared, true);
  const bad = validateChartInput({ ...chartInput, type: 'table', drill: [], encoding: { barColumns: ['Ghost'] } }, queries);
  assert.match(bad.error, /Ghost/);
});

test('图表校验：涨跌着色列 / 涨跌颜色；引用检查包含这些列', () => {
  const t = validateChartInput({ ...chartInput, type: 'table', drill: [], encoding: { deltaColumns: ['Amount'], trend: 'up-bad' } }, queries);
  assert.equal(t.ok, true);
  assert.deepEqual(t.value.encoding.deltaColumns, ['Amount']);
  assert.equal(t.value.encoding.trend, 'up-bad');
  assert.match(validateChartInput({ ...chartInput, encoding: { ...chartInput.encoding, trend: 'down' } }, queries).error, /trend 须为/);
  const { checkCardRefs } = require('../src/bi-charts');
  const problems = checkCardRefs({ queryKey: 'sales_by_cust', params: { period: 'x' }, encoding: { deltaColumns: ['Ghost'] }, drill: [] }, queries, '卡片');
  assert.match(problems.join(), /列「Ghost」不在查询/);
});
