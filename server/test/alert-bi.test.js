const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBiCheck, evaluateBiCheck, describeBiCheck, draftAlertRule, evaluateForEvents, resolveEventRefs, usesEventRefs } = require('../src/alert-bi');

const Q = {
  queryKey: 'sales_by_customer',
  label: '客户销售额',
  enabled: true,
  params: [{ name: 'period', type: 'string', required: true }, { name: 'top', type: 'number', default: 10 }],
  columns: [
    { column: 'CardCode', label: '客户编码', role: 'attr' },
    { column: 'CardName', label: '客户', role: 'dimension' },
    { column: 'Period', label: '月份', role: 'time' },
    { column: 'Amount', label: '销售额', role: 'measure', format: 'money' },
  ],
  sampleQuestions: ['谁买得最多'],
};
// 2026-09-15 10:00 中国时间
const NOW = Date.UTC(2026, 8, 15, 2, 0);

test('normalizeBiCheck：参数 / 列 / 运算符 / 动态值 / 必填 / 环比须有 compare', () => {
  const ok = normalizeBiCheck({ queryKey: 'SALES_BY_CUSTOMER', params: { PERIOD: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<', value: '10000' }] }, Q);
  assert.deepEqual(ok, { ok: true, value: { queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<', value: 10000 }], match: 'all' } });
  const bad = (check, re) => assert.match(normalizeBiCheck({ queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<', value: 1 }], ...check }, Q).error, re);
  bad({ params: { nope: 1, period: '$thisMonth' } }, /没有参数 @nope/);
  bad({ params: {} }, /必填参数 @period/);
  bad({ params: { period: '$nextMonth' } }, /动态值「\$nextMonth」不认识/);
  bad({ conditions: [] }, /至少要有一个/);
  bad({ conditions: [{ column: 'Ghost', op: '<', value: 1 }] }, /不在查询输出列中/);
  bad({ conditions: [{ column: 'Amount', op: '<>', value: 1 }] }, /运算符/);
  bad({ conditions: [{ column: 'Amount', op: '<', value: 'abc' }] }, /须为数字/);
  bad({ conditions: [{ column: 'Amount', op: '<=', value: -20, change: 'pct' }] }, /compare\.param/);
  const withCmp = normalizeBiCheck({ queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<=', value: -20, change: 'pct' }], compare: { param: 'Period' } }, Q);
  assert.deepEqual(withCmp.value.compare, { param: 'period', shift: -1, by: [] });
});

test('evaluateBiCheck：阈值；动态值按中国日期解析', async () => {
  const calls = [];
  const run = async (p) => {
    calls.push(p);
    return { rows: [{ CardCode: 'C1', Amount: 5000 }, { CardCode: 'C2', Amount: 20000 }, { CardCode: 'C3', Amount: null }] };
  };
  const r = await evaluateBiCheck({ queryKey: 'q', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<', value: 10000 }], match: 'all' }, Q, run, NOW);
  assert.deepEqual(calls, [{ period: '2026-09' }]);
  assert.deepEqual(r.matched.map((x) => x.CardCode), ['C1']);
  assert.equal(r.total, 3);
});

test('evaluateBiCheck：环比按维度 / 属性列对齐（不含时间列），补 _prev / _change / _change_pct；上期为 0 不命中', async () => {
  const data = {
    '2026-09': [{ CardCode: 'C1', CardName: '甲', Period: '2026-09', Amount: 70 }, { CardCode: 'C2', CardName: '乙', Period: '2026-09', Amount: 100 }, { CardCode: 'C3', CardName: '丙', Period: '2026-09', Amount: 5 }, { CardCode: 'C4', CardName: '丁', Period: '2026-09', Amount: 1 }],
    '2026-08': [{ CardCode: 'C2', CardName: '乙', Period: '2026-08', Amount: 90 }, { CardCode: 'C1', CardName: '甲', Period: '2026-08', Amount: 100 }, { CardCode: 'C4', CardName: '丁', Period: '2026-08', Amount: 0 }],
  };
  const check = normalizeBiCheck({ queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<=', value: -20, change: 'pct' }], compare: { param: 'period' } }, Q).value;
  const r = await evaluateBiCheck(check, Q, async (p) => ({ rows: data[p.period] }), NOW);
  assert.deepEqual(r.prevParams, { period: '2026-08' });
  assert.deepEqual(r.matched.map((x) => [x.CardCode, x.Amount_prev, x.Amount_change, x.Amount_change_pct]), [['C1', 100, -30, -30]]);
});

test('evaluateBiCheck：单行 KPI 按位置对齐；any', async () => {
  const check = { queryKey: 'k', params: { year: '$thisYear' }, conditions: [{ column: 'Total', op: '>', value: 1e9 }, { column: 'Total', op: '<', value: 0, change: 'abs' }], match: 'any', compare: { param: 'year', shift: -1, by: [] } };
  const r = await evaluateBiCheck(check, { columns: [] }, async (p) => ({ rows: [{ Total: p.year === '2026' ? 80 : 100 }] }), NOW);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].Total_change, -20);
  assert.deepEqual(r.prevParams, { year: '2025' });
});

test('describeBiCheck：中文描述', () => {
  const s = describeBiCheck({ queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<=', value: -20, change: 'pct' }, { column: 'Amount', op: '>', value: 0 }], match: 'all' }, Q);
  assert.equal(s, '查询「客户销售额」（period=$thisMonth）中，销售额较上期变化率小于等于 -20% 且 销售额大于 0的行');
});

test('draftAlertRule：目录带语义层；校验错误交回 AI 修正；返回草稿与试算结果', async () => {
  const replies = [
    { check: { queryKey: 'nope' } },
    { name: '客户销售下滑', cron: '0 9 * * *', keyColumn: 'CardCode', check: { queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<=', value: -20, change: 'pct' }] } },
    { name: '客户销售下滑', cron: '0 9 * * *', cooldownMinutes: 1440, cardTitle: '⚠️ {CardName} 销售下滑', cardBody: '- 本月 {Amount}（上月 {Amount_prev}）', check: { queryKey: 'sales_by_customer', params: { period: '$thisMonth' }, conditions: [{ column: 'Amount', op: '<=', value: -20, change: 'pct' }], compare: { param: 'period', shift: -1 } } },
  ];
  const calls = [];
  const llm = async (m) => {
    calls.push(m.map((x) => x.content));
    return JSON.stringify(replies.shift());
  };
  const run = async (_q, p) => ({ rows: p.period === '2026-09' ? [{ CardCode: 'C1', CardName: '甲', Amount: 50 }] : [{ CardCode: 'C1', CardName: '甲', Amount: 100 }] });
  const d = await draftAlertRule({ llm, queries: [Q, { ...Q, queryKey: 'off', enabled: false }], run, now: NOW }, '有客户本月销售额比上月降 20% 以上时每天 9 点提醒');
  assert.match(calls[0][1], /输出列：CardCode\(客户编码,属性\)/);
  assert.doesNotMatch(calls[0][1], /`off`/);
  assert.match(calls[1].at(-1), /queryKey「nope」不在可用命名查询中/);
  assert.match(calls[2].at(-1), /compare\.param/);
  assert.equal(d.attempts, 3);
  assert.equal(d.rule.cron_expr, '0 9 * * *');
  assert.equal(d.rule.key_column, 'CardCode', '没给去重列：自动取第一个维度 / 属性列');
  assert.equal(d.rule.cooldown_minutes, 1440);
  assert.equal(d.preview.matchedCount, 1);
  assert.equal(d.preview.matched[0].Amount_change_pct, -50);
  assert.match(d.summary, /销售额较上期变化率小于等于 -20%/);
  await assert.rejects(draftAlertRule({ llm, queries: [Q], run }, '短'), /一句话/);
  await assert.rejects(draftAlertRule({ llm, queries: [], run }, '销售下滑提醒我'), /还没有可用的命名查询/);
});

test('compare.mode = prevRow：趋势结果按时间列排序后与上一行比；无需期间参数；只查一次', async () => {
  const TQ = { queryKey: 'trend', label: '月趋势', enabled: true, params: [{ name: 'year', type: 'string', required: true }], columns: [{ column: 'Period', label: '月份', role: 'time' }, { column: 'NetSales', label: '净销售额', role: 'measure' }] };
  const cv = normalizeBiCheck({ queryKey: 'trend', params: { year: '$thisYear' }, conditions: [{ column: 'NetSales', op: '<=', value: -30, change: 'pct' }], compare: { mode: 'prevRow' } }, TQ);
  assert.deepEqual(cv.value.compare, { mode: 'prevRow', orderBy: 'Period' });
  let n = 0;
  const r = await evaluateBiCheck(cv.value, TQ, async () => {
    n += 1;
    return { rows: [{ Period: '2026-03', NetSales: 60 }, { Period: '2026-01', NetSales: 100 }, { Period: '2026-02', NetSales: 100 }] };
  }, NOW);
  assert.equal(n, 1);
  assert.deepEqual(r.matched.map((x) => [x.Period, x.NetSales_prev, x.NetSales_change_pct]), [['2026-03', 100, -40]]);
  assert.match(describeBiCheck(cv.value, TQ), /净销售额较上一行变化率小于等于 -30%/);
  assert.match(normalizeBiCheck({ ...cv.value, compare: { mode: 'prevRow', orderBy: 'Nope' } }, TQ).error, /orderBy/);
});

// ---- 事件触发 ----
const DQ = {
  queryKey: 'wo_defect', label: '工单不良率', enabled: true,
  params: [{ name: 'docEntry', type: 'number', required: true }],
  columns: [{ column: 'DocNum', label: '工单号', role: 'attr' }, { column: 'DefectRate', label: '不良率', role: 'measure', format: 'percent' }],
};

test('事件字段：$event.x 可作参数（算作已给值）；代入事件数据；未知事件字段为 null', () => {
  const cv = normalizeBiCheck({ queryKey: 'wo_defect', params: { docEntry: '$event.DocEntry' }, conditions: [{ column: 'DefectRate', op: '>', value: 0.05 }] }, DQ);
  assert.equal(cv.ok, true, cv.error);
  assert.equal(usesEventRefs(cv.value), true);
  assert.deepEqual(resolveEventRefs({ docEntry: '$event.DocEntry', x: '$event.Nope', y: 1 }, { DocEntry: 7 }), { docEntry: 7, x: null, y: 1 });
  assert.match(normalizeBiCheck({ queryKey: 'wo_defect', params: { docEntry: '$event.' }, conditions: [{ column: 'DefectRate', op: '>', value: 0 }] }, DQ).error, /不认识/);
});

test('evaluateForEvents：每条事件代入参数（相同参数只查一次），命中行合并事件字段（查询列优先）；无事件数据时报错', async () => {
  const check = normalizeBiCheck({ queryKey: 'wo_defect', params: { docEntry: '$event.DocEntry' }, conditions: [{ column: 'DefectRate', op: '>', value: 0.05 }] }, DQ).value;
  const calls = [];
  const run = async (p) => {
    calls.push(p.docEntry);
    return { rows: [{ DocNum: `WO${p.docEntry}`, DefectRate: p.docEntry === 1 ? 0.08 : 0.01, StepName: '查询里的' }] };
  };
  const rows = await evaluateForEvents(check, DQ, run, [{ DocEntry: 1, StepName: '装配', UserCode: 'U1' }, { DocEntry: 1, StepName: '装配' }, { DocEntry: 2 }], NOW);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(rows, [{ DocEntry: 1, StepName: '查询里的', UserCode: 'U1', DocNum: 'WO1', DefectRate: 0.08 }]);
  await assert.rejects(evaluateBiCheck(check, DQ, run, NOW), /只能用于事件触发规则/);
  // 定时规则（无事件引用）走原路径
  const cron = normalizeBiCheck({ queryKey: 'wo_defect', params: { docEntry: 1 }, conditions: [{ column: 'DefectRate', op: '>', value: 0.05 }] }, DQ).value;
  assert.equal((await evaluateForEvents(cron, DQ, run, null, NOW)).length, 1);
});

test('draftAlertRule：事件触发——只能选已知事件、字段须存在、定时规则不能用 $event；用示例事件试算', async () => {
  const base = { name: '报工后不良率超标', cardTitle: '{DocNum} 不良率 {DefectRate}', check: { queryKey: 'wo_defect', params: { docEntry: '$event.DocEntry' }, conditions: [{ column: 'DefectRate', op: '>', value: 0.05 }] } };
  const replies = [
    { ...base, trigger: 'cron', cron: '0 9 * * *' },
    { ...base, trigger: 'event', event: 'order-create', check: { ...base.check, params: { docEntry: '$event.OrderId' } } },
    { ...base, trigger: 'event', event: 'pro-sign-save', sampleEvent: { DocEntry: 1 } },
  ];
  const calls = [];
  const llm = async (m) => {
    calls.push(m.map((x) => x.content));
    return JSON.stringify(replies.shift());
  };
  const d = await draftAlertRule({ llm, queries: [DQ], run: async (_q, p) => ({ rows: [{ DocNum: 'WO1', DefectRate: p.docEntry === 1 ? 0.08 : 0 }] }), now: NOW }, '每次报工保存后，如果该工单不良率超过 5% 就提醒');
  assert.match(calls[0][1], /可用事件：\n- pro-sign-save：合并报工保存.*字段 DocEntry/);
  assert.match(calls[1].at(-1), /定时规则不能用 \$event/);
  assert.match(calls[2].at(-1), /事件「order-create」不在可用事件中/);
  const bad = await draftAlertRule({ llm: async () => JSON.stringify({ ...base, trigger: 'event', event: 'pro-sign-save', check: { ...base.check, params: { docEntry: '$event.OrderId' } } }), queries: [DQ], run: async () => ({ rows: [] }) }, '每次报工后检查不良率').catch((e) => e.message);
  assert.match(bad, /没有字段：OrderId/);
  assert.equal(d.rule.trigger_type, 'event');
  assert.equal(d.rule.event_name, 'pro-sign-save');
  assert.equal(d.rule.cron_expr, '');
  assert.equal(d.rule.key_column, 'DocNum');
  assert.equal(d.preview.matchedCount, 1);
  assert.deepEqual(d.preview.sampleEvent, { DocEntry: 1 });
});
