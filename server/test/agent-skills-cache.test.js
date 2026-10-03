const test = require('node:test');
const assert = require('node:assert/strict');
const { listSkillsForRoles, deleteSkill, invalidateSkillCache } = require('../src/agent-skills');

function row(name, roles = ['operator']) {
  return {
    name,
    description: 'd',
    body_md: 'b',
    resources_json: '{}',
    roles_json: JSON.stringify(roles),
    allowed_tables_json: '[]',
    produces_document: 0,
    enabled: 1,
    sort_order: 1,
  };
}

/** 可链式的假 pool：统计 SELECT 列表查询次数 */
function fakePool(getRows) {
  const pool = { listCalls: 0 };
  pool.request = () => {
    const r = {
      input: () => r,
      query: async (q) => {
        if (/FROM dbo\.agent_skills\s+ORDER BY/i.test(q)) {
          pool.listCalls += 1;
          return { recordset: getRows() };
        }
        if (/DELETE FROM dbo\.agent_skills/i.test(q)) return { rowsAffected: [1] };
        throw new Error('unexpected query: ' + q);
      },
    };
    return r;
  };
  return pool;
}

test('第二次调用命中缓存，不再查库', async () => {
  invalidateSkillCache();
  const pool = fakePool(() => [row('a')]);
  await listSkillsForRoles(pool, ['operator']);
  await listSkillsForRoles(pool, ['operator']);
  assert.equal(pool.listCalls, 1);
});

test('并发未命中共享同一次查询', async () => {
  invalidateSkillCache();
  const pool = fakePool(() => [row('a')]);
  await Promise.all([1, 2, 3].map(() => listSkillsForRoles(pool, ['operator'])));
  assert.equal(pool.listCalls, 1);
});

test('缓存的是全量，角色过滤每次按调用者计算', async () => {
  invalidateSkillCache();
  const pool = fakePool(() => [row('a', ['operator']), row('b', ['finance'])]);
  const op = await listSkillsForRoles(pool, ['operator']);
  const fin = await listSkillsForRoles(pool, ['finance']);
  assert.deepEqual(op.map((s) => s.name), ['a']);
  assert.deepEqual(fin.map((s) => s.name), ['b']);
  assert.equal(pool.listCalls, 1);
});

test('deleteSkill 使缓存失效', async () => {
  invalidateSkillCache();
  let data = [row('a'), row('b')];
  const pool = fakePool(() => data);
  assert.equal((await listSkillsForRoles(pool, ['operator'])).length, 2);
  data = [row('a')];
  await deleteSkill(pool, 'b');
  assert.equal((await listSkillsForRoles(pool, ['operator'])).length, 1);
  assert.equal(pool.listCalls, 2);
});

test('查询失败不缓存，下次重试', async () => {
  invalidateSkillCache();
  let fail = true;
  const pool = fakePool(() => {
    if (fail) throw new Error('db down');
    return [row('a')];
  });
  await assert.rejects(listSkillsForRoles(pool, ['operator']), /db down/);
  fail = false;
  assert.equal((await listSkillsForRoles(pool, ['operator'])).length, 1);
});
