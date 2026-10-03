const test = require('node:test');
const assert = require('node:assert/strict');

const { upsertAgent, getAgent, validateAgentInput } = require('../src/agents');

/** 假连接池：missingColumn=true 时模拟库里缺 agents.dashboard_key（SQL 引用该列即报 207） */
function fakePool({ missingColumn }) {
  const sqls = [];
  return {
    sqls,
    request() {
      const req = {
        input() {
          return req;
        },
        async query(text) {
          sqls.push(text);
          if (missingColumn && text.includes('dashboard_key')) {
            throw Object.assign(new Error("Invalid column name 'dashboard_key'."), { number: 207 });
          }
          return {
            recordset: [{ agent_key: 'sales', label: '销售', dashboard_key: missingColumn ? undefined : 'fin' }],
            rowsAffected: [1],
          };
        },
      };
      return req;
    },
  };
}

const input = validateAgentInput({ agentKey: 'sales', label: '销售', dashboardKey: 'fin' }).value;

test('列存在时写入 dashboard_key', async () => {
  const pool = fakePool({ missingColumn: false });
  const saved = await upsertAgent(pool, input);
  assert.ok(pool.sqls[0].includes('dashboard_key = @dashboard_key'));
  assert.equal(saved.dashboardKey, 'fin');
});

test('缺列且关联了看板：报错，不假装保存成功', async () => {
  await assert.rejects(upsertAgent(fakePool({ missingColumn: true }), input), { code: 'AGENT_DASHBOARD_COLUMN_MISSING' });
});

test('缺列但未关联看板：回退为不写该列', async () => {
  const pool = fakePool({ missingColumn: true });
  const saved = await upsertAgent(pool, { ...input, dashboardKey: '' });
  assert.equal(saved.agentKey, 'sales');
  assert.ok(pool.sqls.some((t) => t.includes('MERGE') && !t.includes('dashboard_key =')));
});

test('缺列结论不缓存：补列后立即恢复读写', async () => {
  await getAgent(fakePool({ missingColumn: true }), 'sales');
  const pool = fakePool({ missingColumn: false });
  const saved = await upsertAgent(pool, input);
  assert.ok(pool.sqls[0].includes('dashboard_key = @dashboard_key'));
  assert.equal(saved.dashboardKey, 'fin');
});
