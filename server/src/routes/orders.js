const { getPool, sql } = require('../db');
const { userCodeToStableBigInt } = require('../ousr-auth');

async function ordersRoutes(fastify) {
  fastify.get(
    '/orders',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const status = request.query.status;
      const pool = await getPool();

      let q = `
        SELECT TOP (500) id, order_no AS orderNo, product_name AS productName,
               planned_qty AS plannedQty, reported_qty AS reportedQty,
               status, remark, created_at AS createdAt
        FROM dbo.production_orders
        WHERE 1 = 1
      `;
      const req = pool.request();
      if (status) {
        req.input('status', sql.NVarChar(32), status);
        q += ' AND status = @status';
      }
      q += ' ORDER BY id DESC';

      const result = await req.query(q);
      return { items: result.recordset };
    }
  );

  fastify.get(
    '/orders/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: '无效的订单 ID' });
      }
      const pool = await getPool();

      const orders = await pool
        .request()
        .input('id', sql.BigInt, BigInt(id))
        .query(
          `SELECT id, order_no AS orderNo, product_name AS productName,
                  planned_qty AS plannedQty, reported_qty AS reportedQty,
                  status, remark, created_at AS createdAt
           FROM dbo.production_orders WHERE id = @id`
        );

      const order = orders.recordset[0];
      if (!order) {
        return reply.code(404).send({ error: '订单不存在' });
      }

      const ops = await pool
        .request()
        .input('id', sql.BigInt, BigInt(id))
        .query(
          `SELECT id, seq_no AS seqNo, operation_name AS operationName
           FROM dbo.order_operations WHERE order_id = @id ORDER BY seq_no`
        );

      const reports = await pool
        .request()
        .input('id', sql.BigInt, BigInt(id))
        .query(
          `SELECT TOP (50) wr.id, wr.good_qty AS goodQty, wr.scrap_qty AS scrapQty,
                  wr.remark, wr.reported_at AS reportedAt,
                  ISNULL(wr.reporter_user_code, N'') AS reporterName
           FROM dbo.work_reports wr
           WHERE wr.order_id = @id
           ORDER BY wr.reported_at DESC`
        );

      return {
        order,
        operations: ops.recordset,
        recentReports: reports.recordset,
      };
    }
  );

  fastify.post(
    '/orders/:id/report',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const orderId = Number(request.params.id);
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录' });
      }
      const userIdBig = userCodeToStableBigInt(userCode);
      const { operationId, goodQty, scrapQty, remark } = request.body || {};

      if (!Number.isFinite(orderId)) {
        return reply.code(400).send({ error: '无效的订单 ID' });
      }

      const good = Number(goodQty);
      const scrap = Number(scrapQty ?? 0);
      if (!Number.isFinite(good) || good < 0) {
        return reply.code(400).send({ error: '请填写有效的良品数量' });
      }
      if (!Number.isFinite(scrap) || scrap < 0) {
        return reply.code(400).send({ error: '请填写有效的不良数量' });
      }

      let opId = null;
      if (operationId != null && operationId !== '') {
        opId = Number(operationId);
        if (!Number.isFinite(opId)) {
          return reply.code(400).send({ error: '无效的工序' });
        }
      }

      const pool = await getPool();
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        const reqLock = new sql.Request(transaction);
        const orderResult = await reqLock
          .input('orderId', sql.BigInt, BigInt(orderId))
          .query(
            `SELECT id, status, planned_qty, reported_qty
             FROM dbo.production_orders WITH (UPDLOCK, ROWLOCK)
             WHERE id = @orderId`
          );

        const order = orderResult.recordset[0];
        if (!order) {
          await transaction.rollback();
          return reply.code(404).send({ error: '订单不存在' });
        }
        if (order.status === 'cancelled' || order.status === 'completed') {
          await transaction.rollback();
          return reply.code(400).send({ error: '该订单不可再报工' });
        }

        if (opId != null) {
          const chk = await new sql.Request(transaction)
            .input('opId', sql.BigInt, BigInt(opId))
            .input('orderId', sql.BigInt, BigInt(orderId))
            .query(
              `SELECT id FROM dbo.order_operations WHERE id = @opId AND order_id = @orderId`
            );
          if (!chk.recordset[0]) {
            await transaction.rollback();
            return reply.code(400).send({ error: '工序不属于该订单' });
          }
        }

        const rem = remark ? String(remark).slice(0, 512) : '';

        const ins = new sql.Request(transaction)
          .input('orderId', sql.BigInt, BigInt(orderId))
          .input('userId', sql.BigInt, userIdBig)
          .input('userCode', sql.NVarChar(64), userCode)
          .input('goodQty', sql.Decimal(18, 4), good)
          .input('scrapQty', sql.Decimal(18, 4), scrap)
          .input('remark', sql.NVarChar(512), rem);

        if (opId == null) {
          await ins.query(
            `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark)
             VALUES (@orderId, NULL, @userId, @userCode, @goodQty, @scrapQty, @remark)`
          );
        } else {
          ins.input('operationId', sql.BigInt, BigInt(opId));
          await ins.query(
            `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark)
             VALUES (@orderId, @operationId, @userId, @userCode, @goodQty, @scrapQty, @remark)`
          );
        }

        const delta = good + scrap;
        await new sql.Request(transaction)
          .input('delta', sql.Decimal(18, 4), delta)
          .input('orderId', sql.BigInt, BigInt(orderId))
          .query(
            `UPDATE dbo.production_orders
             SET reported_qty = reported_qty + @delta,
                 status = CASE
                   WHEN reported_qty + @delta >= planned_qty THEN N'completed'
                   ELSE N'in_progress'
                 END,
                 updated_at = SYSUTCDATETIME()
             WHERE id = @orderId`
          );

        await transaction.commit();
        return { ok: true };
      } catch (e) {
        try {
          await transaction.rollback();
        } catch (_) {}
        request.log.error(e);
        return reply.code(500).send({ error: '报工失败，请稍后重试' });
      }
    }
  );
}

module.exports = ordersRoutes;
