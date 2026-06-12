const { getPool, sql } = require('../db');
const { aiService } = require('../ai');
const {
  buildHelpSystemPrompt,
  retrieveRelevantChunks,
  suggestNavActions,
  getHelpBootstrap,
  HELP_DOC_VERSION,
} = require('../help-knowledge');
const {
  parseFilterSchemaJson,
  buildReportSessionInject,
  executeReportQuery,
  parseColumnNameMappingJson,
  applyColumnNameMapping,
  detectTemplateKind,
  normalizeTemplate,
} = require('../report-query');
const {
  parseMenuRolesJson,
  getUserRolesFromRequest,
  canAccessMenu,
} = require('../roles');

/**
 * AI 分析路由
 * 支持从菜单配置的 ai_prompt + 当前报表数据生成智能分析
 */
async function aiRoutes(fastify) {
  // AI 报表分析主接口
  fastify.post(
    '/ai/analyze',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const routeKey = String(body.routeKey || '').trim().toLowerCase();
      const params = body.params && typeof body.params === 'object' ? body.params : {};

      if (!routeKey) {
        return reply.code(400).send({ 
          error: '请提供 routeKey', 
          code: 'AI_BAD_REQUEST' 
        });
      }

      const userRoles = getUserRolesFromRequest(request.user);
      const pool = await getPool();

      let row;
      try {
        const rs = await pool
          .request()
          .input('rk', sql.NVarChar(64), routeKey)
          .query(`
            SELECT id, label, route_key, enabled, roles_json, menu_kind, 
                   query_template, filter_schema_json, ai_prompt,
                   COALESCE(column_name_mapping_json, N'{}') AS column_name_mapping_json
            FROM dbo.nav_menu_items 
            WHERE route_key = @rk
          `);
        row = rs.recordset && rs.recordset[0];
      } catch (err) {
        request.log.error({ err }, 'ai/analyze load menu');
        return reply.code(503).send({
          error: '无法读取菜单配置',
          code: 'AI_MENU_LOAD_ERROR'
        });
      }

      if (!row || !row.enabled) {
        return reply.code(404).send({ 
          error: '菜单不存在或未启用', 
          code: 'AI_MENU_NOT_FOUND' 
        });
      }

      const roles = parseMenuRolesJson(row.roles_json || '[]');
      if (!canAccessMenu(userRoles, roles)) {
        return reply.code(403).send({ 
          error: '无权访问该报表', 
          code: 'AI_FORBIDDEN' 
        });
      }

      if (String(row.menu_kind || '').toLowerCase() !== 'report') {
        return reply.code(400).send({ 
          error: '仅支持报表菜单的 AI 分析', 
          code: 'AI_NOT_REPORT_MENU' 
        });
      }

      const aiPrompt = String(row.ai_prompt || '').trim();
      if (!aiPrompt) {
        return reply.code(400).send({
          error: '该报表未配置 AI Prompt，请管理员在菜单设置中添加',
          code: 'AI_PROMPT_NOT_CONFIGURED'
        });
      }

      const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
      if (!fs.ok) {
        return reply.code(503).send({ error: fs.error, code: 'AI_SCHEMA_INVALID' });
      }

      const mapParse = parseColumnNameMappingJson(row.column_name_mapping_json);
      const colMap = mapParse.ok ? mapParse.mapping : {};

      try {
        // 使用较小的 pageSize 获取摘要数据，避免 token 超限
        const template = normalizeTemplate(row.query_template || '');
        const templateKind = detectTemplateKind(template) || 'select';
        const reportResult = await executeReportQuery(pool, {
          templateKind,
          sqlTemplate: row.query_template,
          schemaFields: fs.fields,
          params,
          sessionInject: buildReportSessionInject(request.user),
          page: 1,
          pageSize: 30,  // 限制数据量用于AI分析，控制 token 消耗
        });

        const mappedResult = applyColumnNameMapping(reportResult, colMap);

        // 构建 Prompt
        const prompt = aiService.buildPrompt(
          {
            label: row.label,
            ai_prompt: aiPrompt,
          },
          mappedResult,
          params
        );

        // 调用 AI
        const aiResult = await aiService.generateAnalysis(prompt, {
          menuLabel: row.label,
          routeKey
        });

        return {
          routeKey,
          label: row.label,
          success: aiResult.success,
          analysis: aiResult.result || aiResult.fallback,
          ...(aiResult.success ? {} : { aiError: aiResult.error || null }),
          provider: aiResult.provider,
          model: aiResult.model,
          metadata: {
            rowCount: mappedResult.rows ? mappedResult.rows.length : 0,
            totalRowCount: mappedResult.totalRowCount || 0,
            hasAIConfig: !!aiPrompt
          }
        };
      } catch (err) {
        request.log.error({ err, routeKey }, 'ai/analyze execute');
        const code = err.code || 'AI_EXEC_ERROR';
        return reply.code(500).send({
          error: 'AI 分析执行失败',
          code,
          detail: err.message || String(err)
        });
      }
    }
  );

  /** AI 助手：快捷问题与知识库元信息 */
  fastify.get(
    '/ai/help/bootstrap',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const userRole = String(request.user.role || 'operator');
      return getHelpBootstrap(userRole);
    }
  );

  /** 主界面 AI 对话（使用说明 RAG + 可选跳转建议） */
  fastify.post(
    '/ai/chat',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const raw = body.messages;
      if (!Array.isArray(raw)) {
        return reply.code(400).send({ error: '请提供 messages 数组', code: 'AI_CHAT_BAD_REQUEST' });
      }

      const pair = [];
      for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        const role = String(m.role || '').toLowerCase();
        if (role !== 'user' && role !== 'assistant') continue;
        let content = String(m.content != null ? m.content : '').trim();
        if (!content) continue;
        if (content.length > 12000) content = content.slice(0, 12000);
        pair.push({ role, content });
      }

      const history = pair.slice(-24);
      const firstUser = history.findIndex((m) => m.role === 'user');
      if (firstUser < 0) {
        return reply.code(400).send({ error: '请至少发送一条用户消息', code: 'AI_CHAT_BAD_REQUEST' });
      }
      const trimmed = history.slice(firstUser);

      const lastUser = [...trimmed].reverse().find((m) => m.role === 'user');
      const userQuery = lastUser ? lastUser.content : '';
      const userRole = String(request.user.role || 'operator');

      const systemPrompt = buildHelpSystemPrompt(userQuery, userRole);
      const sources = retrieveRelevantChunks(userQuery, 5).map((c) => c.title);
      const actions = suggestNavActions(userQuery);

      const messages = [{ role: 'system', content: systemPrompt }, ...trimmed];

      const result = await aiService.generateChat(messages, { maxTokens: 2048 });
      if (!result.success) {
        return reply.code(502).send({
          success: false,
          error: result.fallback || result.error || 'AI 不可用',
          code: 'AI_CHAT_FAILED',
        });
      }

      return {
        success: true,
        message: result.content,
        provider: result.provider,
        model: result.model,
        sources,
        actions,
        helpVersion: HELP_DOC_VERSION,
      };
    }
  );

  // AI Prompt 生成器 - 仅管理员可用
  fastify.post(
    '/ai/generate-prompt',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const body = request.body || {};
      const description = String(body.description || '').trim();
      const reportType = String(body.reportType || '').trim();

      if (!description) {
        return reply.code(400).send({
          success: false,
          error: '请提供业务需求描述',
          code: 'PROMPT_GEN_BAD_REQUEST'
        });
      }

      try {
        const result = await aiService.generatePromptTemplate(description, reportType);

        if (!result.success) {
          return reply.code(400).send(result);
        }

        return {
          success: true,
          prompt: result.prompt,
          model: result.model,
          message: 'AI Prompt 生成成功！可直接复制到菜单的 AI 分析 Prompt 字段中使用。'
        };
      } catch (err) {
        request.log.error({ err }, 'ai/generate-prompt');
        return reply.code(500).send({
          success: false,
          error: '生成 Prompt 失败',
          code: 'PROMPT_GEN_ERROR',
          detail: err.message
        });
      }
    }
  );

  // AI 辅助生成 Skill 内容 - 仅管理员可用
  fastify.post(
    '/ai/generate-skill',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const requirement = String((request.body || {}).requirement || '').trim();
      if (!requirement) {
        return reply.code(400).send({ success: false, error: '请提供需求描述' });
      }
      try {
        const result = await aiService.generateSkillContent(requirement);
        if (!result.success) return reply.code(400).send(result);
        return result;
      } catch (err) {
        request.log.error({ err }, 'ai/generate-skill');
        return reply.code(500).send({ success: false, error: '生成 Skill 失败', detail: err.message });
      }
    }
  );
}

module.exports = aiRoutes;
