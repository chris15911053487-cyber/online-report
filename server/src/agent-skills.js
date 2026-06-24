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
function isMissingColumn(err) {
  return sqlErrorNumber(err) === 207;
}

// 表名/标识符（可选 schema 限定）：用于 allowed_tables 校验与 SQL 解析
const TABLE_IDENT_RE = /^[A-Za-z_#][\w#$]*(\.[A-Za-z_#][\w#$]*)?$/;
const MAX_ALLOWED_TABLES = 50;

/** 去方括号/引号、trim；返回标识符原文（不改大小写） */
function stripIdentifier(x) {
  return String(x || '')
    .replace(/[[\]"`]/g, '')
    .trim();
}

/** 规范化白名单：去重、去空、限制数量；非法标识符直接丢弃（在 validate 阶段报错） */
function normalizeTableList(input) {
  const arr = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/[\s,;]+/)
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = stripIdentifier(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_ALLOWED_TABLES) break;
  }
  return out;
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
    allowedTables: normalizeTableList(safeParseJson(row.allowed_tables_json, [])),
    producesDocument: !!row.produces_document,
    enabled: !!row.enabled,
    sortOrder: Number(row.sort_order) || 100,
  };
}

// SELECT 列：V2 含 allowed_tables_json；尚未跑迁移的库缺列报 207，回退 V1。
const SKILL_COLS_V2 =
  'name, description, body_md, resources_json, roles_json, allowed_tables_json, produces_document, enabled, sort_order';
const SKILL_COLS_V1 =
  'name, description, body_md, resources_json, roles_json, produces_document, enabled, sort_order';

/** 列出全部 skill（管理员后台用） */
async function listAllSkills(pool) {
  try {
    const rs = await pool.request().query(
      `SELECT ${SKILL_COLS_V2}
       FROM dbo.agent_skills
       ORDER BY sort_order ASC, name ASC`
    );
    return (rs.recordset || []).map(rowToSkill);
  } catch (err) {
    if (isMissingTable(err)) return [];
    if (isMissingColumn(err)) {
      const rs = await pool.request().query(
        `SELECT ${SKILL_COLS_V1}
         FROM dbo.agent_skills
         ORDER BY sort_order ASC, name ASC`
      );
      return (rs.recordset || []).map(rowToSkill);
    }
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
  const n = String(name || '').toLowerCase();
  try {
    const rs = await pool
      .request()
      .input('n', sql.NVarChar(64), n)
      .query(`SELECT ${SKILL_COLS_V2} FROM dbo.agent_skills WHERE name = @n`);
    const row = rs.recordset && rs.recordset[0];
    return row ? rowToSkill(row) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    if (isMissingColumn(err)) {
      const rs = await pool
        .request()
        .input('n', sql.NVarChar(64), n)
        .query(`SELECT ${SKILL_COLS_V1} FROM dbo.agent_skills WHERE name = @n`);
      const row = rs.recordset && rs.recordset[0];
      return row ? rowToSkill(row) : null;
    }
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
  // 表白名单：接受数组或"逗号/空格分隔"字符串；逐项校验为合法表标识符
  const rawTables = Array.isArray(input?.allowedTables)
    ? input.allowedTables
    : String(input?.allowedTables || '')
        .split(/[\s,;]+/)
        .filter(Boolean);
  for (const t of rawTables) {
    const id = stripIdentifier(t);
    if (id && !TABLE_IDENT_RE.test(id)) {
      return { ok: false, error: `allowedTables 含非法表名「${t}」（仅允许字母/数字/下划线，可加 schema. 前缀）` };
    }
  }
  const allowedTables = normalizeTableList(rawTables);
  const producesDocument = !!input?.producesDocument;
  const enabled = input?.enabled !== false;
  const sortOrder = Number.isFinite(Number(input?.sortOrder)) ? Number(input.sortOrder) : 100;
  return {
    ok: true,
    value: {
      name,
      description,
      bodyMd,
      roles,
      resources,
      allowedTables,
      producesDocument,
      enabled,
      sortOrder,
    },
  };
}

const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');

/** 新增或更新（按 name 幂等） */
async function upsertSkill(pool, value) {
  const allowedTablesJson = JSON.stringify(normalizeTableList(value.allowedTables || []));
  try {
    await pool
      .request()
      .input('name', sql.NVarChar(64), value.name)
      .input('description', sql.NVarChar(1024), value.description)
      .input('body_md', sql.NVarChar(sql.MAX), value.bodyMd)
      .input('resources_json', sql.NVarChar(sql.MAX), JSON.stringify(value.resources))
      .input('roles_json', sql.NVarChar(sql.MAX), JSON.stringify(value.roles))
      .input('allowed_tables_json', sql.NVarChar(sql.MAX), allowedTablesJson)
      .input('produces_document', sql.Bit, value.producesDocument)
      .input('enabled', sql.Bit, value.enabled)
      .input('sort_order', sql.Int, value.sortOrder)
      .query(`
        MERGE dbo.agent_skills AS t
        USING (SELECT @name AS name) AS s ON t.name = s.name
        WHEN MATCHED THEN UPDATE SET
          description = @description, body_md = @body_md,
          resources_json = @resources_json, roles_json = @roles_json,
          allowed_tables_json = @allowed_tables_json,
          produces_document = @produces_document, enabled = @enabled,
          sort_order = @sort_order, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
        WHEN NOT MATCHED THEN
          INSERT (name, description, body_md, resources_json, roles_json,
                  allowed_tables_json, produces_document, enabled, sort_order)
          VALUES (@name, @description, @body_md, @resources_json, @roles_json,
                  @allowed_tables_json, @produces_document, @enabled, @sort_order);
      `);
  } catch (err) {
    // 兼容尚未跑 migrate-agent-skill-allowed-tables.sql 的库：缺列(207)时回退不写白名单
    if (!isMissingColumn(err)) throw err;
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
  }
  return getSkill(pool, value.name);
}

async function deleteSkill(pool, name) {
  const rs = await pool
    .request()
    .input('n', sql.NVarChar(64), String(name || '').toLowerCase())
    .query(`DELETE FROM dbo.agent_skills WHERE name = @n`);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

/**
 * 从 SQL 中启发式提取 FROM / JOIN / APPLY 引用的基础表名（小写、去 schema/方括号）。
 * 用于 run_sql 表白名单校验——这是护栏式解析，不是完整 SQL 解析器：
 * - 先剥注释与字符串字面量，避免误匹配；
 * - 派生表（FROM (SELECT ...)）后紧跟 '(' 不会被捕获，天然跳过；
 * - WITH ... AS (...) 定义的 CTE 名会被收集并从结果中排除（CTE 不算外部表）。
 * 返回去重后的表名数组（小写）。
 */
function extractSqlTables(sqlText) {
  let s = String(sqlText || '');
  // 去注释（行内 -- 与块 /* */）
  s = s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // 去单引号字符串字面量（含 '' 转义）
  s = s.replace(/'(?:''|[^'])*'/g, "''");

  // 收集 CTE 名：WITH name AS ( 或 , name AS (
  const cteNames = new Set();
  const cteRe = /(?:\bWITH\b|,)\s*(\[?[A-Za-z_#][\w#$]*\]?)\s+AS\s*\(/gi;
  let cm;
  while ((cm = cteRe.exec(s)) !== null) {
    cteNames.add(stripIdentifier(cm[1]).toLowerCase());
  }

  // FROM / JOIN / [CROSS|OUTER] APPLY 后的表标识（可带 schema / 库名限定）
  const tables = new Set();
  const re =
    /\b(?:FROM|JOIN|APPLY)\s+(\[?[A-Za-z_#][\w#$]*\]?(?:\s*\.\s*\[?[A-Za-z_#][\w#$]*\]?){0,2})/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const parts = String(m[1])
      .split('.')
      .map((p) => stripIdentifier(p));
    const name = (parts[parts.length - 1] || '').toLowerCase();
    if (name && !cteNames.has(name)) tables.add(name);
  }
  return Array.from(tables);
}

/**
 * 校验 SQL 引用的表是否都在 skill 白名单内。
 * allowedTables 为空 = 不限制（返回 ok）。
 * 返回 { ok:true, used } 或 { ok:false, bad, used, allow }。
 */
function checkSqlTablesAllowed(sqlText, allowedTables) {
  const allow = new Set(normalizeTableList(allowedTables).map((t) => t.toLowerCase()));
  const used = extractSqlTables(sqlText);
  if (allow.size === 0) return { ok: true, used, allow: [] };
  const bad = used.filter((t) => !allow.has(t));
  if (bad.length > 0) return { ok: false, bad, used, allow: Array.from(allow) };
  return { ok: true, used, allow: Array.from(allow) };
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
  normalizeTableList,
  extractSqlTables,
  checkSqlTablesAllowed,
};
