const { getPool } = require('../db');
const { queryBatchStock } = require('../returnpro-batch-stock');
const { submitReturnProPick } = require('../returnpro-b1-service');
const { insertReturnProPickLog } = require('../returnpro-pick-log');

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
      const body = request.body || {};
      const docEntry = body.docEntry ?? body.DocEntry;
      const lines = body.lines ?? body.Lines;
      const requestPayload = { docEntry, lines };

      const logEntry = {
        userCode: userCode || null,
        docEntry: docEntry != null ? String(docEntry) : null,
        requestJson: requestPayload,
        b1RequestJson: null,
        responseJson: null,
        success: false,
        errorCode: null,
        errorMessage: null,
        resultDocEntry: null,
      };

      const persistLog = async () => {
        await insertReturnProPickLog(logEntry, request.log);
      };

      if (!userCode) {
        logEntry.errorCode = 'UNAUTHORIZED';
        logEntry.errorMessage = '无效登录';
        logEntry.responseJson = { api: { error: logEntry.errorMessage, code: logEntry.errorCode } };
        await persistLog();
        return reply.code(401).send({ error: '无效登录', code: 'UNAUTHORIZED' });
      }

      if (!Array.isArray(lines) || lines.length === 0) {
        logEntry.errorCode = 'RETURNPRO_LINES_EMPTY';
        logEntry.errorMessage = '请至少提交一行领料明细';
        logEntry.responseJson = { api: { error: logEntry.errorMessage, code: logEntry.errorCode } };
        await persistLog();
        return reply.code(400).send({
          error: logEntry.errorMessage,
          code: logEntry.errorCode,
        });
      }

      try {
        const result = await submitReturnProPick(
          { docEntry, lines, userCode },
          request.log,
        );
        logEntry.b1RequestJson = result.b1Request ?? null;
        logEntry.resultDocEntry = result.docEntry != null ? String(result.docEntry) : null;
        logEntry.success = true;
        const apiResponse = {
          ok: true,
          docEntry: result.docEntry,
          message: result.docEntry
            ? `领料成功，单据号 ${result.docEntry}`
            : '领料成功',
        };
        logEntry.responseJson = {
          api: apiResponse,
          b1: result.b1Response ?? null,
        };
        await persistLog();
        return apiResponse;
      } catch (err) {
        const code = err.code || 'RETURNPRO_PICK_ERROR';
        logEntry.b1RequestJson = err.b1Request ?? null;
        logEntry.errorCode = code;
        logEntry.errorMessage = err.message || '领料提交失败';
        logEntry.responseJson = {
          api: { error: logEntry.errorMessage, code },
          b1: err.b1Response ?? null,
        };
        await persistLog();

        if (code === 'RETURNPRO_BAD_REQUEST') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'RETURNPRO_B1_NOT_CONFIGURED') {
          return reply.code(503).send({
            error: err.message,
            code,
            hint: '请在 server/.env 配置 RETURNPRO_B1_BASE_URL（可选 RETURNPRO_B1_ADD_DOCUMENTS_PATH），见 .env.example',
          });
        }
        if (code === 'RETURNPRO_B1_NOT_FOUND') {
          request.log.warn({ err, b1Url: err.b1Url }, 'returnpro/pick B1 404');
          return reply.code(502).send({
            error:
              err.message ||
              'B1 接口地址不存在(404)。请检查 RETURNPRO_B1_BASE_URL 是否为 http://主机:端口/B1Service.svc/Web',
            code,
            b1Url: err.b1Url,
          });
        }
        if (
          code === 'RETURNPRO_B1_NETWORK' ||
          code === 'RETURNPRO_B1_TIMEOUT' ||
          code === 'RETURNPRO_B1_HTTP_ERROR' ||
          code === 'RETURNPRO_B1_BAD_RESPONSE'
        ) {
          request.log.error({ err }, 'returnpro/pick B1 transport');
          return reply.code(502).send({
            error: err.message,
            code,
          });
        }
        if (code === 'RETURNPRO_B1_ADD_DOCUMENTS_FAILED') {
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
