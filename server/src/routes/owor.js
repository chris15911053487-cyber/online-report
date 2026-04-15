const { getPool } = require('../db');

function sqlErrorNumber(err) {
  return (
    err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number
  );
}

/** 兼容 mssql 返回列名大小写不一致 */
function pickCol(row, ...candidates) {
  if (!row || typeof row !== 'object') return '';
  const keys = Object.keys(row);
  for (const name of candidates) {
    const found = keys.find((k) => k.toLowerCase() === name.toLowerCase());
    if (found != null) {
      const v = row[found];
      return v == null ? '' : String(v);
    }
  }
  return '';
}

function mapOitmRow(row) {
  return {
    itemCode: pickCol(row, 'ItemCode'),
    itemName: pickCol(row, 'ItemName'),
    frgnName: pickCol(row, 'FrgnName'),
  };
}

/**
 * 在根 fastify 实例上注册 GET /owor：查询 SAP OITM（路径沿用 /owor）
 */
function registerOworRoutes(fastify) {
  fastify.get('/owor', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const pool = await getPool();

      const dbRs = await pool.request().query('SELECT DB_NAME() AS currentDb');
      const currentDb =
        dbRs.recordset && dbRs.recordset[0]
          ? String(
              pickCol(dbRs.recordset[0], 'currentDb') ||
                Object.values(dbRs.recordset[0])[0] ||
                ''
            )
          : '';

      const result = await pool.request().query(`
        SELECT TOP 30 [ItemCode], [ItemName], [FrgnName]
        FROM [dbo].[OITM]
        ORDER BY [ItemCode]
      `);

      const raw =
        result.recordset ??
        (Array.isArray(result.recordsets) && result.recordsets[0]
          ? result.recordsets[0]
          : []) ??
        [];

      const rows = Array.isArray(raw) ? raw.map(mapOitmRow) : [];

      if (rows.length === 0) {
        request.log.warn(
          { currentDb, oitmRowCount: 0 },
          'OITM 查询结果为空：请核对 .env 中 DB_NAME 是否与 SSMS 所选库一致'
        );
      } else {
        request.log.info({ currentDb, rowCount: rows.length }, 'OITM 查询');
      }

      return {
        rows,
        meta: {
          database: currentDb,
          rowCount: rows.length,
        },
      };
    } catch (err) {
      if (sqlErrorNumber(err) === 208) {
        return reply.code(503).send({
          error: '数据库中不存在表 OITM（或当前账号无权限）',
          code: 'OITM_MISSING',
        });
      }
      request.log.error(err);
      return reply.code(500).send({
        error: err.message || '查询 OITM 失败',
      });
    }
  });
}

module.exports = registerOworRoutes;
