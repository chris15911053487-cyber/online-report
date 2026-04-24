const { getPool, sql } = require('../db');
const { userCodeToStableBigInt } = require('../ousr-auth');
const {
  detectTemplateKind,
  normalizeTemplate,
  parseFilterSchemaJson,
  parseColumnNameMappingJson,
  applyColumnNameMapping,
  executeReportQuery,
} = require('../report-query');

const PRO_SIGN_ROUTE = 'pro-sign';
const MAX_BATCH_LINES = 100;

const DEFAULT_PRO_SIGN_SQL = `SELECT
  po.id AS orderId,
  po.order_no AS orderNo,
  po.product_name AS productName,
  po.planned_qty AS plannedQty,
  po.reported_qty AS reportedQty,
  po.status AS orderStatus,
  oo.id AS operationId,
  oo.seq_no AS seqNo,
  oo.operation_name AS operationName
FROM dbo.production_orders po
INNER JOIN dbo.order_operations oo ON oo.order_id = po.id
WHERE (@orderNo IS NULL OR LTRIM(RTRIM(ISNULL(@orderNo, N''))) = N'' OR po.order_no LIKE N'%' + @orderNo + N'%')
ORDER BY po.id DESC, oo.seq_no`;

const DEFAULT_FILTER_SCHEMA = [
  { name: 'orderNo', label: '订单号', type: 'string', required: false, maxLength: 64 },
];

function parseRolesJson(s) {
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return a.map((x) => String(x));
  } catch {
    return [];
  }
}

function toBigIntId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.trunc(n));
}

function displayWorkingSeconds(row) {
  const base = Number(row.total_working_seconds) || 0;
  const st = String(row.status || '');
  if (st === 'in_progress' && row.last_active_at) {
    const t = new Date(row.last_active_at).getTime();
    if (!Number.isNaN(t)) {
      return base + Math.max(0, Math.floor((Date.now() - t) / 1000));
    }
  }
  return base;
}

async function loadMenuRow(pool, routeKey) {
  const rs = await pool
    .request()
    .input('rk', sql.NVarChar(64), routeKey)
    .query(`SELECT id, label, route_key, enabled, roles_json, menu_kind, query_template, filter_schema_json,
                   COALESCE(column_name_mapping_json, N'{}') AS column_name_mapping_json
            FROM dbo.nav_menu_items WHERE route_key = @rk`);
  return rs.recordset && rs.recordset[0];
}

async function proSignRoutes(fastify) {
  fastify.post(
    '/pro-sign/run-list',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const routeKey = String(body.routeKey || '')
        .trim()
        .toLowerCase();
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const page = body.page;
      const pageSize = body.pageSize;

      if (routeKey !== PRO_SIGN_ROUTE) {
        return reply.code(400).send({ error: 'routeKey 须为 pro-sign', code: 'PRO_SIGN_BAD_REQUEST' });
      }

      const userRole = String(request.user.role || 'operator');
      const pool = await getPool();

      let row;
      try {
        row = await loadMenuRow(pool, routeKey);
      } catch (err) {
        request.log.error({ err }, 'pro-sign/run-list load menu');
        return reply.code(503).send({
          error: '无法读取菜单配置',
          code: 'NAV_CONFIG_ERROR',
        });
      }

      if (!row || !row.enabled) {
        return reply.code(404).send({ error: '菜单不存在或未启用', code: 'REPORT_MENU_NOT_FOUND' });
      }

      const roles = parseRolesJson(row.roles_json);
      if (!roles.includes(userRole)) {
        return reply.code(403).send({ error: '无权访问', code: 'PRO_SIGN_FORBIDDEN' });
      }

      const menuKind = String(row.menu_kind || 'builtin').toLowerCase();
      let template;
      let templateKind;
      let schemaFields;

      if (menuKind === 'report') {
        template = normalizeTemplate(row.query_template || '');
        if (!template) {
          return reply.code(503).send({ error: '报表未配置 SQL 模板', code: 'REPORT_TEMPLATE_EMPTY' });
        }
        const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
        if (!fs.ok) {
          return reply.code(503).send({ error: fs.error, code: 'REPORT_SCHEMA_INVALID' });
        }
        schemaFields = fs.fields;
        templateKind = detectTemplateKind(template);
        if (!templateKind) {
          return reply.code(503).send({ error: 'SQL 模板无效', code: 'REPORT_TEMPLATE_INVALID' });
        }
      } else {
        template = DEFAULT_PRO_SIGN_SQL;
        templateKind = 'select';
        schemaFields = DEFAULT_FILTER_SCHEMA;
      }

      const mapParse = parseColumnNameMappingJson(
        row.column_name_mapping_json != null && String(row.column_name_mapping_json).trim() !== ''
          ? row.column_name_mapping_json
          : '{}'
      );
      const colMap = mapParse.ok ? mapParse.mapping : {};

      try {
        const rawResult = await executeReportQuery(pool, {
          templateKind,
          sqlTemplate: template,
          schemaFields,
          params,
          page,
          pageSize,
        });
        const result = applyColumnNameMapping(rawResult, colMap);
        return {
          routeKey,
          label: row.label,
          columns: result.columns,
          rows: result.rows,
          truncated: result.truncated || false,
          page: result.page,
          pageSize: result.pageSize,
          totalRowCount: result.totalRowCount,
          clientSidePaging: result.clientSidePaging || false,
        };
      } catch (err) {
        const code = err.code || 'REPORT_EXEC_ERROR';
        if (code === 'REPORT_BAD_PAGING') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'REPORT_PARAM_REQUIRED' || code === 'REPORT_PARAM_INVALID') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'REPORT_QUERY_TIMEOUT') {
          return reply.code(504).send({ error: err.message, code });
        }
        request.log.error({ err }, 'pro-sign/run-list execute');
        return reply.code(500).send({
          error: '查询执行失败',
          code: 'REPORT_EXEC_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.post(
    '/pro-sign/batches',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录' });
      }
      const userIdBig = userCodeToStableBigInt(userCode);
      const { lines } = request.body || {};
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({ error: '请至少选择一行明细', code: 'PRO_SIGN_LINES_EMPTY' });
      }
      if (lines.length > MAX_BATCH_LINES) {
        return reply.code(400).send({ error: `明细行不能超过 ${MAX_BATCH_LINES} 条`, code: 'PRO_SIGN_TOO_MANY' });
      }

      const pool = await getPool();
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        const insBatch = new sql.Request(transaction)
          .input('userId', sql.BigInt, userIdBig)
          .input('userCode', sql.NVarChar(64), userCode);

        const batchRs = await insBatch.query(
          `INSERT INTO dbo.X_report_batch (user_id, reporter_user_code, status)
           OUTPUT INSERTED.id AS id
           VALUES (@userId, @userCode, N'pending')`
        );
        const batchId = batchRs.recordset[0].id;
        if (batchId == null) {
          await transaction.rollback();
          return reply.code(500).send({ error: '创建批次失败' });
        }

        let sort = 0;
        for (const line of lines) {
          const orderId = toBigIntId(line.orderId);
          const operationId = toBigIntId(line.operationId);
          if (orderId == null || operationId == null) {
            await transaction.rollback();
            return reply.code(400).send({ error: '每行须包含有效的 orderId 与 operationId', code: 'PRO_SIGN_BAD_LINE' });
          }

          const chk = await new sql.Request(transaction)
            .input('oid', sql.BigInt, orderId)
            .input('opid', sql.BigInt, operationId)
            .query(
              `SELECT oo.id FROM dbo.order_operations oo
               WHERE oo.id = @opid AND oo.order_id = @oid`
            );
          if (!chk.recordset[0]) {
            await transaction.rollback();
            return reply.code(400).send({ error: '工序与订单不匹配', code: 'PRO_SIGN_OP_MISMATCH' });
          }

          sort += 1;
          await new sql.Request(transaction)
            .input('bid', sql.BigInt, BigInt(batchId))
            .input('oid', sql.BigInt, orderId)
            .input('opid', sql.BigInt, operationId)
            .input('sort', sql.Int, sort)
            .query(
              `INSERT INTO dbo.X_report_batch_line (batch_id, order_id, operation_id, sort_order)
               VALUES (@bid, @oid, @opid, @sort)`
            );
        }

        await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .input('uid', sql.BigInt, userIdBig)
          .query(
            `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id)
             VALUES (@bid, N'create', @uid)`
          );

        await transaction.commit();
        return { batchId: Number(batchId), ok: true };
      } catch (e) {
        try {
          await transaction.rollback();
        } catch (_) {}
        request.log.error(e);
        return reply.code(500).send({ error: '创建批次失败', detail: e.message });
      }
    }
  );

  fastify.get(
    '/pro-sign/batches/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: '无效的批次 ID' });
      }
      const userCode = String(request.user.username || '').trim();
      const userIdBig = userCodeToStableBigInt(userCode);

      const pool = await getPool();
      const batchRs = await pool
        .request()
        .input('id', sql.BigInt, BigInt(id))
        .query(
          `SELECT id, user_id, reporter_user_code, status, received_at, work_started_at, last_active_at,
                  completed_at, pause_reason, total_working_seconds, created_at, updated_at
           FROM dbo.X_report_batch WHERE id = @id`
        );
      const batch = batchRs.recordset[0];
      if (!batch) {
        return reply.code(404).send({ error: '批次不存在' });
      }
      if (String(batch.user_id) !== String(userIdBig)) {
        return reply.code(403).send({ error: '无权查看该批次' });
      }

      const linesRs = await pool
        .request()
        .input('bid', sql.BigInt, BigInt(id))
        .query(
          `SELECT l.id AS lineId, l.order_id AS orderId, l.operation_id AS operationId, l.sort_order AS sortOrder,
                  po.order_no AS orderNo, po.product_name AS productName,
                  oo.seq_no AS seqNo, oo.operation_name AS operationName
           FROM dbo.X_report_batch_line l
           INNER JOIN dbo.production_orders po ON po.id = l.order_id
           INNER JOIN dbo.order_operations oo ON oo.id = l.operation_id
           WHERE l.batch_id = @bid
           ORDER BY l.sort_order, l.id`
        );

      return {
        batch: {
          id: Number(batch.id),
          status: batch.status,
          reporterUserCode: batch.reporter_user_code,
          receivedAt: batch.received_at,
          workStartedAt: batch.work_started_at,
          lastActiveAt: batch.last_active_at,
          completedAt: batch.completed_at,
          pauseReason: batch.pause_reason,
          totalWorkingSeconds: Number(batch.total_working_seconds) || 0,
          displayWorkingSeconds: displayWorkingSeconds(batch),
          createdAt: batch.created_at,
        },
        lines: linesRs.recordset || [],
      };
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/accept',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      return handleBatchAction(request, reply, 'accept');
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/pause',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const reason = String((request.body || {}).reason || '').trim().slice(0, 512);
      if (!reason) {
        return reply.code(400).send({ error: '请填写暂停原因' });
      }
      return handleBatchAction(request, reply, 'pause', { reason });
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/resume',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      return handleBatchAction(request, reply, 'resume');
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/submit',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录' });
      }
      const userIdBig = userCodeToStableBigInt(userCode);
      const batchId = Number(request.params.id);
      if (!Number.isFinite(batchId)) {
        return reply.code(400).send({ error: '无效的批次 ID' });
      }
      const { lines } = request.body || {};
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({ error: '请填写报工明细' });
      }

      const pool = await getPool();
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        const lockReq = new sql.Request(transaction);
        lockReq.input('id', sql.BigInt, BigInt(batchId));
        const batchRs = await lockReq.query(
          `SELECT id, user_id, status, last_active_at, total_working_seconds
           FROM dbo.X_report_batch WITH (UPDLOCK, ROWLOCK) WHERE id = @id`
        );
        const batch = batchRs.recordset[0];
        if (!batch) {
          await transaction.rollback();
          return reply.code(404).send({ error: '批次不存在' });
        }
        if (String(batch.user_id) !== String(userIdBig)) {
          await transaction.rollback();
          return reply.code(403).send({ error: '无权操作' });
        }
        const st = String(batch.status || '');
        if (st === 'completed') {
          await transaction.rollback();
          return reply.code(400).send({ error: '该批次已完工' });
        }
        if (st === 'pending') {
          await transaction.rollback();
          return reply.code(400).send({ error: '请先接单开工' });
        }

        let totalSecs = Number(batch.total_working_seconds) || 0;
        if (st === 'in_progress' && batch.last_active_at) {
          const t = new Date(batch.last_active_at).getTime();
          if (!Number.isNaN(t)) {
            totalSecs += Math.max(0, Math.floor((Date.now() - t) / 1000));
          }
        }

        const lineIdsRs = await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .query(`SELECT id, order_id, operation_id FROM dbo.X_report_batch_line WHERE batch_id = @bid`);
        const validLines = new Map();
        for (const r of lineIdsRs.recordset || []) {
          validLines.set(Number(r.id), {
            orderId: Number(r.order_id),
            operationId: r.operation_id != null ? Number(r.operation_id) : null,
          });
        }

        for (const item of lines) {
          const lineId = Number(item.lineId);
          if (!validLines.has(lineId)) {
            await transaction.rollback();
            return reply.code(400).send({ error: '无效的行 ID: ' + lineId });
          }
          const good = Number(item.goodQty);
          const scrap = Number(item.scrapQty ?? 0);
          if (!Number.isFinite(good) || good < 0) {
            await transaction.rollback();
            return reply.code(400).send({ error: '良品数量无效' });
          }
          if (!Number.isFinite(scrap) || scrap < 0) {
            await transaction.rollback();
            return reply.code(400).send({ error: '不良数量无效' });
          }
        }

        for (const item of lines) {
          const lineId = Number(item.lineId);
          const meta = validLines.get(lineId);
          const good = Number(item.goodQty);
          const scrap = Number(item.scrapQty ?? 0);
          const remark = String(item.remark || '').slice(0, 512);

          const orderLock = await new sql.Request(transaction)
            .input('orderId', sql.BigInt, BigInt(meta.orderId))
            .query(
              `SELECT id, status, planned_qty, reported_qty
               FROM dbo.production_orders WITH (UPDLOCK, ROWLOCK) WHERE id = @orderId`
            );
          const ord = orderLock.recordset[0];
          if (!ord) {
            await transaction.rollback();
            return reply.code(404).send({ error: '订单不存在' });
          }
          if (ord.status === 'cancelled' || ord.status === 'completed') {
            await transaction.rollback();
            return reply.code(400).send({ error: '订单 ' + meta.orderId + ' 不可再报工' });
          }

          const ins = new sql.Request(transaction)
            .input('orderId', sql.BigInt, BigInt(meta.orderId))
            .input('userId', sql.BigInt, userIdBig)
            .input('userCode', sql.NVarChar(64), userCode)
            .input('goodQty', sql.Decimal(18, 4), good)
            .input('scrapQty', sql.Decimal(18, 4), scrap)
            .input('remark', sql.NVarChar(512), remark)
            .input('lineId', sql.BigInt, BigInt(lineId));

          if (meta.operationId != null) {
            ins.input('operationId', sql.BigInt, BigInt(meta.operationId));
            await ins.query(
              `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark, batch_line_id)
               VALUES (@orderId, @operationId, @userId, @userCode, @goodQty, @scrapQty, @remark, @lineId)`
            );
          } else {
            await ins.query(
              `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark, batch_line_id)
               VALUES (@orderId, NULL, @userId, @userCode, @goodQty, @scrapQty, @remark, @lineId)`
            );
          }

          const delta = good + scrap;
          await new sql.Request(transaction)
            .input('delta', sql.Decimal(18, 4), delta)
            .input('orderId', sql.BigInt, BigInt(meta.orderId))
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
        }

        await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .input('secs', sql.Int, totalSecs)
          .input('uid', sql.BigInt, userIdBig)
          .query(
            `UPDATE dbo.X_report_batch
             SET status = N'completed',
                 completed_at = SYSUTCDATETIME(),
                 last_active_at = NULL,
                 total_working_seconds = @secs,
                 updated_at = SYSUTCDATETIME()
             WHERE id = @bid`
          );

        await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .input('uid', sql.BigInt, userIdBig)
          .input('secs', sql.Int, totalSecs)
          .query(
            `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id, working_seconds_delta)
             VALUES (@bid, N'submit', @uid, @secs)`
          );

        await transaction.commit();
        return { ok: true, totalWorkingSeconds: totalSecs };
      } catch (e) {
        try {
          await transaction.rollback();
        } catch (_) {}
        request.log.error(e);
        return reply.code(500).send({ error: '提交失败', detail: e.message });
      }
    }
  );
}

async function handleBatchAction(request, reply, action, extra) {
  const userCode = String(request.user.username || '').trim();
  if (!userCode) {
    return reply.code(401).send({ error: '无效登录' });
  }
  const userIdBig = userCodeToStableBigInt(userCode);
  const batchId = Number(request.params.id);
  if (!Number.isFinite(batchId)) {
    return reply.code(400).send({ error: '无效的批次 ID' });
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const batchRs = await new sql.Request(transaction)
      .input('id', sql.BigInt, BigInt(batchId))
      .query(
        `SELECT id, user_id, status, last_active_at, total_working_seconds, work_started_at
         FROM dbo.X_report_batch WITH (UPDLOCK, ROWLOCK) WHERE id = @id`
      );
    const batch = batchRs.recordset[0];
    if (!batch) {
      await transaction.rollback();
      return reply.code(404).send({ error: '批次不存在' });
    }
    if (String(batch.user_id) !== String(userIdBig)) {
      await transaction.rollback();
      return reply.code(403).send({ error: '无权操作' });
    }

    const st = String(batch.status || '');
    const now = new Date();

    if (action === 'accept') {
      if (st !== 'pending') {
        await transaction.rollback();
        return reply.code(400).send({ error: '当前状态不可接单' });
      }
      await new sql.Request(transaction)
        .input('id', sql.BigInt, BigInt(batchId))
        .query(
          `UPDATE dbo.X_report_batch
           SET status = N'in_progress',
               received_at = SYSUTCDATETIME(),
               work_started_at = SYSUTCDATETIME(),
               last_active_at = SYSUTCDATETIME(),
               updated_at = SYSUTCDATETIME()
           WHERE id = @id`
        );
      await new sql.Request(transaction)
        .input('bid', sql.BigInt, BigInt(batchId))
        .input('uid', sql.BigInt, userIdBig)
        .query(
          `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id)
           VALUES (@bid, N'accept', @uid)`
        );
    } else if (action === 'pause') {
      if (st !== 'in_progress') {
        await transaction.rollback();
        return reply.code(400).send({ error: '当前状态不可暂停' });
      }
      let addSecs = 0;
      if (batch.last_active_at) {
        const t = new Date(batch.last_active_at).getTime();
        if (!Number.isNaN(t)) {
          addSecs = Math.max(0, Math.floor((now.getTime() - t) / 1000));
        }
      }
      const prev = Number(batch.total_working_seconds) || 0;
      await new sql.Request(transaction)
        .input('id', sql.BigInt, BigInt(batchId))
        .input('secs', sql.Int, prev + addSecs)
        .input('reason', sql.NVarChar(512), extra && extra.reason ? String(extra.reason).slice(0, 512) : '')
        .query(
          `UPDATE dbo.X_report_batch
           SET status = N'paused',
               total_working_seconds = @secs,
               last_active_at = NULL,
               pause_reason = @reason,
               updated_at = SYSUTCDATETIME()
           WHERE id = @id`
        );
      await new sql.Request(transaction)
        .input('bid', sql.BigInt, BigInt(batchId))
        .input('uid', sql.BigInt, userIdBig)
        .input('delta', sql.Int, addSecs)
        .input('reason', sql.NVarChar(512), extra && extra.reason ? String(extra.reason).slice(0, 512) : '')
        .query(
          `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id, working_seconds_delta, reason)
           VALUES (@bid, N'pause', @uid, @delta, @reason)`
        );
    } else if (action === 'resume') {
      if (st !== 'paused') {
        await transaction.rollback();
        return reply.code(400).send({ error: '当前状态不可继续' });
      }
      await new sql.Request(transaction)
        .input('id', sql.BigInt, BigInt(batchId))
        .query(
          `UPDATE dbo.X_report_batch
           SET status = N'in_progress',
               last_active_at = SYSUTCDATETIME(),
               pause_reason = NULL,
               updated_at = SYSUTCDATETIME()
           WHERE id = @id`
        );
      await new sql.Request(transaction)
        .input('bid', sql.BigInt, BigInt(batchId))
        .input('uid', sql.BigInt, userIdBig)
        .query(
          `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id)
           VALUES (@bid, N'resume', @uid)`
        );
    }

    await transaction.commit();

    const pool2 = await getPool();
    const refreshed = await pool2
      .request()
      .input('id', sql.BigInt, BigInt(batchId))
      .query(
        `SELECT id, status, received_at, work_started_at, last_active_at, completed_at,
                pause_reason, total_working_seconds
         FROM dbo.X_report_batch WHERE id = @id`
      );
    const b = refreshed.recordset[0];
    return {
      ok: true,
      batch: {
        status: b.status,
        displayWorkingSeconds: displayWorkingSeconds(b),
        totalWorkingSeconds: Number(b.total_working_seconds) || 0,
        pauseReason: b.pause_reason,
        workStartedAt: b.work_started_at,
        lastActiveAt: b.last_active_at,
      },
    };
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_) {}
    request.log.error(e);
    return reply.code(500).send({ error: '操作失败', detail: e.message });
  }
}

module.exports = proSignRoutes;
