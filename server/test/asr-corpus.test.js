const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCorpus, cleanWords } = require('../src/asr-corpus');

test('buildCorpus：「上个月」句式权重高于「近三个月」', () => {
  const lines = buildCorpus({});
  const count = (s) => lines.filter((l) => l === s).length;
  assert.ok(count('看下上个月的数据') > count('看下近三个月的数据'));
  assert.ok(count('看下近三个月的数据') >= 1);
});

test('buildCorpus：业务词去重、过长丢弃，改过的整句多给权重', () => {
  const long = '很'.repeat(40);
  const lines = buildCorpus({ customers: ['甲公司', '甲公司 ', long], items: ['钢板A'], corrected: ['看下上个月的回款'] });
  assert.equal(lines.filter((l) => l === '甲公司').length, 2);
  assert.ok(lines.includes('看下甲公司上个月的销售'));
  assert.ok(!lines.includes(long));
  assert.ok(lines.includes('钢板A'));
  assert.ok(lines.filter((l) => l === '看下上个月的回款').length >= 3 + 1);
});

test('cleanWords：去空白、去空值', () => {
  assert.deepEqual(cleanWords([' a  b ', null, '', 'a b']), ['a b']);
});
