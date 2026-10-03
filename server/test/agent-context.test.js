const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 用 require.cache 注入桩，避免加载真实 db
function stub(rel, exports) {
  const file = require.resolve(path.join('../src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const SKILLS = [
  { name: 'a', description: 'da', bodyMd: 'ba', producesDocument: false, allowedTables: ['T1'], resources: { 'r.md': { content: 'xyz' } } },
  { name: 'b', description: 'db', bodyMd: 'bb', producesDocument: true, resources: {} },
];
let agentImpl;
let getAgentCalls = 0;
stub('agent-skills.js', { listSkillsForRoles: async () => SKILLS });
stub('agents.js', {
  getAgent: async (...args) => {
    getAgentCalls += 1;
    return agentImpl(...args);
  },
});
const { resolveAgentContext } = require('../src/agent-context');

const run = (agentKey) => {
  getAgentCalls = 0;
  return resolveAgentContext({}, { agentKey, userRoles: ['operator'] });
};

test('未指定 agentKey：全部 skill，不查 agents 表', async () => {
  const r = await run(undefined);
  assert.deepEqual(r.skills.map((s) => s.name), ['a', 'b']);
  assert.equal(r.agentPrompt, '');
  assert.equal(getAgentCalls, 0);
});

test('映射：资源只传清单，allowedTables 缺省为空数组', async () => {
  const r = await run(undefined);
  assert.deepEqual(r.skills[0].resources, [{ path: 'r.md', size: 3 }]);
  assert.deepEqual(r.skills[1].allowedTables, []);
  assert.equal(r.skills[0].bodyMd, 'ba');
});

test('Agent 存在且启用：取关联 skill 交集，带专属指令，且只查一次', async () => {
  agentImpl = async () => ({ enabled: true, skills: ['b', 'zzz'], systemPromptExtra: 'EXTRA' });
  const r = await run('sales');
  assert.deepEqual(r.skills.map((s) => s.name), ['b']);
  assert.equal(r.agentPrompt, 'EXTRA');
  assert.equal(getAgentCalls, 1);
});

test('Agent 未关联 skill：skills 为空，专属指令仍带上', async () => {
  agentImpl = async () => ({ enabled: true, skills: [], systemPromptExtra: 'EXTRA' });
  const r = await run('chat');
  assert.deepEqual(r.skills, []);
  assert.equal(r.agentPrompt, 'EXTRA');
});

test('Agent 未启用：skills 为空（沿用原行为）', async () => {
  agentImpl = async () => ({ enabled: false, skills: ['a'], systemPromptExtra: '' });
  const r = await run('off');
  assert.deepEqual(r.skills, []);
});

test('Agent 不存在：skills 为空', async () => {
  agentImpl = async () => null;
  const r = await run('nope');
  assert.deepEqual(r.skills, []);
  assert.equal(r.agentPrompt, '');
});

test('读取 Agent 失败：退回全部 skill，无专属指令', async () => {
  agentImpl = async () => {
    throw new Error('db down');
  };
  const r = await run('sales');
  assert.deepEqual(r.skills.map((s) => s.name), ['a', 'b']);
  assert.equal(r.agentPrompt, '');
});
