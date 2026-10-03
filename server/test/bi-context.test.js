const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBiContext, normalizeMode, MAX_JSON_CHARS } = require('../src/bi-context');

const good = {
  dashboardKey: 'Finance',
  cardId: 'ar_by_customer',
  cardTitle: '应收按客户',
  queryKey: 'fin_ar',
  queryLabel: '应收账款 · 按客户',
  caliberNote: '按过账日期',
  path: ['应收按客户', '甲 · 单据'],
  point: { 客户: '甲', 余额: 1200000, 有效: true, 空: null },
  filters: { 期间: '2026-09' },
  params: { period: '2026-09', top: 10 },
  intent: 'explain',
  caption: '仅前端用',
};

test('合法上下文：白名单字段保留、key 小写、多余字段丢弃', () => {
  const c = normalizeBiContext(good);
  assert.equal(c.dashboardKey, 'finance');
  assert.equal(c.queryKey, 'fin_ar');
  assert.deepEqual(c.point, { 客户: '甲', 余额: 1200000, 有效: true, 空: null });
  assert.deepEqual(c.path, ['应收按客户', '甲 · 单据']);
  assert.equal(c.intent, 'explain');
  assert.equal('caption' in c, false);
});

test('值只允许标量；对象/数组/非有限数被丢弃；控制字符被替换', () => {
  const c = normalizeBiContext({
    ...good,
    point: { a: { x: 1 }, b: [1], c: Infinity, d: 'ok\u0000\nline' },
  });
  assert.deepEqual(c.point, { c: null, d: 'ok  line' });
});

test('非法 key/intent 丢弃；没有卡片标题也没有查询 → null', () => {
  const c = normalizeBiContext({ ...good, queryKey: 'DROP TABLE;', cardId: '1bad', intent: 'hack' });
  assert.equal(c.queryKey, undefined);
  assert.equal(c.cardId, undefined);
  assert.equal(c.intent, undefined);
  assert.equal(normalizeBiContext({ point: { a: 1 } }), null);
  assert.equal(normalizeBiContext(null), null);
  assert.equal(normalizeBiContext([1]), null);
  assert.equal(normalizeBiContext('x'), null);
});

test('限长：字符串截断、条目数上限、总长超限依次丢次要字段', () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  const c = normalizeBiContext({ ...good, cardTitle: 'x'.repeat(500), point: many, path: Array(20).fill('p') });
  assert.equal(c.cardTitle.length, 200);
  assert.equal(Object.keys(c.point).length, 20);
  assert.equal(c.path.length, 6);

  const big = 'y'.repeat(200);
  const huge = normalizeBiContext({
    ...good,
    point: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, big])),
    params: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, big])),
    filters: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, big])),
  });
  assert.ok(huge === null || JSON.stringify(huge).length <= MAX_JSON_CHARS);
  if (huge) assert.equal(huge.params, undefined, '先丢 params');
});

test('normalizeMode：只认 fast', () => {
  assert.equal(normalizeMode('fast'), 'fast');
  assert.equal(normalizeMode('FAST'), undefined);
  assert.equal(normalizeMode('gpt-4'), undefined);
  assert.equal(normalizeMode(undefined), undefined);
});
