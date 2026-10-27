const test = require('node:test');
const assert = require('node:assert/strict');
const { draftSqlSkill, buildSkillBody, checkQuery } = require('../src/skill-draft');

/** 假 pool：INFORMATION_SCHEMA.TABLES / COLUMNS，无 CUFD */
function fakePool() {
  const columns = [
    { tbl: 'ORDR', col: 'DocNum', type: 'int' },
    { tbl: 'ORDR', col: 'DocDate', type: 'datetime' },
    { tbl: 'ORDR', col: 'CardCode', type: 'nvarchar' },
    { tbl: 'ORDR', col: 'DocTotal', type: 'numeric' },
    { tbl: 'OCRD', col: 'CardCode', type: 'nvarchar' },
    { tbl: 'OCRD', col: 'CardName', type: 'nvarchar' },
  ];
  return {
    request() {
      const inputs = {};
      const req = {
        input(k, _t, v) { inputs[k] = v; return req; },
        async query(q) {
          if (/INFORMATION_SCHEMA\.TABLES/.test(q)) return { recordset: [] };
          if (/INFORMATION_SCHEMA\.COLUMNS/.test(q)) return { recordset: columns.filter((c) => Object.values(inputs).includes(c.tbl)) };
          if (/FROM CUFD/.test(q)) throw new Error('no CUFD');
          throw new Error('unexpected ' + q);
        },
      };
      return req;
    },
  };
}

const goodDraft = {
  name: 'sales-order-daily',
  description: '销售订单日报：只查 ORDR / OCRD',
  title: '销售订单日报',
  tables: [{ table: 'ORDR', label: '销售订单', columns: 'DocDate 单据日期、DocTotal 金额' }, { table: 'OCRD', label: '业务伙伴', columns: 'CardName 客户名称' }],
  rules: ["一律排除已取消：CANCELED = 'N'"],
  queries: [{ title: '前 5 客户', sql: 'SELECT TOP 5 T1.CardName AS 客户, SUM(T0.DocTotal) AS 金额 FROM ORDR T0 JOIN OCRD T1 ON T0.CardCode = T1.CardCode GROUP BY T1.CardName;' }],
  output: '先结论再表格',
};

test('draftSqlSkill：选表 → 生成 → 试跑通过，白名单为用到的表，正文含 SQL 代码块', async () => {
  const replies = [JSON.stringify({ tables: ['ORDR', 'OCRD', 'OINV'] }), JSON.stringify(goodDraft)];
  const ran = [];
  const out = await draftSqlSkill(
    { pool: fakePool(), llm: async () => replies.shift(), run: async (s) => { ran.push(s); return { columns: ['客户', '金额'], rows: [{}], totalRowCount: 1 }; } },
    '每天的销售订单日报',
  );
  assert.equal(out.skill.name, 'sales-order-daily');
  assert.deepEqual([...out.skill.allowedTables].sort(), ['OCRD', 'ORDR']);
  assert.match(out.skill.bodyMd, /## 查询模式/);
  assert.match(out.skill.bodyMd, /```sql\nSELECT TOP 5/);
  assert.equal(ran.length, 1);
  assert.equal(out.checks[0].rowCount, 1);
  assert.equal(out.attempts, 1);
});

test('draftSqlSkill：试跑报错 / 越界表交回 AI 修正', async () => {
  const bad = { ...goodDraft, queries: [{ title: '越界', sql: 'SELECT DocTotal FROM OINV' }] };
  const replies = [JSON.stringify({ tables: ['ORDR', 'OCRD'] }), JSON.stringify(bad), JSON.stringify(goodDraft)];
  const seen = [];
  const out = await draftSqlSkill(
    { pool: fakePool(), llm: async (m) => { seen.push(m[m.length - 1].content); return replies.shift(); }, run: async () => ({ columns: [], rows: [], totalRowCount: 0 }) },
    '每天的销售订单日报',
  );
  assert.equal(out.attempts, 2);
  assert.match(seen[2], /只能用这些表.*oinv/i);
});

test('draftSqlSkill：重名要求换名', async () => {
  const replies = [JSON.stringify({ tables: ['ORDR', 'OCRD'] }), JSON.stringify(goodDraft), JSON.stringify({ ...goodDraft, name: 'sales-order-daily-2' })];
  const out = await draftSqlSkill(
    { pool: fakePool(), llm: async () => replies.shift(), run: async () => ({ columns: [], rows: [] }), existingNames: ['sales-order-daily'] },
    '每天的销售订单日报',
  );
  assert.equal(out.skill.name, 'sales-order-daily-2');
});

test('checkQuery：写操作、参数、禁用表都拒绝', async () => {
  const run = async () => ({ rows: [] });
  assert.equal((await checkQuery({ sql: 'DELETE FROM ORDR' }, ['ORDR'], run)).ok, false);
  assert.match((await checkQuery({ sql: 'SELECT * FROM ORDR WHERE DocDate = @d' }, ['ORDR'], run)).error, /参数/);
  assert.match((await checkQuery({ sql: 'SELECT * FROM OUSR' }, ['OUSR'], run)).error, /不允许/);
  assert.equal((await checkQuery({ sql: 'SELECT 1 AS x FROM ORDR' }, ['ORDR'], run)).ok, true);
});

test('buildSkillBody：无口径 / 输出时省略对应段', () => {
  const body = buildSkillBody({ title: 'T', tables: [{ table: 'ORDR', label: '', columns: 'DocNum' }], rules: [], queries: [{ title: 'q', sql: 'SELECT 1' }], output: '' });
  assert.doesNotMatch(body, /## 口径|## 输出/);
  assert.match(body, /- ORDR：DocNum/);
});
