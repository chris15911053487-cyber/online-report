const test = require('node:test');
const assert = require('node:assert');
const { draftCron, checkCron, CronDraftError } = require('../src/cron-draft');

const scripted = (...replies) => {
  const calls = [];
  const llm = async (messages) => {
    calls.push(messages.map((m) => m.content));
    return replies.shift();
  };
  return { llm, calls };
};

test('checkCron：规范化空格，只接受有效的 5 段', () => {
  assert.deepStrictEqual(checkCron('  0  8 * *   1-5 '), { expr: '0 8 * * 1-5' });
  assert.ok(checkCron('0 0 8 * * 1-5').error, '6 段（带秒）不接受');
  assert.ok(checkCron('0 25 * * *').error);
  assert.ok(checkCron('0 8 L * *').error);
  assert.ok(checkCron('').error);
});

test('draftCron：一次通过', async () => {
  const { llm } = scripted('{"cron":"30 8 * * 1-5","explain":"工作日 8:30"}');
  const r = await draftCron(llm, '工作日早上八点半');
  assert.deepStrictEqual(r, { cron_expr: '30 8 * * 1-5', explain: '工作日 8:30', attempts: 1 });
});

test('draftCron：无效表达式交回 AI 修正', async () => {
  const { llm, calls } = scripted('好的：{"cron":"0 8 ? * MON-FRI","explain":"x"}', '{"cron":"0 8 * * 1-5","explain":"工作日 8:00"}');
  const r = await draftCron(llm, '工作日 8 点');
  assert.strictEqual(r.cron_expr, '0 8 * * 1-5');
  assert.strictEqual(r.attempts, 2);
  assert.match(calls[1].at(-1), /校验不通过/);
});

test('draftCron：AI 说无法表达时直接报原因', async () => {
  const { llm } = scripted('{"cron":null,"explain":"cron 不支持每月最后一天，可改为每月 28 日"}');
  await assert.rejects(draftCron(llm, '每月最后一天'), (e) => e instanceof CronDraftError && /最后一天/.test(e.message));
});

test('draftCron：多轮仍失败 / 空输入', async () => {
  const { llm } = scripted('不是 JSON', '{"cron":"99 * * * *"}', '{"cron":"a b c"}');
  await assert.rejects(draftCron(llm, '随便'), CronDraftError);
  await assert.rejects(draftCron(llm, '  '), CronDraftError);
});
