const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dbFile = require.resolve(path.join('../src', 'db.js'));
const sqlTypes = new Proxy({}, { get: (_t, k) => (k === 'NVarChar' ? () => 'nvarchar' : k) });
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { getPool: async () => ({}), sql: sqlTypes } };
const { insertVoiceLog, recordVoiceFinal, normalizeVoiceLogId } = require('../src/voice-logs');

function fakePool(result) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = value; return this; },
        async query(q) { calls.push({ q, inputs }); return result; },
      };
    },
  };
}

test('insertVoiceLog：返回新 id，未知 source 记为空', async () => {
  const pool = fakePool({ recordset: [{ id: 12 }] });
  assert.equal(await insertVoiceLog(pool, { text: '看下上个月', userCode: 'u1', source: 'chat' }), 12);
  assert.equal(pool.calls[0].inputs.source, 'chat');
  await insertVoiceLog(pool, { text: 'x', userCode: 'u1', source: 'hack' });
  assert.equal(pool.calls[1].inputs.source, null);
});

test('recordVoiceFinal：只改本人那条；非法 id 或无用户不查库', async () => {
  const pool = fakePool({ rowsAffected: [1] });
  assert.equal(await recordVoiceFinal(pool, { logId: '5', userCode: 'u1', finalText: '看下上个月的数据' }), true);
  assert.match(pool.calls[0].q, /user_code = @user_code AND final_text IS NULL/);
  assert.equal(pool.calls[0].inputs.id, 5);
  assert.equal(await recordVoiceFinal(pool, { logId: 'abc', userCode: 'u1' }), false);
  assert.equal(await recordVoiceFinal(pool, { logId: 5, userCode: '' }), false);
  assert.equal(pool.calls.length, 1);
  assert.equal(normalizeVoiceLogId(-1), null);
});
