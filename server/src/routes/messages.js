const { getPool } = require('../db');
const { buildReportSessionInject } = require('../report-query');
const { listInbox, openInboxItem, markInboxRead, countInboxUnread } = require('../notify');
const { countMyOpenTasks } = require('../tasks');

/** 当前用户编码；取不到时回 400 并返回 null */
function currentUserCode(request, reply) {
  const userCode = buildReportSessionInject(request.user).userCode;
  if (!userCode) {
    reply.code(400).send({ error: '无法识别当前用户', code: 'MESSAGES_BAD_REQUEST' });
    return null;
  }
  return userCode;
}

/** 「消息」入口红点：通知未读 + 我的待处理待办；一项查询失败（如表未建好）不影响另一项 */
async function messagesRoutes(fastify) {
  fastify.get(
    '/messages/summary',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = currentUserCode(request, reply);
      if (!userCode) return reply;
      const pool = await getPool();
      const safe = async (label, fn) => {
        try {
          return await fn();
        } catch (err) {
          request.log.warn({ err: err.message }, `messages/summary ${label}`);
          return 0;
        }
      };
      const [inboxUnread, todoOpen] = await Promise.all([
        safe('inbox', () => countInboxUnread(pool, userCode)),
        safe('tasks', () => countMyOpenTasks(pool, userCode)),
      ]);
      return { inboxUnread, todoOpen, totalUnread: inboxUnread + todoOpen, refreshSeconds: 60 };
    }
  );

  // ---------- 通知（收件箱）：警报、定时报告等主动推送的内容 ----------

  fastify.get(
    '/messages/inbox',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = currentUserCode(request, reply);
      if (!userCode) return reply;
      const q = request.query || {};
      try {
        const pool = await getPool();
        return await listInbox(pool, userCode, {
          before: q.before,
          limit: q.limit,
          unreadOnly: q.unread === '1' || q.unread === 'true',
        });
      } catch (err) {
        request.log.error({ err }, 'messages/inbox');
        return reply.code(500).send({ error: '加载通知失败', code: 'INBOX_ERROR' });
      }
    }
  );

  fastify.get(
    '/messages/inbox/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = Number.parseInt(String(request.params.id || ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的通知 ID', code: 'INBOX_BAD_REQUEST' });
      }
      const userCode = currentUserCode(request, reply);
      if (!userCode) return reply;
      try {
        const pool = await getPool();
        const item = await openInboxItem(pool, userCode, id);
        // 不是接收人与不存在同样处理，不暴露别人的通知是否存在
        if (!item) return reply.code(404).send({ error: '通知不存在或不是发给你的', code: 'INBOX_NOT_FOUND' });
        return { item };
      } catch (err) {
        request.log.error({ err }, 'messages/inbox/:id');
        return reply.code(500).send({ error: '加载通知失败', code: 'INBOX_ERROR' });
      }
    }
  );

  fastify.post(
    '/messages/inbox/read',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = currentUserCode(request, reply);
      if (!userCode) return reply;
      const body = request.body || {};
      try {
        const pool = await getPool();
        const result = await markInboxRead(pool, userCode, { ids: body.ids, all: body.all === true });
        return { success: true, ...result };
      } catch (err) {
        request.log.error({ err }, 'messages/inbox/read');
        return reply.code(500).send({ error: '标记已读失败', code: 'INBOX_READ_ERROR' });
      }
    }
  );
}

module.exports = messagesRoutes;
