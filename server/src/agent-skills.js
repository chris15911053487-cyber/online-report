/**
 * agent_skills 数据访问：Skill 注册表的增删改查 + 按角色过滤。
 * Skill 为"纯指令型"（body_md 工作流/规范），执行落到白名单 tool，本模块不执行任何脚本。
 */
const { getPool, sql } = require('./db');
const { normalizeRoleKeys } = require('./roles');

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BODY_LINES = 500;

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}
function isMissingTable(err) {
  return sqlErrorNumber(err) === 208;
}

function safeParseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function rowToSkill(row) {
  return {
    name: String(row.name),
    description: String(row.description || ''),
    bodyMd: String(row.body_md || ''),
    resources: safeParseJson(row.resources_json, {}),
    roles: normalizeRoleKeys(safeParseJson(row.roles_json, [])),
    producesDocument: !!row.produces_document,
    enabled: !!row.enabled,
    sortOrder: Number(row.sort_order) || 100,
  };
}

/** 列出全部 skill（管理员后台用） */
async function listAllSkills(pool) {
  try {
    const rs = await pool.request().query(
      `SELECT name, description, body_md, resources_json, roles_json,
              produces_document, enabled, sort_order
       FROM dbo.agent_skills
       ORDER BY sort_order ASC, name ASC`
    );
    return (rs.recordset || []).map(rowToSkill);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * skill 门禁：管理员始终可用；roles 为空 = 仅管理员（与管理界面「不选=仅管理员」一致）。
 * 注意与 canAccessMenu 不同——后者 roles 为空时对所有人（含管理员）关闭。
 */
function canUseSkill(userRoles, skillRoles) {
  const u = normalizeRoleKeys(userRoles);
  if (u.includes('admin')) return true;
  const m = normalizeRoleKeys(skillRoles);
  return m.some((r) => u.includes(r));
}

/** 列出某用户角色可用且启用的 skill（注入 Agent system prompt 用，第 1 层权限） */
async function listSkillsForRoles(pool, userRoles) {
  const all = await listAllSkills(pool);
  return all.filter((s) => s.enabled && canUseSkill(userRoles, s.roles));
}

async function getSkill(pool, name) {
  try {
    const rs = await pool
      .request()
      .input('n', sql.NVarChar(64), String(name || '').toLowerCase())
      .query(
        `SELECT name, description, body_md, resources_json, roles_json,
                produces_document, enabled, sort_order
         FROM dbo.agent_skills WHERE name = @n`
      );
    const row = rs.recordset && rs.recordset[0];
    return row ? rowToSkill(row) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** 校验输入。返回 { ok, error?, value? } */
function validateSkillInput(input) {
  const name = String(input?.name || '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, error: 'name 须为小写字母开头、仅含小写字母/数字/连字符、≤64 字符' };
  }
  const description = String(input?.description || '').trim();
  if (!description) return { ok: false, error: 'description 不能为空' };
  if (description.length > 1024) return { ok: false, error: 'description 不能超过 1024 字符' };
  const bodyMd = String(input?.bodyMd || '').trim();
  if (!bodyMd) return { ok: false, error: 'bodyMd（SKILL.md 正文）不能为空' };
  if (bodyMd.split('\n').length > MAX_BODY_LINES) {
    return { ok: false, error: `bodyMd 不能超过 ${MAX_BODY_LINES} 行（请用渐进式披露拆分）` };
  }
  // 安全红线：导入的 skill 不接受随包运行的脚本，避免供应链风险
  if (/```\s*(bash|sh|python|py|powershell|ps1)\b/i.test(bodyMd)) {
    return {
      ok: false,
      error: '出于安全考虑，skill 正文不可包含可执行脚本（bash/python 等）。请改为描述应调用哪个白名单工具。',
    };
  }
  const roles = normalizeRoleKeys(Array.isArray(input?.roles) ? input.roles : []);
  const resources =
    input?.resources && typeof input.resources === 'object' ? input.resources : {};
  const producesDocument = !!input?.producesDocument;
  const enabled = input?.enabled !== false;
  const sortOrder = Number.isFinite(Number(input?.sortOrder)) ? Number(input.sortOrder) : 100;
  return {
    ok: true,
    value: { name, description, bodyMd, roles, resources, producesDocument, enabled, sortOrder },
  };
}

const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');

/** 新增或更新（按 name 幂等） */
async function upsertSkill(pool, value) {
  await pool
    .request()
    .input('name', sql.NVarChar(64), value.name)
    .input('description', sql.NVarChar(1024), value.description)
    .input('body_md', sql.NVarChar(sql.MAX), value.bodyMd)
    .input('resources_json', sql.NVarChar(sql.MAX), JSON.stringify(value.resources))
    .input('roles_json', sql.NVarChar(sql.MAX), JSON.stringify(value.roles))
    .input('produces_document', sql.Bit, value.producesDocument)
    .input('enabled', sql.Bit, value.enabled)
    .input('sort_order', sql.Int, value.sortOrder)
    .query(`
      MERGE dbo.agent_skills AS t
      USING (SELECT @name AS name) AS s ON t.name = s.name
      WHEN MATCHED THEN UPDATE SET
        description = @description, body_md = @body_md,
        resources_json = @resources_json, roles_json = @roles_json,
        produces_document = @produces_document, enabled = @enabled,
        sort_order = @sort_order, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
      WHEN NOT MATCHED THEN
        INSERT (name, description, body_md, resources_json, roles_json,
                produces_document, enabled, sort_order)
        VALUES (@name, @description, @body_md, @resources_json, @roles_json,
                @produces_document, @enabled, @sort_order);
    `);
  return getSkill(pool, value.name);
}

async function deleteSkill(pool, name) {
  const rs = await pool
    .request()
    .input('n', sql.NVarChar(64), String(name || '').toLowerCase())
    .query(`DELETE FROM dbo.agent_skills WHERE name = @n`);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

module.exports = {
  SKILL_NAME_RE,
  canUseSkill,
  listAllSkills,
  listSkillsForRoles,
  getSkill,
  validateSkillInput,
  upsertSkill,
  deleteSkill,
};
