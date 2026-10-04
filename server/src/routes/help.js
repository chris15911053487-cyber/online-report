/**
 * 使用说明书：前端整篇阅读（server/help/*.md）。
 * AI 检索同一批文件走 help-knowledge.js（/ai/chat、ai-agent 的 knowledge_search）。
 */
const fs = require('fs');
const fastifyStatic = require('@fastify/static');
const { isAdminUser } = require('../roles');
const { HELP_IMAGES_DIR, listHelpDocs, readHelpDoc } = require('../help-docs');

async function helpRoutes(fastify) {
  fastify.get('/help/docs', { preHandler: [fastify.authenticate] }, async (request) => {
    return { docs: listHelpDocs({ isAdmin: isAdminUser(request.user) }) };
  });

  fastify.get('/help/docs/:slug', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const doc = readHelpDoc(String(request.params.slug || ''), { isAdmin: isAdminUser(request.user) });
    if (doc === 'forbidden') return reply.code(403).send({ error: '该说明仅管理员可看', code: 'HELP_FORBIDDEN' });
    if (!doc) return reply.code(404).send({ error: '没有这篇说明', code: 'HELP_NOT_FOUND' });
    return doc;
  });

  // 说明书配图：<img> 带不了 JWT，公开访问（只放界面截图，不放业务敏感数据）
  if (!fs.existsSync(HELP_IMAGES_DIR)) return;
  await fastify.register(fastifyStatic, {
    root: HELP_IMAGES_DIR,
    prefix: '/help/images/',
    decorateReply: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600'),
  });
}

module.exports = helpRoutes;
