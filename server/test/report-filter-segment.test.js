const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFilterSchemaJson } = require('../src/report-query');

test('筛选字段：segment + allLabel（工序：空 = 生产工序）', () => {
  const r = parseFilterSchemaJson([
    {
      name: 'SetupCode',
      label: '工序',
      type: 'string',
      segment: true,
      allLabel: '生产工序',
      options: [
        { name: '返工单', code: 'Z0' },
        { name: '无订单工序', code: 'Z1' },
      ],
    },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.fields[0].segment, true);
  assert.equal(r.fields[0].allLabel, '生产工序');
});

test('筛选字段：segment 没有选项时报错', () => {
  const r = parseFilterSchemaJson([{ name: 'X', type: 'string', segment: true }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /segment/);
});

test('筛选字段：pin 原样保留', () => {
  const r = parseFilterSchemaJson([{ name: 'HEMCode', type: 'string', pin: true }]);
  assert.equal(r.ok, true);
  assert.equal(r.fields[0].pin, true);
});
