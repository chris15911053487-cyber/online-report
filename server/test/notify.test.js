const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, normalizeRecipients, buildDingCard, buildPlainText, previewText } = require('../src/notify');

/** 内存 store：记录写入；imIds = { 渠道: { 用户编码: IM 账号 } } */
function fakeStore(imIds = {}) {
  const db = { notifications: [], recipients: [], status: null };
  return {
    db,
    async insertNotification(n) {
      db.notifications.push(n);
      return db.notifications.length;
    },
    async insertRecipients(id, users) {
      for (const u of users) db.recipients.push({ id, u });
    },
    async lookupImIds(ch, users) {
      const m = imIds[ch] || {};
      return new Map(users.filter((u) => m[u]).map((u) => [u, m[u]]));
    },
    async saveImStatus(id, status) {
      db.status = Object.fromEntries(status);
    },
  };
}

const MSG = { sourceType: 'alert', sourceId: 7, sourceName: '库存预警', title: '物料低于安全库存', body: '- **A001**: 3', recipients: ['U1', 'U2', 'u1', ' ', 'U3'] };

test('normalizeRecipients：去空、按大小写去重、保留首次写法', () => {
  assert.deepEqual(normalizeRecipients(['U1', ' u1 ', '', null, 'U2']), ['U1', 'U2']);
});

test('notify：全部接收人进收件箱；钉钉只发绑定了的人，未绑定记 unbound', async () => {
  const store = fakeStore({ dingtalk: { U1: 'dd1', U2: 'dd2' } });
  const sent = [];
  const { notify } = createNotifier({
    store,
    senders: { dingtalk: async (uids, card) => (sent.push({ uids, card }), { failedUserIds: [] }) },
    baseUrl: () => 'https://erp.example.com',
  });
  const r = await notify({ ...MSG, channels: ['dingtalk'] });
  assert.deepEqual(store.db.recipients.map((x) => x.u), ['U1', 'U2', 'U3']);
  assert.deepEqual(sent[0].uids, ['dd1', 'dd2']);
  // 没给按钮：链接到系统里这条消息
  assert.equal(sent[0].card.btnUrl, 'https://erp.example.com/messages/1');
  assert.deepEqual(store.db.status, { U1: { dingtalk: 'sent' }, U2: { dingtalk: 'sent' }, U3: { dingtalk: 'unbound' } });
  assert.deepEqual(r, { notificationId: 1, recipients: 3, imSent: 2, unbound: 1, errors: [] });
});

test('notify：钉钉某批失败只标那批的人；异常不影响收件箱', async () => {
  const store = fakeStore({ dingtalk: { U1: 'dd1', U2: 'dd2' } });
  const { notify } = createNotifier({
    store,
    senders: { dingtalk: async () => ({ failedUserIds: ['dd2'], error: 'rate limit' }) },
    baseUrl: () => '',
  });
  const r = await notify({ ...MSG, recipients: ['U1', 'U2'], channels: ['dingtalk'] });
  assert.deepEqual(store.db.status, { U1: { dingtalk: 'sent' }, U2: { dingtalk: 'failed' } });
  assert.equal(r.imSent, 1);
  assert.deepEqual(r.errors, ['钉钉: rate limit']);

  const store2 = fakeStore({ dingtalk: { U1: 'dd1' } });
  const boom = createNotifier({ store: store2, senders: { dingtalk: async () => { throw new Error('网络错误'); } }, baseUrl: () => '' });
  const r2 = await boom.notify({ ...MSG, recipients: ['U1'], channels: ['dingtalk'] });
  assert.equal(store2.db.recipients.length, 1);
  assert.deepEqual(store2.db.status, { U1: { dingtalk: 'failed' } });
  assert.equal(r2.imSent, 0);
});

test('notify：企微逐人发文本；未知渠道忽略；不要 IM 时不写状态', async () => {
  const store = fakeStore({ wecom: { U1: 'wx1' } });
  const texts = [];
  const { notify } = createNotifier({
    store,
    senders: { wecom: async (uid, text) => (texts.push({ uid, text }), { success: true }) },
    baseUrl: () => '',
  });
  const r = await notify({ ...MSG, sourceType: 'report', recipients: ['U1', 'U2'], channels: ['wecom', 'sms'] });
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /^\*\*物料低于安全库存\*\*/);
  assert.deepEqual(store.db.status, { U1: { wecom: 'sent' }, U2: { wecom: 'unbound' } });
  assert.equal(r.imSent, 1);

  const store2 = fakeStore();
  const n2 = createNotifier({ store: store2, senders: {}, baseUrl: () => '' });
  const r2 = await n2.notify({ ...MSG, recipients: ['U1'] });
  assert.equal(store2.db.status, null);
  assert.equal(r2.unbound, 0);
});

test('notify：收件箱写入失败时 IM 照发，不带系统链接', async () => {
  const store = fakeStore({ dingtalk: { U1: 'dd1' } });
  store.insertNotification = async () => {
    throw new Error('Invalid object name notifications');
  };
  const cards = [];
  const { notify } = createNotifier({
    store,
    senders: { dingtalk: async (uids, card) => (cards.push(card), { failedUserIds: [] }) },
    baseUrl: () => 'https://erp.example.com',
    logger: {},
  });
  const r = await notify({ ...MSG, recipients: ['U1'], channels: ['dingtalk'] });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].btnUrl, undefined);
  assert.equal(store.db.status, null);
  assert.equal(r.notificationId, null);
  assert.equal(r.recipients, 0);
  assert.equal(r.imSent, 1);
  assert.match(r.errors[0], /收件箱写入失败/);
});

test('notify：没有接收人不写库；来源类型不认识报错', async () => {
  const store = fakeStore();
  const { notify } = createNotifier({ store, senders: {}, baseUrl: () => '' });
  assert.equal((await notify({ ...MSG, recipients: [] })).notificationId, null);
  assert.equal(store.db.notifications.length, 0);
  await assert.rejects(notify({ ...MSG, sourceType: 'spam' }), /未知的推送来源/);
});

test('buildDingCard / buildPlainText：调用方按钮优先，其次消息详情', () => {
  const c = { title: 'T', body: 'B', linkTitle: '查看详情', linkUrl: 'https://x/report' };
  assert.deepEqual(buildDingCard(c, 'https://x/messages/1'), { title: 'T', markdown: 'B', btnTitle: '查看详情', btnUrl: 'https://x/report' });
  assert.deepEqual(buildDingCard({ title: 'T', body: 'B' }, 'https://x/messages/1'), { title: 'T', markdown: 'B', btnTitle: '在系统中查看', btnUrl: 'https://x/messages/1' });
  assert.deepEqual(buildDingCard({ title: 'T', body: 'B' }, null), { title: 'T', markdown: 'B' });
  assert.equal(buildPlainText({ title: 'T', body: 'B' }, 'https://x/messages/1'), '**T**\n\nB\n\n[在系统中查看](https://x/messages/1)');
});

test('previewText：去掉 Markdown 记号压成一行', () => {
  assert.equal(previewText('**本月要点**\n\n- 销售额 [看板](https://x) 增长\n> 注意'), '本月要点 销售额 看板 增长 注意');
  assert.equal(previewText(''), '');
  assert.equal(previewText('a'.repeat(200)).length, 80);
});
