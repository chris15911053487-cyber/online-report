const { getPool } = require('../db');
const { queryBatchStock } = require('../returnpro-batch-stock');
const { submitReturnProPick } = require('../returnpro-b1-service');

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
            error: '批次库存查询失败：数据库缺少 OIBT 表或当前账号无权限',
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

  fastify.post(
    '/returnpro/pick',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录', code: 'UNAUTHORIZED' });
      }

      const body = request.body || {};
      const docEntry = body.docEntry ?? body.DocEntry;
      const lines = body.lines ?? body.Lines;
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({
          error: '请至少提交一行领料明细',
          code: 'RETURNPRO_LINES_EMPTY',
        });
      }

      try {
        const result = await submitReturnProPick(
          { docEntry, lines, userCode },
          request.log,
        );
        return {
          ok: true,
          docEntry: result.docEntry,
          message: result.docEntry
            ? `领料成功，单据号 ${result.docEntry}`
            : '领料成功',
        };
      } catch (err) {
        const code = err.code || 'RETURNPRO_PICK_ERROR';
        if (code === 'RETURNPRO_BAD_REQUEST') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'RETURNPRO_B1_NOT_CONFIGURED') {
          return reply.code(503).send({
            error: err.message,
            code,
            hint: '请在 server/.env 配置 RETURNPRO_B1_BASE_URL、B1_COMPANY_USER 等，见 .env.example',
          });
        }
        if (
          code === 'RETURNPRO_B1_NETWORK' ||
          code === 'RETURNPRO_B1_TIMEOUT' ||
          code === 'RETURNPRO_B1_HTTP_ERROR'
        ) {
          request.log.error({ err }, 'returnpro/pick B1 transport');
          return reply.code(502).send({
            error: err.message,
            code,
          });
        }
        if (code === 'RETURNPRO_B1_LOGIN_FAILED' || code === 'RETURNPRO_B1_ADD_OBJECT_FAILED') {
          request.log.warn({ err, b1Response: err.b1Response }, 'returnpro/pick B1 business');
          return reply.code(400).send({
            error: err.message,
            code,
          });
        }
        request.log.error({ err }, 'returnpro/pick');
        return reply.code(500).send({
          error: err.message || '领料提交失败',
          code,
        });
      }
    },
  );
}

module.exports = returnproRoutes;
