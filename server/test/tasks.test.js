const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chinaToday,
  dateOnly,
  addDays,
  dueLabel,
  taskFromRow,
  planSync,
  effectiveStatus,
  buildOwnerDigest,
  buildTeamDigest,
  isSupervisorOf,
  describeSync,
} = require('../src/tasks');

const TODAY = '2026-10-22';
const RULE = {
  id: 3,
  name: '超期工单',
  key_column: 'DocNum',
  owner_column: 'Planner',
  due_column: null,
  due_days: 1,
  card_title_template: '工单 {DocNum} 已超期',
  card_body_template: '- 物料：{ItemCode}',
  card_btn_url: '/report/wo?doc={DocNum}',
};

function item(key, extra = {}) {
  return { itemKey: key, title: `T${key}`, ownerCode: 'U1', dueFromColumn: false, ...extra };
}

test('chinaToday：按东八区取日期（UTC 16:30 已是第二天）', () => {
  assert.equal(chinaToday(new Date('2026-10-21T16:30:00Z')), '2026-10-22');
});

test('dateOnly：Date / 字符串 / 斜杠写法 / 无效值', () => {
  assert.equal(dateOnly(new Date('2026-10-25T00:00:00Z')), '2026-10-25');
  assert.equal(dateOnly('2026/1/5 08:00'), '2026-01-05');
  assert.equal(dateOnly('abc'), null);
  assert.equal(dateOnly(null), null);
});

test('dueLabel：超期 / 今天 / 明天 / 之后', () => {
  assert.equal(dueLabel('2026-10-19', TODAY), '超期 3 天');
  assert.equal(dueLabel(TODAY, TODAY), '今天到期');
  assert.equal(dueLabel('2026-10-23', TODAY), '明天到期');
  assert.equal(dueLabel('2026-10-30', TODAY), '10-30 到期');
  assert.equal(dueLabel(null, TODAY), '');
});

test('taskFromRow：模板渲染、负责人、没有到期日列时按 due_days 推算', () => {
  const t = taskFromRow(RULE, { DocNum: 1001, ItemCode: 'A01', Planner: ' wang ' }, TODAY);
  assert.equal(t.itemKey, '1001');
  assert.equal(t.title, '工单 1001 已超期');
  assert.equal(t.body, '- 物料：A01');
  assert.equal(t.linkUrl, '/report/wo?doc=1001');
  assert.equal(t.ownerRaw, 'wang');
  assert.equal(t.dueDate, '2026-10-23');
  assert.equal(t.dueFromColumn, false);
});

test('taskFromRow：有到期日列时用列值；没标题模板时用规则名 + 单据号', () => {
  const rule = { ...RULE, due_column: 'DueDate', card_title_template: '' };
  const t = taskFromRow(rule, { DocNum: 'X1', DueDate: new Date('2026-10-20T00:00:00Z'), Planner: 'U1' }, TODAY);
  assert.equal(t.dueDate, '2026-10-20');
  assert.equal(t.dueFromColumn, true);
  assert.equal(t.title, '超期工单：X1');
});

test('planSync：新出现的新建、已有的更新、查不到的关闭（全量）', () => {
  const existing = [
    { id: 1, itemKey: 'A', status: 'open', ownerCode: 'U1', ownerLocked: false },
    { id: 2, itemKey: 'B', status: 'snoozed', ownerCode: 'U1', ownerLocked: false },
    { id: 3, itemKey: 'C', status: 'done', doneDate: '2026-10-21', ownerCode: 'U1', ownerLocked: false },
  ];
  const p = planSync(existing, [item('A'), item('D')], { today: TODAY, full: true });
  assert.deepEqual(p.creates.map((x) => x.itemKey), ['D']);
  assert.deepEqual(p.updates.map((x) => x.id), [1]);
  assert.equal(p.updates[0].status, undefined);
  assert.deepEqual(p.closes, [2, 3]);
});

test('planSync：事件触发（非全量）不关闭', () => {
  const existing = [{ id: 1, itemKey: 'A', status: 'open', ownerCode: 'U1', ownerLocked: false }];
  const p = planSync(existing, [item('B')], { today: TODAY, full: false });
  assert.deepEqual(p.closes, []);
});

test('planSync：已处理但第二天数据里还在 → 重新打开；当天标的不动', () => {
  const existing = [
    { id: 1, itemKey: 'A', status: 'done', doneDate: '2026-10-21', ownerCode: 'U1', ownerLocked: false },
    { id: 2, itemKey: 'B', status: 'done', doneDate: TODAY, ownerCode: 'U1', ownerLocked: false },
    { id: 3, itemKey: 'C', status: 'closed', ownerCode: 'U1', ownerLocked: false },
  ];
  const p = planSync(existing, [item('A'), item('B'), item('C')], { today: TODAY, full: true });
  const byId = Object.fromEntries(p.updates.map((u) => [u.id, u]));
  assert.equal(byId[1].status, 'open');
  assert.equal(byId[1].events[0].action, 'reopen');
  assert.equal(byId[2].status, undefined);
  assert.equal(byId[3].status, 'open');
});

test('planSync：转交过的不按数据改负责人；没转交的负责人变了记一笔', () => {
  const existing = [
    { id: 1, itemKey: 'A', status: 'open', ownerCode: 'U9', ownerLocked: true },
    { id: 2, itemKey: 'B', status: 'open', ownerCode: 'U1', ownerLocked: false },
  ];
  const p = planSync(existing, [item('A', { ownerCode: 'U2' }), item('B', { ownerCode: 'U2' })], { today: TODAY, full: true });
  const byId = Object.fromEntries(p.updates.map((u) => [u.id, u]));
  assert.equal(byId[1].setOwner, false);
  assert.deepEqual(byId[1].events, []);
  assert.equal(byId[2].setOwner, true);
  assert.equal(byId[2].events[0].action, 'transfer');
});

test('planSync：同一单据重复行只算一次，空键跳过', () => {
  const p = planSync([], [item('A'), item('A'), item('')], { today: TODAY, full: true });
  assert.equal(p.creates.length, 1);
});

test('effectiveStatus：延后到期视为待处理', () => {
  assert.equal(effectiveStatus({ status: 'snoozed', snoozeUntil: TODAY }, TODAY), 'open');
  assert.equal(effectiveStatus({ status: 'snoozed', snoozeUntil: '2026-10-23' }, TODAY), 'snoozed');
});

test('buildOwnerDigest：早上列最紧急 5 条 + 超期数；下午只提醒今天到期和超期的', () => {
  const tasks = [
    { id: 1, title: '远期', dueDate: '2026-10-30' },
    { id: 2, title: '超期', dueDate: '2026-10-20' },
    { id: 3, title: '今天', dueDate: TODAY },
    ...[4, 5, 6, 7].map((id) => ({ id, title: `其他${id}`, dueDate: '2026-10-25' })),
  ];
  const m = buildOwnerDigest(tasks, TODAY, { kind: 'morning' });
  assert.equal(m.title, '今日待办 7 条（超期 1）');
  const lines = m.body.split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /超期 2 天.*超期/);
  assert.match(lines[1], /今天到期/);
  assert.equal(lines[5], '- …还有 2 条');

  const a = buildOwnerDigest(tasks, TODAY, { kind: 'afternoon' });
  assert.equal(a.title, '下午提醒：还有 2 条待办今天要处理（超期 1）');
  assert.equal(buildOwnerDigest([{ id: 1, title: 'x', dueDate: '2026-10-30' }], TODAY, { kind: 'afternoon' }), null);
  assert.equal(buildOwnerDigest([], TODAY), null);
});

test('buildTeamDigest：各人统计、升级、未分配、周统计', () => {
  const tasks = [
    { id: 1, title: 'a', dueDate: '2026-10-20', ownerCode: 'U1' },
    { id: 2, title: 'b', dueDate: TODAY, ownerCode: 'U1' },
    { id: 3, title: 'c', dueDate: TODAY, ownerCode: null },
  ];
  const d = buildTeamDigest(tasks, TODAY, {
    escalations: [tasks[0]],
    weekStats: [{ ownerCode: 'U1', created: 4, completed: 3, overdue: 1 }],
  });
  assert.equal(d.title, '团队待办 3 条（超期 1），升级 1');
  assert.match(d.body, /U1：2 条，超期 1/);
  assert.match(d.body, /超期升级（1）/);
  assert.match(d.body, /未分配负责人（1）/);
  assert.match(d.body, /新增 4，完成 3（75%），超期 1/);
  assert.equal(buildTeamDigest([], TODAY), null);
});

test('isSupervisorOf：指定用户优先（不区分大小写），否则看角色', () => {
  const byUser = { target_users_json: '["Boss"]', target_roles_json: '["production"]' };
  assert.equal(isSupervisorOf(byUser, 'boss', ['operator']), true);
  assert.equal(isSupervisorOf(byUser, 'x', ['production']), false);
  const byRole = { target_users_json: null, target_roles_json: '["production"]' };
  assert.equal(isSupervisorOf(byRole, 'x', ['production']), true);
  assert.equal(isSupervisorOf({}, 'x', ['production']), false);
});

test('describeSync / addDays', () => {
  assert.equal(describeSync({ created: 2, updated: 5, reopened: 1, closed: 0, unassigned: 1, truncated: false }), '待办：新增 2，更新 5，重新打开 1，关闭 0，未分配负责人 1');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('planSync：关闭后又出现，到期日重新算', () => {
  const existing = [{ id: 1, itemKey: 'A', status: 'closed', ownerCode: 'U1', ownerLocked: false, dueDate: '2026-01-06' }];
  const p = planSync(existing, [item('A', { dueDate: '2026-10-23' })], { today: TODAY, full: true });
  assert.equal(p.updates[0].status, 'open');
  assert.equal(p.updates[0].setDue, true);
});

test('planSync：内容没变标为 unchanged（只批量更新 last_seen）', () => {
  const same = { title: 'TA', body: 'b', linkUrl: null, data: '{}', dueDate: '2026-10-23' };
  const existing = [{ id: 1, itemKey: 'A', status: 'open', ownerCode: 'U1', ownerLocked: false, ...same }];
  const p1 = planSync(existing, [item('A', same)], { today: TODAY, full: true });
  assert.equal(p1.updates[0].unchanged, true);
  const p2 = planSync(existing, [item('A', { ...same, title: '改了' })], { today: TODAY, full: true });
  assert.equal(p2.updates[0].unchanged, false);
});
