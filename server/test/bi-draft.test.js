const test = require('node:test');
const assert = require('node:assert/strict');
const { draftQueryAndChart, isDeniedTable, referencedDeniedTables, parseJsonObject, sampleParamsFor, uniqueKey } = require('../src/bi-draft');

/** 假 pool：INFORMATION_SCHEMA.TABLES / COLUMNS 与 CUFD */
function fakePool() {
  const tables = [{ name: 'OINV', type: 'BASE TABLE' }, { name: 'OCRD', type: 'BASE TABLE' }, { name: 'X_report_batch', type: 'BASE TABLE' }, { name: 'bi_queries', type: 'BASE TABLE' }, { name: '@TB_OUSR', type: 'BASE TABLE' }];
  const columns = [
    { tbl: 'OINV', col: 'DocDate', type: 'datetime' },
    { tbl: 'OINV', col: 'CardCode', type: 'nvarchar' },
    { tbl: 'OINV', col: 'CardName', type: 'nvarchar' },
    { tbl: 'OINV', col: 'DocTotal', type: 'numeric' },
    { tbl: 'OINV', col: 'U_Region', type: 'nvarchar' },
  ];
  const seen = [];
  return {
    seen,
    request() {
      const inputs = {};
      const req = {
        input(k, _t, v) { inputs[k] = v; return req; },
        async query(q) {
          seen.push(q);
          if (/INFORMATION_SCHEMA\.TABLES/.test(q)) return { recordset: tables };
          if (/INFORMATION_SCHEMA\.COLUMNS/.test(q)) return { recordset: columns.filter((c) => Object.values(inputs).includes(c.tbl)) };
          if (/FROM CUFD/.test(q)) return { recordset: [{ tbl: 'OINV', col: 'U_Region', descr: '销售大区' }] };
          throw new Error('unexpected ' + q);
        },
      };
      return req;
    },
  };
}

const good = {
  query: {
    queryKey: 'sales_by_customer',
    label: '销售额按客户',
    description: '各客户销售额',
    sqlText: "SELECT TOP (@top) T0.CardName, SUM(T0.DocTotal) AS Amount FROM OINV T0 WHERE CONVERT(char(7), T0.DocDate, 120) = @period AND T0.CANCELED = 'N' GROUP BY T0.CardName ORDER BY Amount DESC",
    params: [{ name: 'top', type: 'number', default: 10 }, { name: 'period', type: 'string', label: '期间', required: true }],
    columns: [{ column: 'CardName', label: '客户', role: 'dimension' }, { column: 'Amount', label: '销售额', role: 'measure', format: 'money' }, { column: 'Ghost', role: 'attr' }],
    caliberNote: '按过账日期，不含取消',
    sampleQuestions: ['哪些客户买得最多？'],
  },
  sampleParams: { period: '2026-08' },
  chart: { chartKey: 'sales_top_customers', label: '客户销售额 Top', type: 'bar', encoding: { dimension: 'CardName', value: 'Amount', horizontal: true } },
  notes: '金额为本币含税',
};

function scriptedLlm(replies) {
  const calls = [];
  return {
    calls,
    llm: async (messages) => {
      calls.push(messages.map((m) => ({ ...m })));
      const r = replies.shift();
      if (r === undefined) throw new Error('no more replies');
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  };
}

test('起草：选表 → 读结构（含自定义字段说明、过滤禁用表）→ 生成 → 试运行；列语义以实际输出列为准', async () => {
  const pool = fakePool();
  const { llm, calls } = scriptedLlm([{ tables: ['OINV', 'OUSR', 'NOPE'] }, '```json\n' + JSON.stringify(good) + '\n```']);
  const runs = [];
  const draft = await draftQueryAndChart(
    {
      pool,
      llm,
      existingQueries: [{ queryKey: 'sales_by_customer', label: '已有' }],
      existingCharts: [],
      testRun: async (q, params) => {
        runs.push(params);
        return { columns: ['CardName', 'Amount', 'Extra'], columnTypes: {}, rows: [{ CardName: '甲', Amount: 1, Extra: 'x' }], rowCount: 1 };
      },
    },
    '本月各客户销售额前 10',
  );
  // 选表提示里列出自定义业务表，不列 SAP 标准表与本系统 / 用户表
  const pickUser = calls[0][1].content;
  assert.match(pickUser, /X_report_batch/);
  assert.doesNotMatch(pickUser, /bi_queries|@TB_OUSR|OINV/);
  // 结构里有 U_ 字段说明；OUSR 被过滤
  const genUser = calls[1][1].content;
  assert.match(genUser, /U_Region:nvarchar\(销售大区\)/);
  assert.doesNotMatch(genUser, /OUSR/);
  assert.deepEqual(draft.tables, ['OINV']);
  // key 与已有冲突时自动加序号
  assert.equal(draft.query.queryKey, 'sales_by_customer_2');
  assert.equal(draft.chart.queryKey, 'sales_by_customer_2');
  assert.deepEqual(runs[0], { period: '2026-08' }, 'top 有默认值不传');
  assert.deepEqual(draft.query.columns.map((c) => c.column), ['CardName', 'Amount', 'Extra'], 'Ghost 去掉，Extra 补上');
  assert.deepEqual(draft.unlabeledColumns, ['Extra']);
  assert.equal(draft.chart.encoding.horizontal, true);
  assert.equal(draft.attempts, 1);
});

test('起草：SQL 报错 / 图表列不对 / 引用禁用表 → 把错误交回 AI 修正', async () => {
  const badSql = { ...good, query: { ...good.query, sqlText: 'SELECT CardName, DocTotal AS Amount FROM OINV WHERE CONVERT(char(7), DocDate, 120) = @period' } };
  const denied = { ...good, query: { ...good.query, sqlText: 'SELECT U_NAME AS CardName, 1 AS Amount FROM OUSR WHERE @period = @period AND @top = @top' } };
  const badChart = { ...good, chart: { ...good.chart, encoding: { dimension: 'Customer', value: 'Amount' } } };
  const { llm, calls } = scriptedLlm([{ tables: ['OINV'] }, denied, badSql, badChart]);
  let n = 0;
  await assert.rejects(
    draftQueryAndChart(
      {
        pool: fakePool(),
        llm,
        testRun: async () => {
          n += 1;
          if (n === 1) throw new Error("Invalid column name 'Foo'");
          return { columns: ['CardName', 'Amount'], rows: [] };
        },
      },
      '各客户销售额',
    ),
    /修正 3 次仍未成功.*图表配置有误/,
  );
  const feedback = calls[3].filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  assert.match(feedback, /不允许使用这些表：OUSR/);
  assert.match(feedback, /SQL 试运行报错：Invalid column name 'Foo'/);
});

test('起草：第二次修正成功即返回', async () => {
  const { llm } = scriptedLlm([{ tables: ['OINV'] }, 'not json', good]);
  const draft = await draftQueryAndChart({ pool: fakePool(), llm, testRun: async () => ({ columns: ['CardName', 'Amount'], rows: [] }) }, '各客户销售额');
  assert.equal(draft.attempts, 2);
  assert.equal(draft.query.queryKey, 'sales_by_customer');
});

test('起草：需求太短 / 选不出表', async () => {
  await assert.rejects(draftQueryAndChart({ pool: fakePool(), llm: async () => '{}' }, '看'), /一句话描述/);
  await assert.rejects(draftQueryAndChart({ pool: fakePool(), llm: async () => '{"tables": []}' }, '各客户销售额'), /没有选出/);
  await assert.rejects(draftQueryAndChart({ pool: fakePool(), llm: async () => '{"tables": ["OUSR"]}' }, '各客户销售额'), /不存在或不允许/);
});

test('工具函数：禁用表、JSON 提取、示例参数、key 去重', () => {
  assert.equal(isDeniedTable('OUSR'), true);
  assert.equal(isDeniedTable('[dbo].[bi_queries]'), true);
  assert.equal(isDeniedTable('@TB_OUSR'), true);
  assert.equal(isDeniedTable('OINV'), false);
  assert.deepEqual(referencedDeniedTables('SELECT 1 FROM OINV a JOIN dbo.[OUSR] u ON 1=1 LEFT JOIN agents g ON 1=1'), ['OUSR', 'agents']);
  assert.deepEqual(parseJsonObject('好的：{"a":1} 以上'), { a: 1 });
  assert.equal(parseJsonObject('nope'), null);
  const p = sampleParamsFor([{ name: 'period', type: 'string', required: true }, { name: 'd', type: 'date' }, { name: 'top', type: 'number', default: 5 }, { name: 'whs', type: 'string' }], { WHS: '01' });
  assert.match(p.period, /^\d{4}-\d{2}$/);
  assert.match(p.d, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.whs, '01');
  assert.equal('top' in p, false);
  assert.equal(uniqueKey('Sales By Cust', new Set(['sales_by_cust']), /^[a-z][a-z0-9_-]{0,63}$/), 'sales_by_cust_2');
});
