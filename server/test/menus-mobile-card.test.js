const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeMobileCard } = require('../src/routes/menus');

test('手机卡片布局：清洗后保存，单个字符串当一个候选', () => {
  const json = serializeMobileCard({
    title: ['DocEntry', '工序'],
    subtitle: '物料名称',
    meta: [['工序'], [], ['接单人员', '接单人']],
    progress: { done: ['完工数量'], total: [] },
    badgeTones: { 待接单: 'neutral', 坏: 'pink' },
    unknown: 1,
  });
  assert.deepEqual(JSON.parse(json), {
    title: ['DocEntry', '工序'],
    subtitle: ['物料名称'],
    meta: [['工序'], ['接单人员', '接单人']],
    badgeTones: { 待接单: 'neutral' },
  });
});

test('手机卡片布局：空值表示不用卡片，坏 JSON 或没有显示位置报错', () => {
  assert.equal(serializeMobileCard(null), null);
  assert.equal(serializeMobileCard(''), null);
  assert.equal(serializeMobileCard({}), null);
  assert.throws(() => serializeMobileCard('{bad'), /JSON 格式错误/);
  assert.throws(() => serializeMobileCard([]), /必须是 JSON 对象/);
  assert.throws(() => serializeMobileCard({ hidden: ['StepCode'] }), /至少要配置/);
});
