/**
 * 前端 URL 路由的服务端配合（/api 去前缀、SPA 回退）与界面设置接口。
 * 用真实 fastify + 真实 spa.js / ui-settings.js，db 换成内存假 pool。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function stub(rel, exports) {
  const file = require.resolve(path.join('../src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// ---- 内存「数据库」：app_settings / user_preferences ----
const db = { settings: new Map(), prefs: new Map() };
const fakeSql = new Proxy({}, { get: () => (...a) => ({ a }) });
function makeRequest() {
  const inputs = {};
  const req = {
    input(name, _type, value) {
      inputs[name] = value;
      return req;
    },
    async query(q) {
      if (q.includes('FROM dbo.app_settings')) {
        const v = db.settings.get(inputs.k);
        return { recordset: v == null ? [] : [{ setting_value: v }] };
      }
      if (q.includes('MERGE dbo.app_settings')) {
        db.settings.set(inputs.k, inputs.v);
        return { recordset: [] };
      }
      if (q.includes('SELECT pref_key')) {
        return { recordset: [...db.prefs].filter(([k]) => k.startsWith(`${inputs.u}|`)).map(([k, v]) => ({ pref_key: k.split('|')[1], pref_value: v })) };
      }
      if (q.includes('MERGE dbo.user_preferences')) {
        db.prefs.set(`${inputs.u}|${inputs.k}`, inputs.v);
        return { recordset: [] };
      }
      if (q.includes('DELETE FROM dbo.user_preferences')) {
        db.prefs.delete(`${inputs.u}|${inputs.k}`);
        return { recordset: [] };
      }
      throw new Error('unexpected sql: ' + q);
    },
  };
  return req;
}
stub('db.js', { getPool: async () => ({ request: makeRequest }), sql: fakeSql });

const Fastify = require('fastify');
const { stripApiPrefix, isSpaNavigation, registerSpaFallback } = require('../src/spa');
const uiSettingsRoutes = require('../src/routes/ui-settings');

const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
const indexPath = path.join(indexDir, 'index.html');
fs.writeFileSync(indexPath, '<!doctype html><html><head></head><body>SPA</body></html>');

async function buildApp() {
  const app = Fastify({ rewriteUrl: (req) => stripApiPrefix(req.url) });
  // 鉴权替身：x-test-user 头即登录用户；x-test-admin 为管理员
  app.decorate('authenticate', async (request, reply) => {
    const u = request.headers['x-test-user'];
    if (!u) return reply.code(401).send({ error: 'unauthorized' });
    request.user = { username: u };
  });
  app.decorate('requireAdmin', async (request, reply) => {
    if (!request.headers['x-test-admin']) return reply.code(403).send({ error: '需要管理员权限' });
    request.user = { username: 'ADMIN' };
  });
  registerSpaFallback(app, { indexPath });
  app.get('/agents', async () => ({ items: ['finance'] }));
  app.get('/download/android-app.apk', async () => 'APK');
  await app.register(uiSettingsRoutes);
  return app;
}

test('stripApiPrefix 只去掉 /api 前缀', () => {
  assert.equal(stripApiPrefix('/api/agents'), '/agents');
  assert.equal(stripApiPrefix('/api'), '/');
  assert.equal(stripApiPrefix('/api?x=1'), '/?x=1');
  assert.equal(stripApiPrefix('/agents'), '/agents');
  assert.equal(stripApiPrefix('/apiary'), '/apiary');
});

test('isSpaNavigation 只认浏览器页面导航', () => {
  const html = 'text/html,application/xhtml+xml';
  assert.equal(isSpaNavigation({ method: 'GET', url: '/report/pro-sign', accept: html }), true);
  assert.equal(isSpaNavigation({ method: 'GET', url: '/agents/finance?x=1', accept: html }), true);
  assert.equal(isSpaNavigation({ method: 'GET', url: '/agents', accept: '*/*' }), false);
  assert.equal(isSpaNavigation({ method: 'POST', url: '/report/x', accept: html }), false);
  assert.equal(isSpaNavigation({ method: 'GET', url: '/api/agents', accept: html }), false);
  assert.equal(isSpaNavigation({ method: 'GET', url: '/download/android-app.apk', accept: html }), false);
  assert.equal(isSpaNavigation({ method: 'GET', url: '/favicon.svg', accept: html }), false);
  assert.equal(isSpaNavigation({ method: 'GET', url: '/', accept: html }), false);
});

test('同名地址：浏览器导航拿页面，接口请求拿 JSON，/api 前缀可用', async () => {
  const app = await buildApp();
  const page = await app.inject({ method: 'GET', url: '/agents', headers: { accept: 'text/html' } });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /SPA/);

  const api = await app.inject({ method: 'GET', url: '/api/agents', headers: { accept: '*/*' } });
  assert.deepEqual(api.json(), { items: ['finance'] });

  const legacy = await app.inject({ method: 'GET', url: '/agents', headers: { accept: 'application/json' } });
  assert.deepEqual(legacy.json(), { items: ['finance'] });

  const deep = await app.inject({ method: 'GET', url: '/report/pro-sign/order/SO-1', headers: { accept: 'text/html' } });
  assert.equal(deep.statusCode, 200);
  assert.match(deep.body, /SPA/);

  const apk = await app.inject({ method: 'GET', url: '/download/android-app.apk', headers: { accept: 'text/html' } });
  assert.equal(apk.body, 'APK');
  await app.close();
});

test('界面设置：公司默认主题与用户偏好', async () => {
  const app = await buildApp();
  let r = await app.inject({ method: 'GET', url: '/api/ui/config' });
  assert.equal(r.json().defaultTheme, 'warm');

  r = await app.inject({ method: 'PUT', url: '/api/admin/ui-settings', payload: { defaultTheme: 'ent' } });
  assert.equal(r.statusCode, 403);
  r = await app.inject({ method: 'PUT', url: '/api/admin/ui-settings', headers: { 'x-test-admin': '1' }, payload: { defaultTheme: 'nope' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'PUT', url: '/api/admin/ui-settings', headers: { 'x-test-admin': '1' }, payload: { defaultTheme: 'ent' } });
  assert.equal(r.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ui/config' })).json().defaultTheme, 'ent');

  r = await app.inject({ method: 'PUT', url: '/api/me/preferences', payload: { theme: 'dark' } });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: { 'x-test-user': 'U1' }, payload: { theme: 'pink' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: { 'x-test-user': 'U1' }, payload: { fontSize: 'big' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: { 'x-test-user': 'U1' }, payload: { theme: 'system' } });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'GET', url: '/api/me/preferences', headers: { 'x-test-user': 'U1' } });
  assert.deepEqual(r.json().preferences, { theme: 'system' });
  r = await app.inject({ method: 'GET', url: '/api/me/preferences', headers: { 'x-test-user': 'U2' } });
  assert.deepEqual(r.json().preferences, {});

  r = await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: { 'x-test-user': 'U1' }, payload: { theme: null } });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'GET', url: '/api/me/preferences', headers: { 'x-test-user': 'U1' } });
  assert.deepEqual(r.json().preferences, {});
  await app.close();
});
