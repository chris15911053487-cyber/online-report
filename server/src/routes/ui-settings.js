/**
 * 界面设置 API。
 *
 *   - GET  /ui/config            免登录：公司默认主题等（登录页也要用）
 *   - GET  /me/preferences       当前用户偏好（如所选主题）
 *   - PUT  /me/preferences       保存当前用户偏好（只接受白名单键）
 *   - PUT  /admin/ui-settings    管理员设置公司默认主题
 *
 * 表不存在（未迁移）时读接口返回默认值，不影响登录与使用。
 */
const { getPool, sql } = require('../db');
const { SQL_CHINA_LOCAL_NOW_EXPR } = require('../china-datetime');

const THEME_IDS = ['warm', 'tech', 'ent', 'ind', 'mono', 'dark'];
const DEFAULT_THEME = 'warm';

/** 用户偏好白名单：键 → 校验函数 */
const PREF_VALIDATORS = {
  theme: (v) => v === 'system' || THEME_IDS.includes(v),
};

const isMissingTable = (err) => (err?.number ?? err?.originalError?.info?.number) === 208;

async function readCompanyTheme(pool) {
  try {
    const r = await pool
      .request()
      .input('k', sql.NVarChar(64), 'default_theme')
      .query('SELECT setting_value FROM dbo.app_settings WHERE setting_key = @k');
    const v = r.recordset[0]?.setting_value;
    return THEME_IDS.includes(v) ? v : DEFAULT_THEME;
  } catch (err) {
    if (isMissingTable(err)) return DEFAULT_THEME;
    throw err;
  }
}

/** 校验偏好入参：只保留白名单内且合法的键；null 表示清除 */
function validatePreferences(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '参数须为对象' };
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    const check = PREF_VALIDATORS[k];
    if (!check) return { ok: false, error: `不支持的偏好项：${k}` };
    if (v !== null && !check(v)) return { ok: false, error: `偏好项 ${k} 的值不合法` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

async function uiSettingsRoutes(fastify) {
  fastify.get('/ui/config', async () => {
    const pool = await getPool();
    return { defaultTheme: await readCompanyTheme(pool), themes: THEME_IDS };
  });

  fastify.get('/me/preferences', { preHandler: [fastify.authenticate] }, async (request) => {
    const pool = await getPool();
    try {
      const r = await pool
        .request()
        .input('u', sql.NVarChar(64), String(request.user?.username || ''))
        .query('SELECT pref_key, pref_value FROM dbo.user_preferences WHERE user_code = @u');
      const prefs = {};
      for (const row of r.recordset) {
        if (PREF_VALIDATORS[row.pref_key]) prefs[row.pref_key] = row.pref_value;
      }
      return { preferences: prefs };
    } catch (err) {
      if (isMissingTable(err)) return { preferences: {} };
      throw err;
    }
  });

  fastify.put('/me/preferences', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parsed = validatePreferences(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error, code: 'BAD_PREFERENCE' });
    const userCode = String(request.user?.username || '');
    const pool = await getPool();
    for (const [key, value] of Object.entries(parsed.value)) {
      const req = pool.request().input('u', sql.NVarChar(64), userCode).input('k', sql.NVarChar(64), key);
      if (value === null) {
        await req.query('DELETE FROM dbo.user_preferences WHERE user_code = @u AND pref_key = @k');
      } else {
        await req.input('v', sql.NVarChar(1024), String(value)).query(`
          MERGE dbo.user_preferences AS t
          USING (SELECT @u AS user_code, @k AS pref_key) AS s
            ON t.user_code = s.user_code AND t.pref_key = s.pref_key
          WHEN MATCHED THEN UPDATE SET pref_value = @v, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
          WHEN NOT MATCHED THEN INSERT (user_code, pref_key, pref_value) VALUES (@u, @k, @v);`);
      }
    }
    return { success: true, preferences: parsed.value };
  });

  fastify.put('/admin/ui-settings', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const theme = request.body?.defaultTheme;
    if (!THEME_IDS.includes(theme)) return reply.code(400).send({ error: '默认主题不合法', code: 'BAD_THEME' });
    const pool = await getPool();
    await pool
      .request()
      .input('k', sql.NVarChar(64), 'default_theme')
      .input('v', sql.NVarChar(1024), theme)
      .input('by', sql.NVarChar(64), String(request.user?.username || ''))
      .query(`
        MERGE dbo.app_settings AS t
        USING (SELECT @k AS setting_key) AS s ON t.setting_key = s.setting_key
        WHEN MATCHED THEN UPDATE SET setting_value = @v, updated_by = @by, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
        WHEN NOT MATCHED THEN INSERT (setting_key, setting_value, updated_by) VALUES (@k, @v, @by);`);
    return { success: true, defaultTheme: theme };
  });
}

module.exports = uiSettingsRoutes;
module.exports.validatePreferences = validatePreferences;
module.exports.THEME_IDS = THEME_IDS;
