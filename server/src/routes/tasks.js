/**
 * 待办接口（「消息 → 待办」）
 *
 * - GET  /tasks?scope=mine|team&status=open|snoozed|done   我的 / 团队待办（团队 = 我是主管的规则；管理员看全部）
 * - GET  /tasks/:id                                         详情 + 处理记录（负责人、规则主管、管理员可看）
 * - POST /tasks/:id/:action                                 done 已处理 / snooze 延后 { until } / transfer 转交 { to } / note 备注 / reopen 重新打开；都可带 { note }
 * - GET  /tasks/users?q=                                    转交时搜索用户（仅自己有待办或是主管的人）
 * - GET  /admin/tasks/stats?days=7                          完成率 / 超期率（按负责人、按规则）
 * - POST /admin/tasks/digest { kind: morning|afternoon }    立即推送一次汇总（测试用）
 */
const { getPool } = require('../db');
const { listTasks, getTask, actOnTask, taskStats, canSearchUsers, TaskError } = require('../tasks');
const { runDigest } = require('../alert-scheduler');
const { searchOusrUsers } = require('./roles-admin');

const ACTIONS = new Set(['done', 'snooze', 'transfer', 'note', 'reopen']);

function parseId(raw) {
  const id = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function sendError(request, reply, err, label) {
  if (err instanceof TaskError) return reply.code(err.status).send({ error: err.message, code: err.code });
  request.log.error({ err }, label);
  return reply.code(500).send({ error: '处理待办失败', code: 'TASK_ERROR' });
}

async function tasksRoutes(fastify) {
  fastify.get('/tasks', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const q = request.query || {};
    const scope = q.scope === 'team' ? 'team' : 'mine';
    const status = ['open', 'snoozed', 'done'].includes(q.status) ? q.status : 'open';
    try {
      return await listTasks(await getPool(), request.user, { scope, status });
    } catch (err) {
      return sendError(request, reply, err, 'tasks list');
    }
  });

  // 写在 /tasks/:id 之前：users 不是数字 id
  fastify.get('/tasks/users', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const pool = await getPool();
      // 只给要转交的人用：自己有待办，或是主管
      if (!(await canSearchUsers(pool, request.user))) return reply.code(403).send({ error: '没有可转交的待办', code: 'TASK_FORBIDDEN' });
      const items = await searchOusrUsers(pool, String(request.query?.q || '').trim(), 20);
      return { items };
    } catch (err) {
      return sendError(request, reply, err, 'tasks users');
    }
  });

  fastify.get('/tasks/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const id = parseId(request.params.id);
    if (!id) return reply.code(400).send({ error: '无效的待办 ID', code: 'TASK_BAD_REQUEST' });
    try {
      return await getTask(await getPool(), request.user, id);
    } catch (err) {
      return sendError(request, reply, err, 'tasks get');
    }
  });

  fastify.post('/tasks/:id/:action', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const id = parseId(request.params.id);
    const action = String(request.params.action || '');
    if (!id || !ACTIONS.has(action)) return reply.code(400).send({ error: '无效的请求', code: 'TASK_BAD_REQUEST' });
    try {
      return await actOnTask(await getPool(), request.user, id, action, request.body || {});
    } catch (err) {
      return sendError(request, reply, err, `tasks ${action}`);
    }
  });

  fastify.get('/admin/tasks/stats', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    try {
      return await taskStats(await getPool(), { days: request.query?.days });
    } catch (err) {
      return sendError(request, reply, err, 'tasks stats');
    }
  });

  fastify.post('/admin/tasks/digest', { preHandler: [fastify.requireAdmin] }, async (request) => {
    const kind = request.body?.kind === 'afternoon' ? 'afternoon' : 'morning';
    // 先同步全部定时待办规则再推，可能较慢：后台执行，结果看「运行日志」与「消息 → 通知」
    void runDigest(kind, request.log);
    return { success: true, message: kind === 'morning' ? '已开始：同步待办并推送早上汇总' : '已开始：同步待办并推送下午提醒' };
  });
}

module.exports = tasksRoutes;
