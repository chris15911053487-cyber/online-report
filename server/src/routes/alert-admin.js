/**
 * 警报推送管理 API（仅管理员）
 *
 * 接口列表：
 * - GET    /admin/alert-rules           规则列表
 * - POST   /admin/alert-rules           新增规则
 * - PATCH  /admin/alert-rules/:id       修改规则
 * - DELETE /admin/alert-rules/:id       删除规则
 * - POST   /admin/alert-rules/:id/test  手动触发一次
 * - GET    /admin/alert-webhooks        Webhook 列表
 * - POST   /admin/alert-webhooks        新增 Webhook
 * - PATCH  /admin/alert-webhooks/:id    修改 Webhook
 * - DELETE /admin/alert-webhooks/:id    删除 Webhook
 * - GET    /admin/alert-logs            推送日志查询
 */
const cron = require('node-cron');
const { getPool, sql } = require('../db');
const { executeRule, triggerEvent, loadRuleById } = require('../alert-engine');
const { loadAndScheduleAlerts } = require('../alert-scheduler');

async function alertAdminRoutes(fastify) {
  // ==================== 警报规则 CRUD ====================

  // 规则列表
  fastify.get('/admin/alert-rules', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const rs = await pool.request().query(
      `SELECT id, name, description, trigger_type, cron_expr, sql_template, key_column,
              event_name, target_users_json, target_roles_json, target_webhooks_json,
              card_title_template, card_body_template, card_btn_title, card_btn_url,
              cooldown_minutes, enabled, sort_order, created_by, created_at, updated_at
       FROM dbo.alert_rules ORDER BY sort_order, id DESC`
    );
    return { items: rs.recordset || [] };
  });

  // 新增规则
  fastify.post('/admin/alert-rules', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    if (!b.name) return reply.code(400).send({ error: '缺少规则名称' });
    if (!b.trigger_type || !['cron', 'event'].includes(b.trigger_type)) {
      return reply.code(400).send({ error: 'trigger_type 须为 cron 或 event' });
    }
    if (b.trigger_type === 'cron') {
      if (!b.cron_expr) return reply.code(400).send({ error: '定时规则须配置 cron_expr' });
      if (!cron.validate(b.cron_expr)) return reply.code(400).send({ error: 'cron 表达式无效' });
      if (!b.sql_template) return reply.code(400).send({ error: '定时规则须配置检查 SQL' });
    }
    if (b.trigger_type === 'event' && !b.event_name) {
      return reply.code(400).send({ error: '事件规则须配置 event_name' });
    }

    const pool = await getPool();
    const rs = await pool.request()
      .input('name', sql.NVarChar(128), b.name)
      .input('desc', sql.NVarChar(512), b.description || null)
      .input('tt', sql.VarChar(16), b.trigger_type)
      .input('cron', sql.VarChar(64), b.cron_expr || null)
      .input('sqlt', sql.NVarChar(sql.MAX), b.sql_template || null)
      .input('kc', sql.NVarChar(128), b.key_column || null)
      .input('ev', sql.VarChar(64), b.event_name || null)
      .input('tu', sql.NVarChar(512), b.target_users_json ? JSON.stringify(b.target_users_json) : null)
      .input('tr', sql.NVarChar(512), b.target_roles_json ? JSON.stringify(b.target_roles_json) : null)
      .input('tw', sql.NVarChar(512), b.target_webhooks_json ? JSON.stringify(b.target_webhooks_json) : null)
      .input('ct', sql.NVarChar(256), b.card_title_template || '⚠️ 警报通知')
      .input('cb', sql.NVarChar(sql.MAX), b.card_body_template || null)
      .input('cbt', sql.NVarChar(64), b.card_btn_title || null)
      .input('cbu', sql.NVarChar(512), b.card_btn_url || null)
      .input('cd', sql.Int, b.cooldown_minutes || 60)
      .input('en', sql.Bit, b.enabled !== false ? 1 : 0)
      .input('so', sql.Int, b.sort_order || 0)
      .input('by', sql.NVarChar(64), request.user?.username || null)
      .query(
        `INSERT INTO dbo.alert_rules
         (name, description, trigger_type, cron_expr, sql_template, key_column,
          event_name, target_users_json, target_roles_json, target_webhooks_json,
          card_title_template, card_body_template, card_btn_title, card_btn_url,
          cooldown_minutes, enabled, sort_order, created_by)
         VALUES (@name, @desc, @tt, @cron, @sqlt, @kc,
                 @ev, @tu, @tr, @tw,
                 @ct, @cb, @cbt, @cbu,
                 @cd, @en, @so, @by);
         SELECT SCOPE_IDENTITY() AS id`
      );

    // 重新加载调度
    await loadAndScheduleAlerts(fastify.log);
    return { id: rs.recordset[0].id };
  });

  // 修改规则
  fastify.patch('/admin/alert-rules/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const id = Number(request.params.id);
    const b = request.body || {};

    if (b.cron_expr && !cron.validate(b.cron_expr)) {
      return reply.code(400).send({ error: 'cron 表达式无效' });
    }

    const fields = [];
    const pool = await getPool();
    const req = pool.request().input('id', sql.Int, id);

    const map = {
      name: ['name', sql.NVarChar(128)],
      description: ['desc', sql.NVarChar(512)],
      trigger_type: ['tt', sql.VarChar(16)],
      cron_expr: ['cron', sql.VarChar(64)],
      sql_template: ['sqlt', sql.NVarChar(sql.MAX)],
      key_column: ['kc', sql.NVarChar(128)],
      event_name: ['ev', sql.VarChar(64)],
      card_title_template: ['ct', sql.NVarChar(256)],
      card_body_template: ['cb', sql.NVarChar(sql.MAX)],
      card_btn_title: ['cbt', sql.NVarChar(64)],
      card_btn_url: ['cbu', sql.NVarChar(512)],
      cooldown_minutes: ['cd', sql.Int],
      enabled: ['en', sql.Bit],
      sort_order: ['so', sql.Int],
    };

    for (const [col, [param, type]] of Object.entries(map)) {
      if (b[col] !== undefined) {
        let val = b[col];
        if (col === 'enabled') val = val ? 1 : 0;
        fields.push(`${col}=@${param}`);
        req.input(param, type, val ?? null);
      }
    }

    // JSON 数组字段特殊处理
    if (b.target_users_json !== undefined) {
      fields.push('target_users_json=@tu');
      req.input('tu', sql.NVarChar(512), b.target_users_json ? JSON.stringify(b.target_users_json) : null);
    }
    if (b.target_roles_json !== undefined) {
      fields.push('target_roles_json=@tr');
      req.input('tr', sql.NVarChar(512), b.target_roles_json ? JSON.stringify(b.target_roles_json) : null);
    }
    if (b.target_webhooks_json !== undefined) {
      fields.push('target_webhooks_json=@tw');
      req.input('tw', sql.NVarChar(512), b.target_webhooks_json ? JSON.stringify(b.target_webhooks_json) : null);
    }

    if (fields.length === 0) return reply.code(400).send({ error: '无更新字段' });
    fields.push('updated_at=DATEADD(HOUR,8,SYSUTCDATETIME())');

    const rs = await req.query(`UPDATE dbo.alert_rules SET ${fields.join(',')} WHERE id=@id; SELECT @@ROWCOUNT AS cnt`);
    if (!rs.recordset[0].cnt) return reply.code(404).send({ error: '规则不存在' });

    await loadAndScheduleAlerts(fastify.log);
    return { success: true };
  });

  // 删除规则
  fastify.delete('/admin/alert-rules/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const id = Number(request.params.id);
    const rs = await pool.request().input('id', sql.Int, id)
      .query('DELETE FROM dbo.alert_rules WHERE id=@id; SELECT @@ROWCOUNT AS cnt');
    if (!rs.recordset[0].cnt) return reply.code(404).send({ error: '规则不存在' });

    // 清理相关 sent_keys
    await pool.request().input('rid', sql.Int, id)
      .query('DELETE FROM dbo.alert_sent_keys WHERE rule_id=@rid');

    await loadAndScheduleAlerts(fastify.log);
    return { success: true };
  });

  // 手动触发一条规则
  fastify.post('/admin/alert-rules/:id/test', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const rule = await loadRuleById(Number(request.params.id));
    if (!rule) return reply.code(404).send({ error: '规则不存在' });

    if (rule.trigger_type === 'cron') {
      // 直接执行（忽略 cooldown，用于测试）
      executeRule(rule).catch((e) => fastify.log.error(e, 'alert manual trigger error'));
      return { success: true, message: '已触发执行（定时规则）' };
    } else {
      // 事件规则：用空数据触发
      const testData = request.body?.testData || { _test: true, _time: new Date().toISOString() };
      triggerEvent(rule.event_name, testData).catch((e) => fastify.log.error(e, 'alert manual event trigger error'));
      return { success: true, message: '已触发执行（事件规则）' };
    }
  });

  // ==================== Webhook CRUD ====================

  // Webhook 列表
  fastify.get('/admin/alert-webhooks', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const rs = await pool.request().query(
      `SELECT id, name, webhook_url, secret, enabled, created_at, updated_at
       FROM dbo.alert_webhooks ORDER BY id DESC`
    );
    // 隐藏完整 webhook_url 和 secret（安全考虑，仅前几位）
    const items = (rs.recordset || []).map((r) => ({
      ...r,
      webhook_url_masked: r.webhook_url ? r.webhook_url.slice(0, 60) + '...' : '',
      secret_masked: r.secret ? '****' : '',
    }));
    return { items };
  });

  // 新增 Webhook
  fastify.post('/admin/alert-webhooks', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    if (!b.name) return reply.code(400).send({ error: '缺少名称' });
    if (!b.webhook_url) return reply.code(400).send({ error: '缺少 Webhook URL' });

    const pool = await getPool();
    const rs = await pool.request()
      .input('name', sql.NVarChar(128), b.name)
      .input('url', sql.NVarChar(512), b.webhook_url)
      .input('sec', sql.NVarChar(128), b.secret || null)
      .input('en', sql.Bit, b.enabled !== false ? 1 : 0)
      .query(
        `INSERT INTO dbo.alert_webhooks (name, webhook_url, secret, enabled)
         VALUES (@name, @url, @sec, @en);
         SELECT SCOPE_IDENTITY() AS id`
      );
    return { id: rs.recordset[0].id };
  });

  // 修改 Webhook
  fastify.patch('/admin/alert-webhooks/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const id = Number(request.params.id);
    const b = request.body || {};
    const fields = [];
    const pool = await getPool();
    const req = pool.request().input('id', sql.Int, id);

    if (b.name != null) { fields.push('name=@name'); req.input('name', sql.NVarChar(128), b.name); }
    if (b.webhook_url != null) { fields.push('webhook_url=@url'); req.input('url', sql.NVarChar(512), b.webhook_url); }
    if (b.secret !== undefined) { fields.push('secret=@sec'); req.input('sec', sql.NVarChar(128), b.secret || null); }
    if (b.enabled != null) { fields.push('enabled=@en'); req.input('en', sql.Bit, b.enabled ? 1 : 0); }

    if (fields.length === 0) return reply.code(400).send({ error: '无更新字段' });
    fields.push('updated_at=DATEADD(HOUR,8,SYSUTCDATETIME())');

    const rs = await req.query(`UPDATE dbo.alert_webhooks SET ${fields.join(',')} WHERE id=@id; SELECT @@ROWCOUNT AS cnt`);
    if (!rs.recordset[0].cnt) return reply.code(404).send({ error: 'Webhook 不存在' });
    return { success: true };
  });

  // 删除 Webhook
  fastify.delete('/admin/alert-webhooks/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, Number(request.params.id))
      .query('DELETE FROM dbo.alert_webhooks WHERE id=@id; SELECT @@ROWCOUNT AS cnt');
    if (!rs.recordset[0].cnt) return reply.code(404).send({ error: 'Webhook 不存在' });
    return { success: true };
  });

  // ==================== 推送日志 ====================

  // 日志查询（支持规则筛选 + 分页）
  fastify.get('/admin/alert-logs', { preHandler: [fastify.requireAdmin] }, async (request) => {
    const { rule_id, status, page = 1, pageSize = 30 } = request.query;
    const pool = await getPool();
    const req = pool.request();

    let where = '1=1';
    if (rule_id) {
      where += ' AND rule_id=@rid';
      req.input('rid', sql.Int, Number(rule_id));
    }
    if (status) {
      where += ' AND status=@s';
      req.input('s', sql.VarChar(16), status);
    }

    const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);
    req.input('offset', sql.Int, offset);
    req.input('limit', sql.Int, Number(pageSize));

    const rs = await req.query(
      `SELECT id, rule_id, rule_name, trigger_type, event_name, triggered_at,
              status, target_count, sent_count, webhook_count,
              card_title, error_message, finished_at
       FROM dbo.alert_logs
       WHERE ${where}
       ORDER BY triggered_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
    );

    // 总数
    const countReq = pool.request();
    if (rule_id) countReq.input('rid', sql.Int, Number(rule_id));
    if (status) countReq.input('s', sql.VarChar(16), status);
    const countRs = await countReq.query(`SELECT COUNT(*) AS total FROM dbo.alert_logs WHERE ${where}`);

    return {
      items: rs.recordset || [],
      total: countRs.recordset[0].total,
      page: Number(page),
      pageSize: Number(pageSize),
    };
  });

  // 单条日志详情（含 data_snapshot 和 card_body）
  fastify.get('/admin/alert-logs/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, Number(request.params.id))
      .query('SELECT * FROM dbo.alert_logs WHERE id=@id');
    const row = rs.recordset?.[0];
    if (!row) return reply.code(404).send({ error: '日志不存在' });
    return row;
  });
}

module.exports = alertAdminRoutes;
