const { getPool, sql } = require('../db');
const { timingSafeEqualStr, userCodeToStableBigInt } = require('../ousr-auth');

/** 与 ADMIN_USER_CODES（逗号分隔的 OUSR 用户代码）匹配则为 admin */
function resolveRoleForUserCode(userCode) {
  const raw = process.env.ADMIN_USER_CODES || '';
  const codes = raw
    .split(/[,，]/)
    .map((s) => String(s).trim())
    .filter(Boolean);
  const u = String(userCode).trim();
  if (codes.includes(u)) return 'admin';
  return 'operator';
}

function isInvalidColumnError(err) {
  const n = err?.number ?? err?.originalError?.info?.number;
  if (n === 207) return true;
  return typeof err?.message === 'string' && err.message.includes('Invalid column name');
}

/** 返回给前端的 500 文案：连接类错误带库返回信息；其它错误可按 EXPOSE_SERVER_ERRORS 暴露 */
function loginErrorPayload(err) {
  const code = err?.code || err?.originalError?.code;
  const msg = (err && err.message) ? String(err.message).slice(0, 800) : '未知错误';
  const connCodes = new Set([
    'ELOGIN',
    'ETIMEOUT',
    'ESOCKET',
    'ECONNREFUSED',
    'EINSTLOOKUP',
  ]);
  if (code && connCodes.has(code)) {
    return { error: msg, code };
  }
  if (err?.name === 'ConnectionError') {
    return { error: msg, code: code || 'ConnectionError' };
  }
  if (/login|timeout|connect|socket|network/i.test(msg)) {
    return { error: msg, code: code || 'EDB' };
  }
  const expose =
    process.env.EXPOSE_SERVER_ERRORS === 'true' ||
    process.env.NODE_ENV !== 'production';
  if (expose) {
    return { error: msg, code };
  }
  return {
    error: '登录服务异常，请稍后重试或联系管理员',
    code,
  };
}

/** 查询 OUSR（SQL Server）；若无 U_NAME 列则降级查询 */
async function fetchOusrRow(pool, code) {
  try {
    const result = await pool
      .request()
      .input('code', sql.NVarChar(255), code)
      .query(
        `SELECT TOP (1) [USER_CODE] AS user_code, [PortNum] AS port_num, [U_NAME] AS u_name
         FROM [OUSR] WHERE [USER_CODE] = @code`
      );
    return result.recordset[0];
  } catch (e) {
    if (isInvalidColumnError(e)) {
      const result = await pool
        .request()
        .input('code', sql.NVarChar(255), code)
        .query(
          `SELECT TOP (1) [USER_CODE] AS user_code, [PortNum] AS port_num
           FROM [OUSR] WHERE [USER_CODE] = @code`
        );
      const row = result.recordset[0];
      if (row) row.u_name = undefined;
      return row;
    }
    throw e;
  }
}

async function authRoutes(fastify) {
  fastify.post('/auth/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ error: '请输入用户名和密码' });
    }

    const userCodeInput = String(username).trim();

    try {
      const pool = await getPool();
      const row = await fetchOusrRow(pool, userCodeInput);
      if (!row || !timingSafeEqualStr(password, row.port_num)) {
        return reply.code(401).send({ error: '用户名或密码错误' });
      }

      const displayName =
        row.u_name != null && String(row.u_name).trim() !== ''
          ? String(row.u_name).trim()
          : row.user_code;

      const uidBig = userCodeToStableBigInt(row.user_code);
      const userId = Number(uidBig);
      const role = resolveRoleForUserCode(row.user_code);

      const token = await reply.jwtSign({
        sub: userId,
        username: row.user_code,
        displayName,
        role,
      });

      return {
        token,
        user: {
          id: userId,
          username: row.user_code,
          displayName,
          role,
        },
      };
    } catch (err) {
      request.log.error(err);
      const payload = loginErrorPayload(err);
      return reply.code(500).send(payload);
    }
  });

  fastify.get(
    '/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const u = request.user;
      const sub = u.sub;
      const id =
        typeof sub === 'number' && Number.isFinite(sub)
          ? sub
          : Number(sub);
      if (!Number.isFinite(id)) {
        return reply.code(401).send({ error: '无效登录' });
      }
      const username = u.username != null ? String(u.username).trim() : '';
      if (!username) {
        return reply.code(401).send({ error: '无效登录' });
      }
      return {
        id,
        username,
        displayName: u.displayName != null ? String(u.displayName) : username,
        role: u.role != null ? String(u.role) : 'operator',
      };
    }
  );
}

module.exports = authRoutes;
