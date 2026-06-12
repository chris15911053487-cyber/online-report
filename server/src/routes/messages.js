const { getPool } = require('../db');
const {
  loadAllRules,
  loadRuleById,
  getSummaryForUser,
  getRuleItemsForUser,
  markItemsRead,
  markAllRead,
  testRuleSql,
  createRule,
  updateRule,
  deleteRule,
  buildReportSessionInject,
} = require('../message-alerts');

async function messagesRoutes(fastify) {
  fastify.get(
    '/messages/summary',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const pool = await getPool();
        return await getSummaryForUser(request.user, pool);
      } catch (err) {
        request.log.error({ err }, 'messages/summary');
        return reply.code(500).send({
          error: '加载消息摘要失败',
          code: 'ALERT_SUMMARY_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.get(
    '/messages/rules/:id/items',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const ruleId = Number.parseInt(String(request.params.id || ''), 10);
      if (!Number.isFinite(ruleId) || ruleId <= 0) {
        return reply.code(400).send({ error: '无效的规则 ID', code: 'ALERT_BAD_REQUEST' });
      }

      try {
        const pool = await getPool();
        return await getRuleItemsForUser(request.user, pool, ruleId);
      } catch (err) {
        const code = err.code || 'ALERT_ITEMS_ERROR';
        if (code === 'ALERT_RULE_NOT_FOUND') {
          return reply.code(404).send({ error: err.message, code });
        }
        if (code === 'ALERT_FORBIDDEN') {
          return reply.code(403).send({ error: err.message, code });
        }
        request.log.error({ err }, 'messages/rules/items');
        return reply.code(500).send({
          error: '加载提醒明细失败',
          code,
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.post(
    '/messages/rules/:id/read',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const ruleId = Number.parseInt(String(request.params.id || ''), 10);
      if (!Number.isFinite(ruleId) || ruleId <= 0) {
        return reply.code(400).send({ error: '无效的规则 ID', code: 'ALERT_BAD_REQUEST' });
      }

      const body = request.body || {};
      const sessionInject = buildReportSessionInject(request.user);
      const userCode = sessionInject.userCode;
      if (!userCode) {
        return reply.code(400).send({ error: '无法识别当前用户', code: 'ALERT_BAD_REQUEST' });
      }

      try {
        const pool = await getPool();
        const rule = await loadRuleById(pool, ruleId);
        if (!rule) {
          return reply.code(404).send({ error: '提醒规则不存在', code: 'ALERT_RULE_NOT_FOUND' });
        }

        if (body.all === true) {
          const result = await markAllRead(pool, userCode, ruleId, rule);
          return { success: true, ...result };
        }

        const keys = Array.isArray(body.keys) ? body.keys : [];
        const result = await markItemsRead(pool, userCode, ruleId, keys);
        return { success: true, ...result };
      } catch (err) {
        request.log.error({ err }, 'messages/rules/read');
        return reply.code(500).send({
          error: '标记已读失败',
          code: 'ALERT_READ_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.get(
    '/messages/admin/rules',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      try {
        const pool = await getPool();
        const rules = await loadAllRules(pool);
        return { items: rules };
      } catch (err) {
        request.log.error({ err }, 'messages/admin/rules list');
        return reply.code(500).send({
          error: '加载提醒规则失败',
          code: 'ALERT_ADMIN_LIST_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.post(
    '/messages/admin/rules',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const body = request.body || {};
      if (!String(body.name || '').trim()) {
        return reply.code(400).send({ error: '请填写规则名称', code: 'ALERT_BAD_REQUEST' });
      }
      if (!String(body.sqlTemplate || '').trim()) {
        return reply.code(400).send({ error: '请填写 SQL 语句', code: 'ALERT_BAD_REQUEST' });
      }
      if (!String(body.keyColumn || '').trim()) {
        return reply.code(400).send({ error: '请填写唯一键列', code: 'ALERT_BAD_REQUEST' });
      }

      try {
        const pool = await getPool();
        const rule = await createRule(pool, body);
        return { success: true, rule };
      } catch (err) {
        request.log.error({ err }, 'messages/admin/rules create');
        return reply.code(500).send({
          error: '创建提醒规则失败',
          code: 'ALERT_ADMIN_CREATE_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.put(
    '/messages/admin/rules/:id',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const ruleId = Number.parseInt(String(request.params.id || ''), 10);
      if (!Number.isFinite(ruleId) || ruleId <= 0) {
        return reply.code(400).send({ error: '无效的规则 ID', code: 'ALERT_BAD_REQUEST' });
      }

      try {
        const pool = await getPool();
        const rule = await updateRule(pool, ruleId, request.body || {});
        return { success: true, rule };
      } catch (err) {
        const code = err.code || 'ALERT_ADMIN_UPDATE_ERROR';
        if (code === 'ALERT_RULE_NOT_FOUND') {
          return reply.code(404).send({ error: err.message, code });
        }
        request.log.error({ err }, 'messages/admin/rules update');
        return reply.code(500).send({
          error: '更新提醒规则失败',
          code,
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.delete(
    '/messages/admin/rules/:id',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const ruleId = Number.parseInt(String(request.params.id || ''), 10);
      if (!Number.isFinite(ruleId) || ruleId <= 0) {
        return reply.code(400).send({ error: '无效的规则 ID', code: 'ALERT_BAD_REQUEST' });
      }

      try {
        const pool = await getPool();
        await deleteRule(pool, ruleId);
        return { success: true };
      } catch (err) {
        request.log.error({ err }, 'messages/admin/rules delete');
        return reply.code(500).send({
          error: '删除提醒规则失败',
          code: 'ALERT_ADMIN_DELETE_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  fastify.post(
    '/messages/admin/rules/test',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const sqlTemplate = String((request.body || {}).sqlTemplate || '').trim();
      if (!sqlTemplate) {
        return reply.code(400).send({ error: '请提供 sqlTemplate', code: 'ALERT_BAD_REQUEST' });
      }

      try {
        const pool = await getPool();
        const result = await testRuleSql(pool, request.user, sqlTemplate);
        return result;
      } catch (err) {
        const code = err.code || 'ALERT_TEST_ERROR';
        if (code === 'ALERT_SQL_INVALID') {
          return reply.code(400).send({ error: err.message, code });
        }
        request.log.error({ err }, 'messages/admin/rules test');
        return reply.code(500).send({
          error: 'SQL 试运行失败',
          code,
          detail: err.message || String(err),
        });
      }
    }
  );
}

module.exports = messagesRoutes;
