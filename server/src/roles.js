const { getPool, sql } = require('./db');

const ROLE_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BUILTIN_ROLE_KEYS = new Set(['admin', 'operator']);

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}

function normalizeRoleKey(key) {
  const k = String(key || '')
    .trim()
    .toLowerCase();
  return ROLE_KEY_RE.test(k) ? k : null;
}

function normalizeRoleKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of keys) {
    const k = normalizeRoleKey(raw);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function isAdminUserCode(userCode) {
  const raw = process.env.ADMIN_USER_CODES || '';
  const codes = raw
    .split(/[,，]/)
    .map((s) => String(s).trim())
    .filter(Boolean);
  return codes.includes(String(userCode || '').trim());
}

/** JWT / request.user → 角色数组（兼容旧 token 仅含 role 字段） */
function getUserRolesFromRequest(user) {
  if (!user) return ['operator'];
  if (Array.isArray(user.roles) && user.roles.length > 0) {
    return normalizeRoleKeys(user.roles);
  }
  const role = String(user.role || 'operator').trim().toLowerCase();
  if (role === 'admin') return ['admin'];
  return role ? [role] : ['operator'];
}

function isAdminUser(user) {
  return getUserRolesFromRequest(user).includes('admin');
}

function primaryRoleFromRoles(roles) {
  const list = normalizeRoleKeys(roles);
  return list.includes('admin') ? 'admin' : 'operator';
}

function parseMenuRolesJson(s) {
  if (s == null) return [];
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return normalizeRoleKeys(a);
  } catch {
    return [];
  }
}

function menuRolesToJson(roles) {
  const list = normalizeRoleKeys(roles).sort();
  return JSON.stringify(list);
}

/** 用户是否可访问该菜单（menuRow.roles_json 或已解析的 menuRoles） */
function canAccessMenu(userRoles, menuRoles) {
  const u = normalizeRoleKeys(userRoles);
  const m = normalizeRoleKeys(menuRoles);
  if (m.length === 0) return false;
  if (u.includes('admin')) return true;
  return m.some((r) => u.includes(r));
}

function canAccessMenuRow(user, menuRow) {
  const menuRoles = parseMenuRolesJson(menuRow?.roles_json);
  return canAccessMenu(getUserRolesFromRequest(user), menuRoles);
}

async function resolveUserRoles(pool, userCode) {
  const code = String(userCode || '').trim();
  const roles = new Set();

  if (isAdminUserCode(code)) {
    roles.add('admin');
  }

  let hasDbRows = false;
  try {
    const rs = await pool
      .request()
      .input('code', sql.NVarChar(64), code)
      .query(`SELECT role_key FROM dbo.user_roles WHERE user_code = @code`);
    hasDbRows = (rs.recordset?.length || 0) > 0;
    for (const row of rs.recordset || []) {
      const k = normalizeRoleKey(row.role_key);
      if (k) roles.add(k);
    }
  } catch (err) {
    if (sqlErrorNumber(err) !== 208) throw err;
  }

  if (!hasDbRows && !roles.has('admin')) {
    roles.add('operator');
  }

  return [...roles].sort();
}

async function loadAppRoles(pool) {
  try {
    const rs = await pool.request().query(
      `SELECT role_key, label, sort_order, is_builtin
       FROM dbo.app_roles
       ORDER BY sort_order ASC, role_key ASC`
    );
    return (rs.recordset || []).map((row) => ({
      roleKey: String(row.role_key),
      label: String(row.label),
      sortOrder: Number(row.sort_order) || 0,
      isBuiltin: !!row.is_builtin,
    }));
  } catch (err) {
    if (sqlErrorNumber(err) === 208) {
      return [
        { roleKey: 'admin', label: '管理员', sortOrder: 10, isBuiltin: true },
        { roleKey: 'operator', label: '操作员', sortOrder: 20, isBuiltin: true },
      ];
    }
    throw err;
  }
}

async function loadKnownRoleKeys(pool) {
  const rows = await loadAppRoles(pool);
  return new Set(rows.map((r) => r.roleKey));
}

/** 校验菜单 roles 输入：须为 app_roles 中已定义的角色 */
async function normalizeMenuRolesInput(pool, roles) {
  const list = normalizeRoleKeys(roles);
  if (list.length === 0) return [];
  const known = await loadKnownRoleKeys(pool);
  return list.filter((r) => known.has(r));
}

module.exports = {
  ROLE_KEY_RE,
  BUILTIN_ROLE_KEYS,
  normalizeRoleKey,
  normalizeRoleKeys,
  isAdminUserCode,
  getUserRolesFromRequest,
  isAdminUser,
  primaryRoleFromRoles,
  parseMenuRolesJson,
  menuRolesToJson,
  canAccessMenu,
  canAccessMenuRow,
  resolveUserRoles,
  loadAppRoles,
  loadKnownRoleKeys,
  normalizeMenuRolesInput,
};
