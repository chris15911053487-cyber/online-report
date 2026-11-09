const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { buildCorpus, cleanWords, encodeGbkLines } = require('../src/asr-corpus');

test('buildCorpus：「上个月」句式权重高于「近三个月」，重复不超过 3 次', () => {
  const { sentences, hotwords } = buildCorpus({});
  const count = (s) => sentences.filter((l) => l === s).length;
  assert.equal(count('看下上个月的数据'), 3);
  assert.equal(count('看下近三个月的数据'), 1);
  assert.ok(hotwords.includes('上个月'));
});

test('buildCorpus：业务词进热词（去重、过长丢弃），改过的整句进句篇', () => {
  const long = '很'.repeat(40);
  const { hotwords, sentences } = buildCorpus({ customers: ['甲公司', '甲公司 ', long], items: ['钢板A'], corrected: ['看下上个月的回款'] });
  assert.equal(hotwords.filter((l) => l === '甲公司').length, 1);
  assert.ok(hotwords.includes('钢板A'));
  assert.ok(!hotwords.includes(long));
  assert.ok(sentences.includes('看下甲公司上个月的销售'));
  assert.ok(sentences.includes('看下上个月的回款'));
});

test('encodeGbkLines：输出 GBK，丢掉 GBK 表示不了的行，超限截断', () => {
  const r = encodeGbkLines(['上个月', '😀表情', '钢板']);
  assert.equal(r.kept, 2);
  assert.equal(r.dropped, 1);
  assert.equal(iconv.decode(r.buffer, 'gbk'), '上个月\r\n钢板\r\n');
  const t = encodeGbkLines(['一二三', '四五六'], 10);
  assert.equal(t.kept, 1);
  assert.equal(t.truncated, true);
});

test('cleanWords：去空白、去空值', () => {
  assert.deepEqual(cleanWords([' a  b ', null, '', 'a b']), ['a b']);
});
