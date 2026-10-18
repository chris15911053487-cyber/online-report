const test = require('node:test');
const assert = require('node:assert/strict');
const { coerceParam, resolveParams, optionsFromRows, optionsQueryProblems, BiParamError } = require('../src/bi-params');
const { normalizeParamDefs, validateQueryInput } = require('../src/bi-queries');
const { executeQuery } = require('../src/bi-exec');
const { normalizeParamMap, checkCardRefs } = require('../src/bi-charts');
const { validateDashboardInput } = require('../src/bi-dashboards');
const { filterDisplayText } = require('../src/bi-tokens');
const { formatQueryCatalog } = require('../src/agent-context');
const { normalizeBiContext } = require('../src/bi-context');

const cmp = { name: 'cmp', type: 'string', label: '对比方式', options: [{ value: 'yoy', label: '同比' }, { value: 'mom', label: '环比' }] };
// 2026-10-18 12:00 中国时间
const NOW = Date.UTC(2026, 9, 18, 4);

test('可选值：传错值直接报错并列出可选值（不会悄悄落进 SQL 的 ELSE 分支）', () => {
  assert.equal(coerceParam(cmp, 'mom').value, 'mom');
  assert.throws(() => coerceParam(cmp, '同比'), /「同比」不在可选值中，可选：yoy（同比）、mom（环比）/);
  assert.throws(() => coerceParam(cmp, 'MoM'), BiParamError);
  const n = { name: 'lvl', type: 'number', options: [{ value: 1, label: '一级' }, { value: 2, label: '二级' }] };
  assert.equal(coerceParam(n, '2').value, 2);
  assert.throws(() => coerceParam(n, 3), /不在可选值中/);
});

test('月份：多种写法规范成 YYYY-MM；非法月份拒绝；$thisMonth / $lastMonth 按中国日期解析', () => {
  const m = { name: 'period', type: 'month' };
  for (const s of ['2026-09', '2026-9', '2026/09', '2026.9', '202609', '2026-09-15']) assert.equal(coerceParam(m, s).value, '2026-09', s);
  for (const s of ['2026-13', '2026', '26-09', 'abc', '2026-00']) assert.throws(() => coerceParam(m, s), /须为月份/, s);
  assert.equal(coerceParam(m, '$thisMonth', NOW).value, '2026-10');
  assert.equal(coerceParam(m, '$lastMonth', NOW).value, '2026-09');
});

test('多选：数组 / JSON 文本 / 逗号顿号分隔都接受，去空去重；空 = NULL（不限）；可选值逐项核对', () => {
  const l = { name: 'whs', type: 'list' };
  assert.deepEqual(coerceParam(l, ['01', '02', '01', '']).value, ['01', '02']);
  assert.deepEqual(coerceParam(l, '["01","02"]').value, ['01', '02']);
  assert.deepEqual(coerceParam(l, '01, 02、03；04').value, ['01', '02', '03', '04']);
  assert.deepEqual(coerceParam(l, 7).value, ['7']);
  assert.equal(coerceParam(l, []).value, null);
  assert.equal(coerceParam(l, ' , ').value, null);
  assert.throws(() => coerceParam(l, [{ a: 1 }]), /简单值/);
  assert.throws(() => coerceParam(l, Array.from({ length: 201 }, (_, i) => String(i))), /最多选 200 项/);
  const lo = { ...l, options: [{ value: '01', label: '一号仓' }, { value: '02', label: '二号仓' }] };
  assert.deepEqual(coerceParam(lo, ['02']).value, ['02']);
  assert.throws(() => coerceParam(lo, ['01', '09']), /「09」不在可选值中/);
  // 文本参数收到数组：提示改成多选
  assert.throws(() => coerceParam({ name: 's', type: 'string' }, ['a']), /多选/);
});

test('数字范围与年份记号', () => {
  const top = { name: 'top', type: 'number', min: 1, max: 100 };
  assert.equal(coerceParam(top, '20').value, 20);
  assert.throws(() => coerceParam(top, 0), /不能小于 1/);
  assert.throws(() => coerceParam(top, 101), /不能大于 100/);
  assert.equal(coerceParam({ name: 'year', type: 'number' }, '$lastYear', NOW).value, 2025);
  assert.equal(coerceParam({ name: 'd', type: 'date' }, '$monthStart', NOW).value, '2026-10-01');
  // 文本参数不解析记号（原样当文本）
  assert.equal(coerceParam({ name: 's', type: 'string' }, '$today').value, '$today');
});

test('resolveParams：默认值记号运行时解析；空数组视为未传', () => {
  const defs = [{ name: 'period', type: 'month', default: '$thisMonth' }, { name: 'whs', type: 'list', default: ['01'] }];
  assert.deepEqual(resolveParams(defs, { whs: [] }, NOW), { period: '2026-10', whs: ['01'] });
  assert.deepEqual(resolveParams(defs, { period: '2026-9', whs: '02,03' }, NOW), { period: '2026-09', whs: ['02', '03'] });
});

test('参数定义校验：约束只用于合适的类型；默认值按约束检查；记号须匹配类型', () => {
  const ok = normalizeParamDefs([
    { ...cmp, default: 'yoy' },
    { name: 'period', type: 'month', required: true, default: '$lastMonth' },
    { name: 'whs', type: 'list', options: ['01', { value: '02', label: '二号仓' }], default: '01,02' },
    { name: 'top', type: 'number', min: '1', max: 100, default: 10 },
    { name: 'card', type: 'string', optionsQuery: { queryKey: 'Customers', valueColumn: 'CardCode', labelColumn: 'CardName' } },
  ]);
  assert.equal(ok.ok, true, ok.error);
  const [c, p, w, t, card] = ok.value;
  assert.equal(c.default, 'yoy');
  assert.equal(p.default, '$lastMonth', '记号原样保存，运行时按当天解析');
  assert.deepEqual(w.options, [{ value: '01', label: '01' }, { value: '02', label: '二号仓' }]);
  assert.deepEqual(w.default, ['01', '02']);
  assert.deepEqual([t.min, t.max], [1, 100]);
  assert.deepEqual(card.optionsQuery, { queryKey: 'customers', valueColumn: 'CardCode', labelColumn: 'CardName' });

  const bad = (def, re) => {
    const r = normalizeParamDefs([def]);
    assert.equal(r.ok, false, JSON.stringify(def));
    assert.match(r.error, re);
  };
  bad({ name: 'd', type: 'date', options: ['2026-01-01'] }, /只有文本 \/ 数字 \/ 多选参数能设置可选值/);
  bad({ name: 's', type: 'string', options: ['a'], optionsQuery: { queryKey: 'x', valueColumn: 'c' } }, /只能选一种/);
  bad({ name: 'n', type: 'number', options: ['a'] }, /须为数字/);
  bad({ name: 's', type: 'string', options: ['a', 'a'] }, /重复/);
  bad({ name: 's', type: 'string', min: 1 }, /只有数字参数能设置范围/);
  bad({ name: 'n', type: 'number', min: 10, max: 1 }, /最小值不能大于最大值/);
  bad({ ...cmp, default: 'xx' }, /默认值.*不在可选值中/);
  bad({ name: 'top', type: 'number', max: 5, default: 10 }, /默认值.*不能大于 5/);
  bad({ name: 'period', type: 'month', default: '$today' }, /\$today 不适用于该类型（可用 \$thisMonth \$lastMonth）/);
  bad({ name: 's', type: 'string', default: ['a'] }, /默认值须为简单值/);
  bad({ name: 's', type: 'string', optionsQuery: { queryKey: 'x' } }, /取值列/);
});

test('validateQueryInput：选项不能来自本查询', () => {
  const r = validateQueryInput({
    queryKey: 'customers',
    label: '客户',
    sqlText: 'SELECT CardCode FROM OCRD WHERE CardCode = @c',
    params: [{ name: 'c', type: 'string', optionsQuery: { queryKey: 'customers', valueColumn: 'CardCode' } }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /不能来自本查询/);
});

test('来自查询的选项：按取值去重保持顺序，显示列为空时用取值；来源检查', () => {
  const rows = [
    { CardCode: 'C1', CardName: '甲' },
    { CardCode: 'C2', CardName: null },
    { CardCode: 'C1', CardName: '甲（重复）' },
    { CardCode: null, CardName: '空' },
  ];
  assert.deepEqual(optionsFromRows(rows, 'CardCode', 'CardName'), { options: [{ value: 'C1', label: '甲' }, { value: 'C2', label: 'C2' }], truncated: false });
  const many = Array.from({ length: 600 }, (_, i) => ({ v: i }));
  const r = optionsFromRows(many, 'v');
  assert.equal(r.options.length, 500);
  assert.equal(r.truncated, true);
  assert.equal(r.options[1].value, 1, '数字保持数字');

  const queries = new Map([
    ['customers', { label: '客户', params: [], columns: [{ column: 'CardCode' }, { column: 'CardName' }] }],
    ['by_period', { label: '按期间', params: [{ name: 'period', required: true }], columns: [] }],
  ]);
  const p = (oq) => optionsQueryProblems([{ name: 'c', optionsQuery: oq }], queries);
  assert.deepEqual(p({ queryKey: 'customers', valueColumn: 'CardCode', labelColumn: 'CardName' }), []);
  assert.match(p({ queryKey: 'nope', valueColumn: 'x' })[0], /不存在/);
  assert.match(p({ queryKey: 'by_period', valueColumn: 'x' })[0], /有必填参数（period）/);
  assert.match(p({ queryKey: 'customers', valueColumn: 'Code' })[0], /列「Code」不在/);
});

test('executeQuery：多选绑定为 JSON 数组文本，月份绑定为文本', async () => {
  const inputs = [];
  const handlers = {};
  const request = {
    input: (name, type, value) => { inputs.push([name, value]); return request; },
    on: (ev, fn) => { handlers[ev] = fn; return request; },
    cancel: () => {},
    query: () => setImmediate(() => { handlers.recordset({}); handlers.done(); }),
  };
  const q = { queryKey: 'q', sqlText: 'SELECT 1', params: [{ name: 'whs', type: 'list' }, { name: 'none', type: 'list' }, { name: 'period', type: 'month' }] };
  await executeQuery({ request: () => request }, q, { whs: ['01', '0"2'], none: null, period: '2026-09' });
  assert.deepEqual(inputs, [['whs', '["01","0\\"2"]'], ['none', null], ['period', '2026-09']]);
});

test('卡片参数：多选可写数组固定值；固定值按参数约束检查；多选筛选只能传给多选参数', () => {
  assert.equal(normalizeParamMap({ whs: ['01', '02'] }, null, 'x').ok, true);
  assert.equal(normalizeParamMap({ whs: [{ a: 1 }] }, null, 'x').ok, false);

  const queries = new Map([
    ['sales', { label: '销售', params: [cmp, { name: 'whs', type: 'list' }, { name: 'cust', type: 'string' }, { name: 'top', type: 'number', max: 50 }], columns: [] }],
  ]);
  const card = (params) => ({ queryKey: 'sales', params, encoding: {}, drill: [] });
  const filters = [
    { name: 'whsF', label: '仓库', type: 'select', multiple: true },
    { name: 'custF', label: '客户', type: 'select', multiple: true },
  ];
  assert.deepEqual(checkCardRefs(card({ cmp: 'mom', whs: '$filter.whsF' }), queries, 'c', { filters }), []);
  const probs = checkCardRefs(card({ cmp: '同比', top: 99, cust: '$filter.custF' }), queries, 'c', { filters });
  assert.equal(probs.length, 3);
  assert.match(probs[0], /「同比」不在可选值中/);
  assert.match(probs[1], /不能大于 50/);
  assert.match(probs[2], /筛选「客户」是多选，参数「cust」不是多选参数/);
});

test('看板筛选：多选 / 选项来自查询', () => {
  const base = { dashboardKey: 'd', label: '看板', cards: [] };
  const r = validateDashboardInput({
    ...base,
    filters: [
      { name: 'whs', type: 'select', multiple: true, options: ['01', '02'], default: ['01'] },
      { name: 'cust', type: 'select', optionsQuery: { queryKey: 'Customers', valueColumn: 'CardCode', labelColumn: 'CardName' } },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value.filters[0].default, ['01']);
  assert.deepEqual(r.value.filters[1].optionsQuery, { queryKey: 'customers', valueColumn: 'CardCode', labelColumn: 'CardName' });
  assert.equal(r.value.filters[1].options, undefined);
  const bad = (f, re) => {
    const x = validateDashboardInput({ ...base, filters: [f] });
    assert.equal(x.ok, false);
    assert.match(x.error, re);
  };
  bad({ name: 'm', type: 'month', multiple: true }, /只有下拉能多选/);
  bad({ name: 's', type: 'select', default: ['a'], options: ['a'] }, /默认值须为简单值/);
  bad({ name: 's', type: 'select' }, /options 或 optionsQuery/);
});

test('占位符显示：多选列出前 3 项', () => {
  const filters = [{ name: 'whs', type: 'select', multiple: true, options: [{ value: '01', label: '一号仓' }, { value: '02', label: '二号仓' }] }];
  assert.deepEqual(filterDisplayText(filters, { whs: ['01', '02'] }), { whs: '一号仓、二号仓' });
  assert.deepEqual(filterDisplayText(filters, { whs: ['01', '02', '03', '04'] }), { whs: '一号仓、二号仓、03 等 4 项' });
  assert.deepEqual(filterDisplayText(filters, { whs: [] }), {});
});

test('AI 查询目录：写明可选值、月份格式、多选传法与范围', () => {
  const text = formatQueryCatalog([
    {
      queryKey: 'sales_yoy',
      label: '销售同比',
      sqlText: 'SELECT 1',
      params: [
        { ...cmp, default: 'yoy' },
        { name: 'period', type: 'month', required: true },
        { name: 'whs', type: 'list' },
        { name: 'top', type: 'number', min: 1, max: 100, default: 10 },
        { name: 'card', type: 'string', optionsQuery: { queryKey: 'customers', valueColumn: 'CardCode' } },
      ],
    },
  ]);
  assert.match(text, /cmp:string=yoy，可选 yoy\(同比\)\|mom\(环比\)/);
  assert.match(text, /period:month\(YYYY-MM\)（必填）/);
  assert.match(text, /whs:list\(多个值传数组，不传=全部\)/);
  assert.match(text, /top:number\[1~100\]=10/);
  assert.match(text, /card:string，取值为查询 customers 的 CardCode 列/);
});

test('看板点击上下文：多选参数保留为数组，对象丢弃', () => {
  const ctx = normalizeBiContext({ cardTitle: '库存', params: { whs: ['01', '02'], bad: [{ a: 1 }], obj: { a: 1 }, period: '2026-09' } });
  assert.deepEqual(ctx.params, { whs: ['01', '02'], period: '2026-09' });
});
