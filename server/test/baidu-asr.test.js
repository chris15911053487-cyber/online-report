const test = require('node:test');
const assert = require('node:assert/strict');
const { recognize, resolveAsrConfig } = require('../src/baidu-asr');

test('resolveAsrConfig：默认标准版 1537，pro 走极速版 80001，可覆盖 dev_pid / lm_id', () => {
  assert.deepEqual(resolveAsrConfig({}), { mode: 'standard', url: 'https://vop.baidu.com/server_api', devPid: 1537, lmId: null });
  assert.deepEqual(resolveAsrConfig({ BAIDU_ASR_MODE: 'PRO' }), { mode: 'pro', url: 'https://vop.baidu.com/pro_api', devPid: 80001, lmId: null });
  assert.equal(resolveAsrConfig({ BAIDU_ASR_MODE: 'xx' }).mode, 'standard');
  assert.equal(resolveAsrConfig({ BAIDU_ASR_DEV_PID: '8001' }).devPid, 8001);
  assert.equal(resolveAsrConfig({ BAIDU_ASR_LM_ID: ' 123 ' }).lmId, '123');
});

test('recognize：按配置选地址，带 lm_id 与按人 cuid', async (t) => {
  const saved = { ...process.env };
  const origFetch = global.fetch;
  t.after(() => { process.env = saved; global.fetch = origFetch; });
  Object.assign(process.env, {
    BAIDU_ASR_API_KEY: 'k', BAIDU_ASR_SECRET_KEY: 's', BAIDU_ASR_MODE: 'pro', BAIDU_ASR_LM_ID: '42',
  });
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('oauth')) return { json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { json: async () => ({ err_no: 0, result: ['看下上个月的数据'] }) };
  };
  const text = await recognize('AAAA', 3, { userCode: 'u01' });
  assert.equal(text, '看下上个月的数据');
  const asr = calls.find((c) => String(c.url).includes('vop'));
  assert.equal(asr.url, 'https://vop.baidu.com/pro_api');
  assert.equal(asr.body.dev_pid, 80001);
  assert.equal(asr.body.lm_id, '42');
  assert.equal(asr.body.cuid, 'online-report-u01');
});
