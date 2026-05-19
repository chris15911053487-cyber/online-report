const { getPool } = require('../db');
const { queryBatchStock } = require('../returnpro-batch-stock');

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}

async function returnproRoutes(fastify) {
  fastify.post(
    '/returnpro/batch-stock',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const itemCode = String(body.itemCode ?? body.ItemCode ?? '').trim();
      const batchNum = String(body.batchNum ?? body.BatchNum ?? body.batch ?? '').trim();
      const whsCode = String(body.whsCode ?? body.WhsCode ?? body.warehouse ?? '').trim();
      const quantityRaw = body.quantity ?? body.Quantity;
      const quantity =
        quantityRaw === undefined || quantityRaw === null || quantityRaw === ''
          ? null
          : Number(quantityRaw);

      if (!itemCode || !batchNum) {
        return reply.code(400).send({
          error: '请提供 itemCode、batchNum',
          code: 'RETURNPRO_BAD_REQUEST',
        });
      }
      if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) {
        return reply.code(400).send({
          error: 'quantity 须为非负数字',
          code: 'RETURNPRO_BAD_REQUEST',
        });
      }

      try {
        const pool = await getPool();
        const result = await queryBatchStock(pool, {
          itemCode,
          batchNum,
          whsCode: whsCode || undefined,
          quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
        });
        return { ok: true, ...result };
      } catch (err) {
        const num = sqlErrorNumber(err);
        if (num === 208 || num === 207) {
          request.log.error({ err }, 'returnpro/batch-stock missing table');
          return reply.code(503).send({
            error: '批次库存查询失败：数据库缺少 OIBT/OBTN 表或当前账号无权限',
            code: 'RETURNPRO_BATCH_TABLE_MISSING',
            detail: err.message || String(err),
          });
        }
        if (err.code === 'RETURNPRO_BAD_REQUEST') {
          return reply.code(400).send({ error: err.message, code: err.code });
        }
        request.log.error({ err }, 'returnpro/batch-stock');
        return reply.code(500).send({
          error: '批次库存查询失败',
          code: 'RETURNPRO_BATCH_STOCK_ERROR',
          detail: err.message || String(err),
        });
      }
    },
  );
}

module.exports = returnproRoutes;
