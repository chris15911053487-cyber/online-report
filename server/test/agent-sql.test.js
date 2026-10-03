const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runSqlLimited } = require('../src/agent-sql');

/** 模拟 mssql stream 模式的 Request：query() 后按脚本异步吐事件 */
class FakeRequest extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.stream = false;
    this.cancelled = false;
    this.emittedRows = 0;
  }
  cancel() {
    this.cancelled = true;
  }
  query() {
    setImmediate(() => {
      for (const ev of this.script) {
        if (this.cancelled) break; // 取消后不再吐 row
        if (ev.type === 'row') this.emittedRows += 1;
        this.emit(ev.type, ev.data);
      }
      this.emit('done', {});
    });
    return this;
  }
}

const rec = (...names) => ({
  type: 'recordset',
  data: Object.fromEntries(names.map((n) => [n, {}])),
});
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ type: 'row', data: { id: i } }));

test('少于上限：返回全部行，不截断', async () => {
  const req = new FakeRequest([rec('id'), ...rowsOf(3)]);
  const r = await runSqlLimited(req, 'select 1', { limit: 5 });
  assert.equal(req.stream, true);
  assert.deepEqual(r.columns, ['id']);
  assert.equal(r.rows.length, 3);
  assert.equal(r.totalRowCount, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.totalCapped, false);
});

test('超过上限：只保留前 N 行，但总行数精确', async () => {
  const req = new FakeRequest([rec('id'), ...rowsOf(12)]);
  const r = await runSqlLimited(req, 'select 1', { limit: 5, hardCap: 100 });
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows.map((x) => x.id), [0, 1, 2, 3, 4]);
  assert.equal(r.totalRowCount, 12);
  assert.equal(r.truncated, true);
  assert.equal(r.totalCapped, false);
});

test('超过 hardCap：取消查询并标记 totalCapped', async () => {
  const req = new FakeRequest([rec('id'), ...rowsOf(1000)]);
  const r = await runSqlLimited(req, 'select 1', { limit: 5, hardCap: 20 });
  assert.equal(req.cancelled, true);
  assert.equal(req.emittedRows, 20, '取消后不应继续接收行');
  assert.equal(r.rows.length, 5);
  assert.equal(r.totalRowCount, 20);
  assert.equal(r.truncated, true);
  assert.equal(r.totalCapped, true);
});

test('零行结果：仍返回列名', async () => {
  const req = new FakeRequest([rec('a', 'b')]);
  const r = await runSqlLimited(req, 'select 1', { limit: 5 });
  assert.deepEqual(r.columns, ['a', 'b']);
  assert.equal(r.rows.length, 0);
  assert.equal(r.totalRowCount, 0);
});

test('多结果集：只取第一个', async () => {
  const req = new FakeRequest([rec('x'), ...rowsOf(2), rec('y'), ...rowsOf(7)]);
  const r = await runSqlLimited(req, 'select 1', { limit: 5 });
  assert.deepEqual(r.columns, ['x']);
  assert.equal(r.totalRowCount, 2);
});

test('执行出错：reject，且之后的 done 不覆盖', async () => {
  const err = new Error('boom');
  const req = new FakeRequest([rec('id'), { type: 'error', data: err }]);
  await assert.rejects(runSqlLimited(req, 'select 1', { limit: 5 }), /boom/);
});

test('query 同步抛错：reject', async () => {
  const req = new FakeRequest([]);
  req.query = () => {
    throw new Error('sync fail');
  };
  await assert.rejects(runSqlLimited(req, 'x'), /sync fail/);
});
