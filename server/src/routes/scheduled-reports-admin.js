/**
 * 定时报告管理 API（仅管理员）
 */
const cron = require('node-cron');
const { getPool, sql } = require('../db');
const { loadAndSchedule, executeReport, buildDigest } = require('../scheduled-reports');
const { getAgent } = require('../agents');

/** 看板要点：agent_key 须为存在、启用且关联了看板的 Agent */
async function checkDigestAgent(pool, agentKey) {
  const agent = await getAgent(pool, String(agentKey).trim().toLowerCase());
  if (!agent) return { error: `Agent 不存在：${agentKey}` };
  if (!agent.enabled) return { error: `Agent 未启用：${agentKey}` };
  if (!agent.dashboardKey) return { error: `Agent「${agent.label}」没有关联看板` };
  return { agent };
}

async function scheduledReportsAdminRoutes(fastify) {
  // 列表
  fastify.get('/admin/scheduled-reports', { preHandler: [fastify.requireAdmin] }, async () => {
    const pool = await getPool();
    const rs = await pool.request().query(
      `SELECT id, name, cron_expr, skill_name, prompt_template, agent_key,
              target_roles_json, target_users_json, channels_json, enabled,
              created_by, created_at, updated_at
       FROM dbo.scheduled_reports ORDER BY id DESC`
    );
    return { items: rs.recordset || [] };
  });

  // 新增
  fastify.post('/admin/scheduled-reports', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const { name, cron_expr, skill_name, prompt_template, agent_key, target_roles_json, target_users_json, channels_json, enabled } = request.body || {};
    if (!name || !cron_expr || (!prompt_template && !agent_key)) {
      return reply.code(400).send({ error: '缺少 name / cron_expr / prompt_template（看板要点可不填指令）' });
    }
    if (!cron.validate(cron_expr)) {
      return reply.code(400).send({ error: 'cron 表达式无效' });
    }
    const pool = await getPool();
    if (agent_key) {
      const c = await checkDigestAgent(pool, agent_key);
      if (c.error) return reply.code(400).send({ error: c.error });
    }
    const rs = await pool.request()
      .input('name', sql.NVarChar(128), name)
      .input('cron', sql.VarChar(64), cron_expr)
      .input('skill', sql.NVarChar(64), skill_name || null)
      .input('prompt', sql.NVarChar(sql.MAX), prompt_template || '')
      .input('agent', sql.NVarChar(64), agent_key ? String(agent_key).trim().toLowerCase() : null)
      .input('roles', sql.NVarChar(512), target_roles_json ? JSON.stringify(target_roles_json) : null)
      .input('users', sql.NVarChar(512), target_users_json ? JSON.stringify(target_users_json) : null)
      .input('ch', sql.NVarChar(128), JSON.stringify(channels_json || ['dingtalk']))
      .input('en', sql.Bit, enabled !== false ? 1 : 0)
      .input('by', sql.NVarChar(64), request.user?.username || null)
      .query(`INSERT INTO dbo.scheduled_reports
              (name, cron_expr, skill_name, prompt_template, agent_key, target_roles_json, target_users_json, channels_json, enabled, created_by)
              VALUES (@name, @cron, @skill, @prompt, @agent, @roles, @users, @ch, @en, @by);
              SELECT SCOPE_IDENTITY() AS id`);
    await loadAndSchedule(fastify.log);
    return { id: rs.recordset[0].id };
  });

  // 修改
  fastify.patch('/admin/scheduled-reports/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const id = Number(request.params.id);
    const body = request.body || {};
    if (body.cron_expr && !cron.validate(body.cron_expr)) {
      return reply.code(400).send({ error: 'cron 表达式无效' });
    }
    const fields = [];
    const pool = await getPool();
    const req = pool.request().input('id', sql.Int, id);

    if (body.name != null) { fields.push('name=@name'); req.input('name', sql.NVarChar(128), body.name); }
    if (body.cron_expr != null) { fields.push('cron_expr=@cron'); req.input('cron', sql.VarChar(64), body.cron_expr); }
    if (body.skill_name !== undefined) { fields.push('skill_name=@skill'); req.input('skill', sql.NVarChar(64), body.skill_name || null); }
    if (body.prompt_template != null) { fields.push('prompt_template=@prompt'); req.input('prompt', sql.NVarChar(sql.MAX), body.prompt_template); }
    if (body.target_roles_json !== undefined) { fields.push('target_roles_json=@roles'); req.input('roles', sql.NVarChar(512), body.target_roles_json ? JSON.stringify(body.target_roles_json) : null); }
    if (body.target_users_json !== undefined) { fields.push('target_users_json=@users'); req.input('users', sql.NVarChar(512), body.target_users_json ? JSON.stringify(body.target_users_json) : null); }
    if (body.agent_key !== undefined) {
      if (body.agent_key) {
        const c = await checkDigestAgent(pool, body.agent_key);
        if (c.error) return reply.code(400).send({ error: c.error });
      }
      fields.push('agent_key=@agent');
      req.input('agent', sql.NVarChar(64), body.agent_key ? String(body.agent_key).trim().toLowerCase() : null);
    }
    if (body.channels_json != null) { fields.push('channels_json=@ch'); req.input('ch', sql.NVarChar(128), JSON.stringify(body.channels_json)); }
    if (body.enabled != null) { fields.push('enabled=@en'); req.input('en', sql.Bit, body.enabled ? 1 : 0); }

    if (fields.length === 0) return reply.code(400).send({ error: '无更新字段' });
    fields.push('updated_at=DATEADD(HOUR,8,SYSUTCDATETIME())');

    const rs = await req.query(`UPDATE dbo.scheduled_reports SET ${fields.join(',')} WHERE id=@id; SELECT @@ROWCOUNT AS cnt`);
    if (!rs.recordset[0].cnt) return reply.code(404).send({ error: '不存在' });
    await loadAndSchedule(fastify.log);
    return { success: true };
  });

  // 删除
  fastify.delete('/admin/scheduled-reports/:id', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, Number(request.params.id))
      .query('DELETE FROM dbo.scheduled_reports WHERE id=@id; SELECT @@ROWCOUNT AS cnt');
    if (!rs.recordset[0].cnt) return reply.code(404).send({ error: '不存在' });
    await loadAndSchedule(fastify.log);
    return { success: true };
  });

  // 手动触发一次
  fastify.post('/admin/scheduled-reports/:id/trigger', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, Number(request.params.id))
      .query('SELECT * FROM dbo.scheduled_reports WHERE id=@id');
    const row = rs.recordset?.[0];
    if (!row) return reply.code(404).send({ error: '不存在' });
    // 异步执行，不阻塞响应
    executeReport(row, fastify.log).catch((e) => fastify.log.error(e, 'manual trigger error'));
    return { success: true, message: '已触发执行' };
  });

  /**
   * 预览看板要点（不推送）：按指定角色（默认管理员视角）取数、AI 写要点，返回将要发出的正文。
   */
  fastify.post('/admin/scheduled-reports/digest-preview', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    if (!b.agent_key) return reply.code(400).send({ error: '请选择关联看板的 Agent' });
    const pool = await getPool();
    const c = await checkDigestAgent(pool, b.agent_key);
    if (c.error) return reply.code(400).send({ error: c.error });
    const role = String(b.role || '').trim();
    try {
      const r = await buildDigest(pool, { agent: c.agent, roles: role ? [role] : ['admin'], title: b.name || '看板要点', focus: b.prompt_template });
      return { text: r.text, cardCount: r.cardCount, agentRoles: c.agent.roles };
    } catch (err) {
      request.log.warn({ err: err.message }, 'digest preview failed');
      return reply.code(400).send({ error: `生成失败：${err.message}` });
    }
  });

  // 查看执行日志
  fastify.get('/admin/scheduled-reports/:id/logs', { preHandler: [fastify.requireAdmin] }, async (request) => {
    const pool = await getPool();
    const rs = await pool.request().input('id', sql.Int, Number(request.params.id))
      .query(`SELECT TOP 50 id, started_at, finished_at, status, target_count, sent_count, error_message
              FROM dbo.scheduled_report_logs WHERE report_id=@id ORDER BY started_at DESC`);
    return { items: rs.recordset || [] };
  });
}

module.exports = scheduledReportsAdminRoutes;
