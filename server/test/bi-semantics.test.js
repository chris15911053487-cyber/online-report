const test = require('node:test');
const assert = require('node:assert/strict');

const { validateQueryInput, normalizeColumns } = require('../src/bi-queries');
const { validateDashboardInput, checkDashboardRefs } = require('../src/bi-dashboards');
const { validateChartInput } = require('../src/bi-charts');

const baseQuery = {
  queryKey: 'fin_ar',
  label: '应收',
  sqlText: 'SELECT CardCode, CardName, Balance FROM T WHERE Period = @period',
  params: [{ name: 'period', type: 'string', required: true }],
};

test('列语义：校验角色/格式/缩放，并由维度列推导 dimensions', () => {
  const r = validateQueryInput({
    ...baseQuery,
    columns: [
      { column: 'CardCode', label: '客户编码', role: 'attr' },
      { column: 'CardName', label: '客户', role: 'dimension' },
      { column: 'Balance', label: '余额', role: 'measure', format: 'money', unit: '万', scale: 10000 },
    ],
    dimensions: [{ column: 'Ignored' }],
    sampleQuestions: ['哪些客户欠款最多？', ' ', '哪些客户欠款最多？'],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.dimensions, [{ column: 'CardName', label: '客户' }]);
  assert.equal(r.value.columns[2].scale, 10000);
  assert.deepEqual(r.value.sampleQuestions, ['哪些客户欠款最多？']);
});

test('列语义：未登记列时沿用手填 dimensions（兼容旧数据）', () => {
  const r = validateQueryInput({ ...baseQuery, dimensions: [{ column: 'CardName' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.columns, []);
  assert.equal(r.value.dimensions[0].column, 'CardName');
});

test('列语义：非法输入报错', () => {
  assert.equal(normalizeColumns([{ column: 'A', role: 'x' }]).ok, false);
  assert.equal(normalizeColumns([{ column: 'A' }, { column: 'A' }]).ok, false);
  assert.equal(normalizeColumns([{ column: 'A', scale: -1 }]).ok, false);
  assert.equal(normalizeColumns([{ column: 'A', format: 'pct' }]).ok, false);
});

const queries = new Map([
  ['fin_ar', { label: '应收', params: [{ name: 'period', required: true }], columns: [{ column: 'CardCode' }, { column: 'CardName' }, { column: 'Balance' }] }],
  ['fin_docs', { label: '单据', params: [{ name: 'period', required: true }, { name: 'cardCode', required: true }], columns: [{ column: 'DocNum' }] }],
  ['legacy', { label: '旧查询', params: [], columns: [] }],
]);

const goodCard = {
  id: 'c1',
  type: 'bar',
  title: '按客户',
  queryKey: 'fin_ar',
  params: { period: '$filter.period' },
  encoding: { dimension: 'CardName', value: 'Balance' },
  drill: [{ queryKey: 'fin_docs', label: '单据', bind: { cardCode: 'CardCode' }, params: { period: '$filter.period' }, type: 'table' }],
};
const filters = [{ name: 'period', label: '期间', type: 'month' }];

test('引用完整性：配置正确时通过（图表 → 看板引用，期间由同名筛选自动提供）', () => {
  const { params: _p, drill, ...rest } = goodCard;
  const chart = validateChartInput({ ...rest, chartKey: 'ar_by_cust', label: '按客户', drill: [{ ...drill[0], params: {} }] }, queries);
  assert.equal(chart.ok, true, chart.error);
  const charts = new Map([['ar_by_cust', chart.value]]);
  const r = validateDashboardInput({ dashboardKey: 'fin', label: '财务', filters, cards: [{ chartKey: 'ar_by_cust' }] }, { charts, queries });
  assert.equal(r.ok, true, r.error);
});

test('引用完整性：列不存在、参数不存在、必填参数无来源、bind 列不在上一级', () => {
  const card = {
    ...goodCard,
    params: { period: '$filter.period', foo: 1 },
    encoding: { dimension: 'Customer', value: 'Balance' },
    drill: [{ ...goodCard.drill[0], bind: { cardcode: 'NoSuchCol' }, params: {} }],
  };
  const problems = checkDashboardRefs({ cards: [card] }, queries);
  const text = problems.join('\n');
  assert.match(text, /「foo」不是查询「应收」的参数/);
  assert.match(text, /列「Customer」不在查询「应收」的输出列中/);
  assert.match(text, /取值列「NoSuchCol」不在上一级查询/);
  assert.match(text, /必填参数「period」没有取值来源/);
  assert.doesNotMatch(text, /cardCode.*没有取值来源/);
});

test('引用完整性：未登记输出列的旧查询跳过列检查；只传 Set 时不做完整性检查', () => {
  const card = { id: 'k', type: 'kpi', title: 'K', queryKey: 'legacy', encoding: { value: 'Anything' } };
  assert.deepEqual(checkDashboardRefs({ cards: [card] }, queries), []);
  const bad = { ...goodCard, label: '按客户', chartKey: 'x', encoding: { dimension: 'Customer', value: 'Balance' }, params: {}, drill: [{ ...goodCard.drill[0], params: {} }] };
  assert.equal(validateChartInput(bad, new Set(['fin_ar', 'fin_docs'])).ok, true);
  assert.match(validateChartInput(bad, queries).error, /Customer/);
});
