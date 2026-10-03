const test = require('node:test');
const assert = require('node:assert/strict');
const { createBiExecutor, resolveParams, coerceParam, BiParamError, executeQuery } = require('../src/bi-exec');

const query = {
  queryKey: 'fin_ar',
  sqlText: 'SELECT 1',
  params: [
    { name: 'period', type: 'string', required: true },
    { name: 'top', type: 'number', default: 10 },
  ],
  cacheSecs: 60,
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function setup(extra = {}) {
  let t = 1_000_000;
  const calls = [];
  let fail = false;
  let delay = 0;
  const exec = createBiExecutor({
    now: () => t,
    staleSecs: 100,
    log: { warn: () => {} },
    execute: async (_pool, q, params) => {
      calls.push(params);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fail) throw new Error('db down');
      return { columns: ['v'], rows: [{ v: calls.length }], rowCount: 1, truncated: false };
    },
    ...extra,
  });
  return {
    exec,
    calls,
    advance: (s) => { t += s * 1000; },
    setFail: (v) => { fail = v; },
    setDelay: (v) => { delay = v; },
  };
}
const run = (exec, over = {}) => exec.run({ pool: {}, query, params: { period: '2026-09' }, roles: ['finance'], ...over });
const tick = () => new Promise((r) => setImmediate(r));

test('参数：类型转换、默认值、必填、大小写不敏感、未声明的忽略', () => {
  assert.deepEqual(resolveParams(query.params, { PERIOD: '2026-09', extra: 'x' }), { period: '2026-09', top: 10 });
  assert.deepEqual(resolveParams(query.params, { period: '2026-09', top: '5' }), { period: '2026-09', top: 5 });
  assert.throws(() => resolveParams(query.params, {}), /缺少必填参数/);
  assert.throws(() => resolveParams(query.params, { period: 'x', top: 'abc' }), BiParamError);
});

test('参数：date / bool / string 校验', () => {
  assert.equal(coerceParam({ name: 'd', type: 'date' }, '2026-09-30').value, '2026-09-30');
  assert.equal(coerceParam({ name: 'd', type: 'date' }, '2026-09-30T08:05').value, '2026-09-30 08:05:00');
  assert.throws(() => coerceParam({ name: 'd', type: 'date' }, '2026-02-30'), /有效日期/);
  assert.throws(() => coerceParam({ name: 'd', type: 'date' }, "2026-01-01'; --"), /日期/);
  assert.equal(coerceParam({ name: 'b', type: 'bool' }, 'true').value, true);
  assert.equal(coerceParam({ name: 'b', type: 'bool' }, 0).value, false);
  assert.throws(() => coerceParam({ name: 'b', type: 'bool' }, 'yes'), /true/);
  assert.throws(() => coerceParam({ name: 's', type: 'string' }, { a: 1 }), /文本/);
  assert.throws(() => coerceParam({ name: 's', type: 'string' }, 'x'.repeat(401)), /400/);
  assert.equal(coerceParam({ name: 's', type: 'string' }, '').value, null);
});

test('缓存：TTL 内命中；参数不同不共享', async () => {
  const { exec, calls } = setup();
  const a = await run(exec);
  const b = await run(exec);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(calls.length, 1);
  await run(exec, { params: { period: '2026-08' } });
  assert.equal(calls.length, 2);
  // 参数里 top 显式写默认值 = 同一个 key
  await run(exec, { params: { period: '2026-09', top: 10 } });
  assert.equal(calls.length, 2);
});

test('缓存：不同角色集合不共享；角色顺序/大小写无关', async () => {
  const { exec, calls } = setup();
  await run(exec, { roles: ['finance', 'cost-viewer'] });
  await run(exec, { roles: ['finance'] });
  assert.equal(calls.length, 2);
  await run(exec, { roles: ['COST-VIEWER', 'finance'] });
  assert.equal(calls.length, 2);
});

test('并发同 key 只执行一次', async () => {
  const { exec, calls, setDelay } = setup();
  setDelay(20);
  const rs = await Promise.all([run(exec), run(exec), run(exec)]);
  assert.equal(calls.length, 1);
  assert.ok(rs.every((r) => r.rows[0].v === 1));
});

test('过期后在 stale 窗口内先返回旧数据并后台刷新', async () => {
  const { exec, calls, advance } = setup();
  await run(exec);
  advance(61);
  const stale = await run(exec);
  assert.equal(stale.stale, true);
  assert.equal(stale.rows[0].v, 1);
  await tick();
  assert.equal(calls.length, 2, '已触发后台刷新');
  const fresh = await run(exec);
  assert.equal(fresh.rows[0].v, 2);
  assert.equal(fresh.stale, false);
});

test('超过 stale 窗口则等待新数据', async () => {
  const { exec, calls, advance } = setup();
  await run(exec);
  advance(61 + 101);
  const r = await run(exec);
  assert.equal(r.cached, false);
  assert.equal(r.rows[0].v, 2);
  assert.equal(calls.length, 2);
});

test('后台刷新失败保留旧数据；前台失败不缓存', async () => {
  const { exec, calls, advance, setFail } = setup();
  await run(exec);
  advance(61);
  setFail(true);
  assert.equal((await run(exec)).rows[0].v, 1);
  await tick();
  assert.equal((await run(exec)).rows[0].v, 1, '刷新失败后仍返回旧数据');
  advance(200);
  await assert.rejects(run(exec), /db down/);
  setFail(false);
  const ok = await run(exec);
  assert.equal(ok.cached, false);
  assert.ok(calls.length >= 4);
});

test('refresh 强制重查；cacheSecs=0 不缓存', async () => {
  const { exec, calls } = setup();
  await run(exec);
  const r = await run(exec, { refresh: true });
  assert.equal(r.cached, false);
  assert.equal(calls.length, 2);
  const nc = { ...query, cacheSecs: 0 };
  await run(exec, { query: nc });
  await run(exec, { query: nc });
  assert.equal(calls.length, 4);
});

test('invalidate(queryKey) 只清该查询；定义 updatedAt 变化自动换 key', async () => {
  const { exec, calls } = setup();
  const other = { ...query, queryKey: 'other' };
  await run(exec);
  await run(exec, { query: other });
  exec.invalidate('fin_ar');
  await run(exec);
  await run(exec, { query: other });
  assert.equal(calls.length, 3);
  await run(exec, { query: { ...query, updatedAt: '2026-10-02T00:00:00.000Z' } });
  assert.equal(calls.length, 4);
});

test('缓存条目数有上限（LRU 近似：淘汰最早写入）', async () => {
  const { exec } = setup({ maxEntries: 2 });
  for (const p of ['a', 'b', 'c']) await run(exec, { params: { period: p } });
  assert.equal(exec.stats().entries, 2);
});

test('参数错误在执行前抛出，不触库', async () => {
  const { exec, calls } = setup();
  await assert.rejects(run(exec, { params: {} }), BiParamError);
  assert.equal(calls.length, 0);
});

test('executeQuery：按类型绑定参数、设置超时、流式限行并标记 truncated', async () => {
  const inputs = [];
  const handlers = {};
  const request = {
    input: (name, type, value) => { inputs.push({ name, type: typeof type === 'function' ? type.name : (type?.type?.name || 'x'), value }); return request; },
    on: (ev, fn) => { handlers[ev] = fn; return request; },
    cancel: () => {},
    query: () => {
      setImmediate(() => {
        handlers.recordset({ v: {} });
        for (let i = 0; i < 5; i++) handlers.row({ v: i });
        handlers.done();
      });
    },
  };
  const pool = { request: () => request };
  const q = { ...query, params: [{ name: 'period', type: 'string' }, { name: 'top', type: 'number' }] };
  const r = await executeQuery(pool, q, { period: '2026-09', top: 3 }, { maxRows: 3 });
  assert.equal(r.rowCount, 3);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.columns, ['v']);
  assert.deepEqual(inputs.map((i) => [i.name, i.value]), [['period', '2026-09'], ['top', '3']]);
  assert.ok(request.timeout >= 1000);
});
