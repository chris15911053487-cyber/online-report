const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateReadonlySql,
  validateQueryInput,
  canUseQuery,
  rowToQuery,
  listAllQueries,
  getQuery,
  deleteQuery,
  invalidateQueryDefs,
  onQueryChanged,
  toPublicQuery,
} = require('../src/bi-queries');

const base = {
  queryKey: 'fin_ar_by_customer',
  label: '应收按客户',
  sqlText: 'SELECT CardCode, SUM(Balance) AS Balance FROM OCRD WHERE CardType = @t GROUP BY CardCode',
  params: [{ name: 't', type: 'string', default: 'C' }],
  roles: ['finance'],
};

test('只读校验：合法的 SELECT / WITH / 尾分号', () => {
  assert.equal(validateReadonlySql('SELECT 1').ok, true);
  assert.equal(validateReadonlySql('  with a as (select 1 x) select * from a ;  ').ok, true);
  assert.equal(validateReadonlySql('SELECT * FROM db2.dbo.OINV').ok, true, '三段名（跨库）允许');
});

test('只读校验：拒绝写操作、多语句、SELECT INTO、跨服务器、系统过程', () => {
  const bad = [
    ['UPDATE OCRD SET x=1', /SELECT 或 WITH/],
    ['SELECT 1; DELETE FROM OCRD', /一条语句/],
    ['WITH a AS (SELECT 1 x) DELETE FROM OCRD', /DELETE/],
    ['SELECT * INTO #t FROM OCRD', /INTO/],
    ['SELECT * FROM OPENQUERY(srv, \'select 1\')', /OPENQUERY/],
    ['SELECT * FROM OPENROWSET(\'x\',\'y\',\'z\')', /OPENROWSET/],
    ['SELECT * FROM [srv].[db].[dbo].[OCRD]', /链接服务器/],
    ['SELECT * FROM srv.db.dbo.OCRD', /链接服务器/],
    ['SELECT 1 EXEC xp_cmdshell \'dir\'', /EXEC/],
    ['SELECT master.dbo.xp_dirtree(1)', /系统过程/],
    ['SELECT 1 WAITFOR DELAY \'00:00:10\'', /WAITFOR/],
    ['SELECT \'unterminated', /未闭合/],
    ['SELECT 1 /* open', /未闭合/],
    ['', /不能为空/],
  ];
  for (const [s, re] of bad) {
    const r = validateReadonlySql(s);
    assert.equal(r.ok, false, s);
    assert.match(r.error, re, s);
  }
});

test('只读校验：注释、字符串、[标识符] 里的关键字不误判', () => {
  const s = `SELECT [Delete Flag], 'insert; drop table x' AS note, "update" -- delete here
             FROM OCRD /* exec */ WHERE Name = N'O''Brien; DELETE'`;
  const r = validateReadonlySql(s);
  assert.equal(r.ok, true, r.error);
});

test('只读校验：提取 @参数，排除 @@系统变量与字符串里的 @', () => {
  const r = validateReadonlySql("SELECT @@ROWCOUNT, 'a@b.com' FROM T WHERE d >= @From AND d < @to AND x = @From");
  assert.deepEqual(r.params, ['From', 'to']);
});

test('validateQueryInput：合法输入规范化', () => {
  const r = validateQueryInput({ ...base, queryKey: 'FIN_AR_by_customer', cacheSecs: 999999, dimensions: ['CardCode', { column: 'CardName', label: '客户' }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.queryKey, 'fin_ar_by_customer');
  assert.equal(r.value.cacheSecs, 86400);
  assert.deepEqual(r.value.dimensions, [{ column: 'CardCode', label: '' }, { column: 'CardName', label: '客户' }]);
  assert.equal(r.value.params[0].default, 'C');
  assert.equal(r.value.enabled, true);
});

test('validateQueryInput：SQL 引用了未声明参数（大小写不敏感匹配）', () => {
  const ok = validateQueryInput({ ...base, sqlText: 'SELECT 1 FROM T WHERE a=@T', params: [{ name: 't', type: 'string' }] });
  assert.equal(ok.ok, true);
  const r = validateQueryInput({ ...base, sqlText: 'SELECT 1 FROM T WHERE a=@t AND b=@period' });
  assert.equal(r.ok, false);
  assert.match(r.error, /@period/);
});

test('validateQueryInput：参数定义校验', () => {
  const cases = [
    [{ params: [{ name: '1bad', type: 'string' }] }, /参数名非法/],
    [{ params: [{ name: 't', type: 'json' }] }, /类型/],
    [{ params: [{ name: 't' }, { name: 'T' }] }, /重复/],
    [{ params: [{ name: 't', default: { a: 1 } }] }, /默认值/],
    [{ queryKey: 'Bad Key' }, /queryKey/],
    [{ label: '' }, /显示名称/],
    [{ dimensions: ['a;b'] }, /维度列名/],
  ];
  for (const [patch, re] of cases) {
    const r = validateQueryInput({ ...base, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, re);
  }
  // 参数名带 @ 前缀也接受
  assert.equal(validateQueryInput({ ...base, params: [{ name: '@t', type: 'string' }] }).value.params[0].name, 't');
});

test('canUseQuery：admin 始终可用；空角色仅管理员', () => {
  assert.equal(canUseQuery(['admin'], []), true);
  assert.equal(canUseQuery(['finance'], []), false);
  assert.equal(canUseQuery(['finance'], ['finance', 'cost-viewer']), true);
  assert.equal(canUseQuery(['operator'], ['finance']), false);
});

test('toPublicQuery 不暴露 SQL', () => {
  const q = rowToQuery({ id: 1, query_key: 'a', label: 'A', sql_text: 'SELECT 1', params_json: '[]', dimensions_json: '[]', cache_secs: 60, roles_json: '[]', enabled: 1 });
  assert.equal('sqlText' in toPublicQuery(q), false);
});

function fakePool(rows) {
  const pool = { listCalls: 0 };
  pool.request = () => {
    const r = {
      input: () => r,
      query: async (q) => {
        if (/FROM dbo\.bi_queries ORDER BY/i.test(q)) {
          pool.listCalls += 1;
          return { recordset: rows() };
        }
        if (/DELETE FROM dbo\.bi_queries/i.test(q)) return { rowsAffected: [1] };
        throw new Error('unexpected: ' + q);
      },
    };
    return r;
  };
  return pool;
}
const row = (k) => ({ id: 1, query_key: k, label: k, sql_text: 'SELECT 1', params_json: '[]', dimensions_json: '[]', cache_secs: 60, roles_json: '["finance"]', enabled: 1 });

test('定义缓存：命中、并发合并、删除后失效并通知监听者', async () => {
  invalidateQueryDefs();
  let data = [row('a'), row('b')];
  const pool = fakePool(() => data);
  await Promise.all([listAllQueries(pool), getQuery(pool, 'a'), getQuery(pool, 'B')]);
  assert.equal(pool.listCalls, 1);
  assert.equal((await getQuery(pool, 'B')).queryKey, 'b');

  const changed = [];
  const off = onQueryChanged((k) => changed.push(k));
  data = [row('a')];
  await deleteQuery(pool, 'b');
  off();
  assert.deepEqual(changed, ['b']);
  assert.equal(await getQuery(pool, 'b'), null);
  assert.equal(pool.listCalls, 2);
});

test('表不存在（208）时返回空列表', async () => {
  invalidateQueryDefs();
  const pool = { request: () => ({ query: async () => { const e = new Error('Invalid object'); e.number = 208; throw e; } }) };
  assert.deepEqual(await listAllQueries(pool), []);
  invalidateQueryDefs();
});

test('会话变量 @_loginUser：不算参数、声明了也忽略、toPublicQuery 标记 perUser', () => {
  const { sessionParamsUsed, toPublicQuery: pub } = require('../src/bi-queries');
  const sqlText = 'SELECT DocNum FROM ORDR WHERE U_Owner = @_LoginUser AND CONVERT(char(7), DocDate, 120) = @period';
  assert.deepEqual(validateReadonlySql(sqlText).params, ['period']);
  const base = { queryKey: 'my_orders', label: '我的订单', sqlText, params: [{ name: 'period', type: 'string' }] };
  assert.equal(validateQueryInput(base).ok, true);
  const withSession = validateQueryInput({ ...base, params: [...base.params, { name: '_loginUser', type: 'string' }] });
  assert.equal(withSession.ok, true);
  assert.deepEqual(withSession.value.params.map((p) => p.name), ['period']);
  assert.deepEqual(sessionParamsUsed(sqlText), ['_loginUser']);
  assert.deepEqual(sessionParamsUsed("SELECT '@_loginUser' -- @_loginDisplayName"), []);
  assert.equal(pub({ ...base, sqlText }).perUser, true);
  assert.equal('perUser' in pub({ ...base, sqlText: 'SELECT 1' }), false);
});
