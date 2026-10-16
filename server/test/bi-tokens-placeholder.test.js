const test = require('node:test');
const assert = require('node:assert/strict');
const { filterDisplayText, fillPlaceholders } = require('../src/bi-tokens');

test('filterDisplayText：select 取选项文字（值类型不同也能对上），其余原样，空值跳过', () => {
  const filters = [
    { name: 'cmp', type: 'select', options: [{ value: 'yoy', label: '同比' }, { value: 'mom', label: '环比' }] },
    { name: 'year', type: 'select', options: [{ value: 2026, label: '2026 年' }] },
    { name: 'period', type: 'month' },
    { name: 'empty', type: 'string' },
  ];
  assert.deepEqual(filterDisplayText(filters, { cmp: 'mom', year: '2026', period: '2026-10', empty: '' }), { cmp: '环比', year: '2026 年', period: '2026-10' });
});

test('fillPlaceholders：大小写不敏感；没有值的占位符与非占位符的花括号原样保留', () => {
  assert.equal(fillPlaceholders('对比{CMP}（{period}）', { cmp: '去年同期', period: '2026-10' }), '对比去年同期（2026-10）');
  assert.equal(fillPlaceholders('{nope} {a b} {}', { cmp: 'x' }), '{nope} {a b} {}');
  assert.equal(fillPlaceholders(null, {}), '');
});
