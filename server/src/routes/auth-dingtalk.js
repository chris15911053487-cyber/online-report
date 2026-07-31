/**
 * 钉钉 H5 微应用免登路由
 *
 * 流程：
 *  1. 前端在钉钉容器中获取 authCode（dd.runtime.permission.requestAuthCode）
 *  2. POST /auth/dingtalk/login { authCode }
 *  3. 后端用 appKey+appSecret 换 accessToken
 *  4. 后端用 accessToken+authCode 调钉钉 API 获取 userid
 *  5. 通过 bot_user_bindings 表匹配 OUSR 用户
 *  6. 签发 JWT 返回前端
 */
const { getPool, sql } = require('../db');
const { userCodeToStableBigInt } = require('../ousr-auth');
const { resolveUserRoles, primaryRoleFromRoles } = require('../roles');

// ---------- 钉钉 access_token 缓存 ----------

let _tokenCache = { token: '', expiresAt: 0 };

function getDingAppKey() {
  return process.env.DINGTALK_APP_KEY || '';
}
function getDingAppSecret() {
  return process.env.DINGTALK_APP_SECRET || '';
}

async function getDingAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: getDingAppKey(), appSecret: getDingAppSecret() }),
  });
  const data = await res.json();
  if (!data.accessToken) {
    throw new Error('获取钉钉 accessToken 失败: ' + JSON.stringify(data));
  }
  _tokenCache = {
    token: data.accessToken,
    expiresAt: Date.now() + (data.expireIn || 7200) * 1000 - 60000,
  };
  return _tokenCache.token;
}

// ---------- 通过免登码获取用户 userid ----------

async function getUserInfoByCode(accessToken, code) {
  const res = await fetch(
    `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${accessToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    },
  );
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`钉钉获取用户信息失败: ${data.errmsg || JSON.stringify(data)}`);
  }
  return data.result; // { userid, name, ... }
}

// ---------- Fastify 路由 ----------

async function authDingtalkRoutes(fastify) {
  // 前端获取 corpId 配置（无需鉴权）
  fastify.get('/auth/dingtalk/config', async (_request, reply) => {
    const corpId = process.env.DINGTALK_CORP_ID || '';
    if (!corpId) {
      return reply.code(503).send({ error: '钉钉 SSO 未配置（缺少 DINGTALK_CORP_ID）' });
    }
    return { corpId };
  });

  // 钉钉免登
  fastify.post('/auth/dingtalk/login', async (request, reply) => {
    const { authCode } = request.body || {};
    if (!authCode) {
      return reply.code(400).send({ error: '缺少 authCode 参数' });
    }

    const appKey = getDingAppKey();
    const appSecret = getDingAppSecret();
    const corpId = process.env.DINGTALK_CORP_ID || '';

    if (!appKey || !appSecret || !corpId) {
      return reply.code(503).send({ error: '钉钉 SSO 服务未配置' });
    }

    try {
      // 1. 获取 accessToken
      const accessToken = await getDingAccessToken();

      // 2. 用 authCode 换取用户信息
      const userInfo = await getUserInfoByCode(accessToken, authCode);
      const dingUserId = userInfo.userid;
      if (!dingUserId) {
        return reply.code(401).send({ error: '无法获取钉钉用户ID' });
      }

      request.log.info({ dingUserId, name: userInfo.name }, 'dingtalk sso: got user');

      // 3. 通过 OUSR.U_DDUserId 查找系统用户
      const pool = await getPool();
      const bindResult = await pool
        .request()
        .input('dduid', sql.NVarChar(128), dingUserId)
        .query(
          `SELECT TOP (1) [USER_CODE] AS user_code, [U_NAME] AS u_name
           FROM [OUSR] WHERE [U_DDUserId] = @dduid`,
        );
      const ousrRow = bindResult.recordset?.[0];

      if (!ousrRow) {
        return reply.code(403).send({
          error: '该钉钉账号未关联系统用户，请联系管理员在OUSR表中配置U_DDUserId字段',
          dingUserId,
          dingUserName: userInfo.name || '',
        });
      }

      // 4. 签发 JWT
      const displayName =
        ousrRow.u_name != null && String(ousrRow.u_name).trim() !== ''
          ? String(ousrRow.u_name).trim()
          : ousrRow.user_code;

      const userId = Number(userCodeToStableBigInt(ousrRow.user_code));
      const roles = await resolveUserRoles(pool, ousrRow.user_code);
      const role = primaryRoleFromRoles(roles);

      const token = await reply.jwtSign({
        sub: userId,
        username: ousrRow.user_code,
        displayName,
        role,
        roles,
      });

      return {
        token,
        user: {
          id: userId,
          username: ousrRow.user_code,
          displayName,
          role,
          roles,
        },
      };
    } catch (err) {
      request.log.error(err, 'dingtalk sso error');
      return reply.code(500).send({ error: err.message || '钉钉免登失败' });
    }
  });
}

module.exports = authDingtalkRoutes;
