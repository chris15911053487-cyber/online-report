const { getPool, sql } = require('../db');
const {
  normalizeRoleKey,
  normalizeRoleKeys,
  BUILTIN_ROLE_KEYS,
  loadAppRoles,
  resolveUserRoles,
} = require('../roles');

function isInvalidColumnError(err) {
  const n = err?.number ?? err?.originalError?.info?.number;
  if (n === 207) return true;
  return typeof err?.message === 'string' && err.message.includes('Invalid column name');
}

async function searchOusrUsers(pool, q, limit = 50) {
  const term = String(q || '').trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\[\]]/g, (c) => `[${c}]`)}%`;
  try {
    const rs = await pool
      .request()
      .input('like', sql.NVarChar(128), like)
      .input('lim', sql.Int, Math.min(Math.max(limit, 1), 100))
      .query(
        `SELECT TOP (@lim) [USER_CODE] AS user_code, [U_NAME] AS u_name
         FROM [OUSR]
         WHERE [USER_CODE] LIKE @like OR [U_NAME] LIKE @like
         ORDER BY [USER_CODE]`
      );
    return (rs.recordset || []).map((row) => ({
      userCode: String(row.user_code),
      displayName:
        row.u_name != null && String(row.u_name).trim() !== ''
          ? String(row.u_name).trim()
          : String(row.user_code),
    }));
  } catch (e) {
    if (isInvalidColumnError(e)) {
      const rs = await pool
        .request()
        .input('like', sql.NVarChar(128), like)
        .input('lim', sql.Int, Math.min(Math.max(limit, 1), 100))
        .query(
          `SELECT TOP (@lim) [USER_CODE] AS user_code
           FROM [OUSR]
           WHERE [USER_CODE] LIKE @like
           ORDER BY [USER_CODE]`
        );
      return (rs.recordset || []).map((row) => ({
        userCode: String(row.user_code),
        displayName: String(row.user_code),
      }));
    }
    throw e;
  }
}

async function rolesAdminRoutes(fastify) {
  fastify.get(
    '/admin/roles',
    { preHandler: [fastify.requireAdmin] },
    async () => {
      const pool = await getPool();
      const items = await loadAppRoles(pool);
      return { items };
    }
  );

  fastify.post(
    '/admin/roles',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const body = request.body || {};
      const roleKey = normalizeRoleKey(body.roleKey);
      const label = String(body.label || '').trim();
      const sortOrder = Number(body.sortOrder);
      if (!roleKey) {
        return reply.code(400).send({ error: 'roleKey 须为小写字母开头的标识', code: 'ROLE_BAD_KEY' });
      }
      if (!label) {
        return reply.code(400).send({ error: '请填写角色名称', code: 'ROLE_BAD_LABEL' });
      }
      if (BUILTIN_ROLE_KEYS.has(roleKey) && roleKey !== body.roleKey) {
        return reply.code(400).send({ error: '内置角色不可重复创建', code: 'ROLE_BUILTIN' });
      }

      const pool = await getPool();
      try {
        await pool
          .request()
          .input('key', sql.NVarChar(32), roleKey)
          .input('label', sql.NVarChar(64), label.slice(0, 64))
          .input('sort', sql.Int, Number.isFinite(sortOrder) ? sortOrder : 100)
          .query(
            `INSERT INTO dbo.app_roles (role_key, label, sort_order, is_builtin)
             VALUES (@key, @label, @sort, 0)`
          );
      } catch (err) {
        if (err?.number === 2627) {
          return reply.code(409).send({ error: '角色标识已存在', code: 'ROLE_EXISTS' });
        }
        throw err;
      }
      return { roleKey, label: label.slice(0, 64), sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100, isBuiltin: false };
    }
  );

  fastify.patch(
    '/admin/roles/:roleKey',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const roleKey = normalizeRoleKey(request.params.roleKey);
      if (!roleKey) {
        return reply.code(400).send({ error: '无效 roleKey', code: 'ROLE_BAD_KEY' });
      }
      const body = request.body || {};
      const label = body.label != null ? String(body.label).trim() : null;
      const sortOrder = body.sortOrder != null ? Number(body.sortOrder) : null;
      if (label === '') {
        return reply.code(400).send({ error: '角色名称不能为空', code: 'ROLE_BAD_LABEL' });
      }

      const pool = await getPool();
      const sets = [];
      const req = pool.request().input('key', sql.NVarChar(32), roleKey);
      if (label != null) {
        sets.push('label = @label');
        req.input('label', sql.NVarChar(64), label.slice(0, 64));
      }
      if (sortOrder != null && Number.isFinite(sortOrder)) {
        sets.push('sort_order = @sort');
        req.input('sort', sql.Int, sortOrder);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: '无更新字段', code: 'ROLE_NOTHING_TO_UPDATE' });
      }

      const rs = await req.query(
        `UPDATE dbo.app_roles SET ${sets.join(', ')} WHERE role_key = @key;
         SELECT role_key, label, sort_order, is_builtin FROM dbo.app_roles WHERE role_key = @key`
      );
      const row = rs.recordset?.[0];
      if (!row) {
        return reply.code(404).send({ error: '角色不存在', code: 'ROLE_NOT_FOUND' });
      }
      return {
        roleKey: String(row.role_key),
        label: String(row.label),
        sortOrder: Number(row.sort_order) || 0,
        isBuiltin: !!row.is_builtin,
      };
    }
  );

  fastify.delete(
    '/admin/roles/:roleKey',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const roleKey = normalizeRoleKey(request.params.roleKey);
      if (!roleKey) {
        return reply.code(400).send({ error: '无效 roleKey', code: 'ROLE_BAD_KEY' });
      }
      if (BUILTIN_ROLE_KEYS.has(roleKey)) {
        return reply.code(400).send({ error: '内置角色不可删除', code: 'ROLE_BUILTIN' });
      }

      const pool = await getPool();
      const inUse = await pool
        .request()
        .input('key', sql.NVarChar(32), roleKey)
        .query(`SELECT COUNT(1) AS cnt FROM dbo.user_roles WHERE role_key = @key`);
      if ((inUse.recordset?.[0]?.cnt || 0) > 0) {
        return reply.code(400).send({ error: '仍有用户持有该角色，请先解除分配', code: 'ROLE_IN_USE' });
      }

      const rs = await pool
        .request()
        .input('key', sql.NVarChar(32), roleKey)
        .query(`DELETE FROM dbo.app_roles WHERE role_key = @key AND is_builtin = 0`);
      if ((rs.rowsAffected?.[0] || 0) === 0) {
        return reply.code(404).send({ error: '角色不存在或为内置角色', code: 'ROLE_NOT_FOUND' });
      }
      return { success: true };
    }
  );

  fastify.get(
    '/admin/user-roles',
    { preHandler: [fastify.requireAdmin] },
    async (request) => {
      const q = String(request.query?.q || '').trim();
      const pool = await getPool();
      if (q) {
        const users = await searchOusrUsers(pool, q, 30);
        const out = [];
        for (const u of users) {
          const roles = await resolveUserRoles(pool, u.userCode);
          out.push({ userCode: u.userCode, displayName: u.displayName, roles });
        }
        return { items: out };
      }

      const rs = await pool.request().query(
        `SELECT ur.user_code, ur.role_key
         FROM dbo.user_roles ur
         ORDER BY ur.user_code, ur.role_key`
      );
      const map = new Map();
      for (const row of rs.recordset || []) {
        const code = String(row.user_code);
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(String(row.role_key));
      }
      const items = [];
      for (const [userCode, roles] of map) {
        items.push({ userCode, roles: [...new Set(roles)].sort() });
      }
      return { items };
    }
  );

  fastify.get(
    '/admin/user-roles/:userCode',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const userCode = String(request.params.userCode || '').trim();
      if (!userCode) {
        return reply.code(400).send({ error: '请提供 userCode', code: 'USER_ROLE_BAD_REQUEST' });
      }
      const pool = await getPool();
      const roles = await resolveUserRoles(pool, userCode);
      const rs = await pool
        .request()
        .input('code', sql.NVarChar(64), userCode)
        .query(`SELECT role_key FROM dbo.user_roles WHERE user_code = @code ORDER BY role_key`);
      const assigned = (rs.recordset || []).map((r) => String(r.role_key));
      return { userCode, roles, assignedRoles: assigned };
    }
  );

  fastify.put(
    '/admin/user-roles/:userCode',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const userCode = String(request.params.userCode || '').trim();
      if (!userCode) {
        return reply.code(400).send({ error: '请提供 userCode', code: 'USER_ROLE_BAD_REQUEST' });
      }
      const roles = normalizeRoleKeys(request.body?.roles);
      const filtered = roles.filter((r) => r !== 'admin');
      if (filtered.length === 0 && roles.length > 0) {
        return reply.code(400).send({
          error: 'admin 角色由 ADMIN_USER_CODES 环境变量控制，不可在此分配',
          code: 'USER_ROLE_ADMIN_ENV',
        });
      }

      const pool = await getPool();
      const row = await fetchOusrRowExists(pool, userCode);
      if (!row) {
        return reply.code(404).send({ error: '用户不存在于 OUSR', code: 'USER_NOT_FOUND' });
      }

      const known = await loadAppRoles(pool);
      const knownKeys = new Set(known.map((r) => r.roleKey));
      const toSave = filtered.filter((r) => knownKeys.has(r));
      if (toSave.length === 0 && filtered.length > 0) {
        return reply.code(400).send({ error: '角色无效或未定义', code: 'USER_ROLE_INVALID' });
      }

      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        await new sql.Request(tx)
          .input('code', sql.NVarChar(64), userCode)
          .query(`DELETE FROM dbo.user_roles WHERE user_code = @code`);
        for (const roleKey of toSave) {
          await new sql.Request(tx)
            .input('code', sql.NVarChar(64), userCode)
            .input('role', sql.NVarChar(32), roleKey)
            .query(
              `INSERT INTO dbo.user_roles (user_code, role_key) VALUES (@code, @role)`
            );
        }
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }

      const resolved = await resolveUserRoles(pool, userCode);
      return { userCode, roles: resolved, assignedRoles: toSave };
    }
  );

  fastify.get(
    '/admin/users/search',
    { preHandler: [fastify.requireAdmin] },
    async (request) => {
      const q = String(request.query?.q || '').trim();
      const pool = await getPool();
      const items = await searchOusrUsers(pool, q, 50);
      return { items };
    }
  );
}

async function fetchOusrRowExists(pool, userCode) {
  const rs = await pool
    .request()
    .input('code', sql.NVarChar(255), userCode)
    .query(`SELECT TOP (1) [USER_CODE] AS user_code FROM [OUSR] WHERE [USER_CODE] = @code`);
  return rs.recordset?.[0];
}

module.exports = rolesAdminRoutes;
