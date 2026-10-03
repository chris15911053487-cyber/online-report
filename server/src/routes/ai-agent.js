/**
 * AI Agent 网关与 Skill 回调路由。
 *
 * 架构（见设计讨论）：
 * - 前端只调本主后端，不直连 ai-agent 容器（JWT 在此统一校验，CORS 复用）。
 * - 主后端把请求转发给 ai-agent（内网 AI_AGENT_URL），并签发短期 scoped token。
 * - ai-agent 需要数据时回调 /ai/agent/internal/*，带 scoped token；
 *   主后端据此还原用户角色并做 canAccessMenu 门禁（Agent 自身无 DB 凭据）。
 * - 会话历史落 SQL Server（ai_conversations / ai_messages），支持续聊与审计。
 */
const { getPool, sql } = require('../db');
const {
  getUserRolesFromRequest,
  canAccessMenu,
  parseMenuRolesJson,
} = require('../roles');
const {
  parseFilterSchemaJson,
  parseColumnNameMappingJson,
  applyColumnNameMapping,
  buildReportSessionInject,
  executeReportQuery,
  loadFilterFieldOptionsItems,
  normalizeTemplate,
  detectTemplateKind,
} = require('../report-query');
const {
  signScopedToken,
  verifyScopedToken,
  userFromScopedPayload,
} = require('../ai-scoped-token');
const { listSkillsForRoles, canUseSkill, checkSqlTablesAllowed, getSkill } = require('../agent-skills');
const { runSqlLimited } = require('../agent-sql');
const { resolveAgentContext } = require('../agent-context');
const { agentChatCore } = require('../agent-chat-core');
const { normalizeBiContext, normalizeMode } = require('../bi-context');
const { getQuery: getBiQuery, canUseQuery: canUseBiQuery } = require('../bi-queries');
const { runNamedQuery, BiParamError } = require('../bi-exec');
const {
  isValidConversationId,
  ensureConversation,
  touchConversation,
  addMessage,
  listConversations,
  getConversationMessages,
  deleteConversation,
} = require('../ai-conversations');
const { retrieveRelevantChunks, suggestNavActions } = require('../help-knowledge');
const { aiService } = require('../ai');
const fs = require('fs');
const {
  getWriteTarget,
  performWrite,
  writeAuditLog,
  listWriteTargets,
  validateTargetInput,
  upsertWriteTarget,
  deleteWriteTarget,
} = require('../agent-write');
const { storeDocument, getOwnedDocument } = require('../agent-documents');
const { getAction: getAgentAction, listActions: listAgentActions } = require('../agent-actions');

function agentBaseUrl() {
  return String(process.env.AI_AGENT_URL || 'http://ai-agent:8080').replace(/\/+$/, '');
}
function agentEnabled() {
  return process.env.AI_AGENT_ENABLED !== 'false';
}
function agentTimeoutMs() {
  const n = Number(process.env.AI_AGENT_TIMEOUT_MS || 90000);
  return Number.isFinite(n) && n > 0 ? n : 90000;
}

async function postAgent(pathname, payload, scopedToken, opts) {
  const { signal } = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agentTimeoutMs());
  // 外部 signal（客户端断开）也触发 abort
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); return { ok: false, status: 0, data: { error: 'aborted' } }; }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(`${agentBaseUrl()}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scoped-Token': scopedToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/** 探测 ai-agent 健康（供状态页/指示灯；短超时，不阻塞对话） */
async function probeAgentHealth() {
  const url = agentBaseUrl();
  const enabled = agentEnabled();
  if (!enabled) {
    return {
      enabled: false,
      reachable: false,
      mode: 'knowledge_only',
      url,
      hint: 'AI_AGENT_ENABLED=false，仅使用本地知识问答（Skill/查数不可用）',
      checkedAt: new Date().toISOString(),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    const reachable = res.ok && data.ok === true;
    return {
      enabled: true,
      reachable,
      mode: reachable ? 'agent' : 'degraded',
      url,
      service: data.service || null,
      hint: reachable
        ? 'Agent 已连接，可使用 Skill、报表查询等能力'
        : 'Agent 不可达，将降级为本地知识问答（Skill/查数不可用）',
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      enabled: true,
      reachable: false,
      mode: 'degraded',
      url,
      error: err.message || String(err),
      hint: 'Agent 不可达，将降级为本地知识问答（Skill/查数不可用）',
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 校验 internal 回调的 scoped token，返回 { ok, user, payload } 或发送 401/403 */
function requireScopedToken(request, reply) {
  const raw =
    request.headers['x-scoped-token'] ||
    (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const result = verifyScopedToken(String(raw || ''));
  if (!result.ok) {
    reply.code(401).send({ error: 'scoped token 无效', code: 'AGENT_TOKEN_INVALID', detail: result.error });
    return null;
  }
  return { user: userFromScopedPayload(result.payload), payload: result.payload };
}

/** internal：按 routeKey 载入报表菜单并做角色门禁，返回 { ok, row } 或已 reply 错误 */
async function loadReportMenuForRoles(pool, reply, routeKey, userRoles) {
  let row;
  try {
    const rs = await pool
      .request()
      .input('rk', sql.NVarChar(64), routeKey)
      .query(`
        SELECT id, label, route_key, enabled, roles_json, menu_kind,
               query_template, filter_schema_json,
               COALESCE(column_name_mapping_json, N'{}') AS column_name_mapping_json
        FROM dbo.nav_menu_items WHERE route_key = @rk
      `);
    row = rs.recordset && rs.recordset[0];
  } catch (err) {
    reply.code(503).send({ error: '无法读取菜单配置', code: 'AGENT_MENU_LOAD_ERROR' });
    return null;
  }
  if (!row || !row.enabled) {
    reply.code(404).send({ error: '菜单不存在或未启用', code: 'AGENT_MENU_NOT_FOUND' });
    return null;
  }
  const roles = parseMenuRolesJson(row.roles_json || '[]');
  if (!canAccessMenu(userRoles, roles)) {
    reply.code(403).send({ error: '无权访问该报表', code: 'AGENT_FORBIDDEN' });
    return null;
  }
  if (String(row.menu_kind || '').toLowerCase() !== 'report') {
    reply.code(400).send({ error: '该菜单不是报表', code: 'AGENT_NOT_REPORT_MENU' });
    return null;
  }
  return row;
}

async function aiAgentRoutes(fastify) {
  // ===========================================================================
  // 公网入口（用户 JWT）
  // ===========================================================================

  /** 主对话入口：转发到 ai-agent，落历史，支持澄清/续聊 */
  fastify.post(
    '/ai/agent/chat',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const conversationId = String(body.conversationId || '').trim();
      if (!isValidConversationId(conversationId)) {
        return reply.code(400).send({ error: 'conversationId 不合法', code: 'AGENT_BAD_CONV_ID' });
      }

      const isResume = body.resume && typeof body.resume === 'object';
      const message = String(body.message || '').trim();
      if (!isResume && !message) {
        return reply.code(400).send({ error: '请提供 message', code: 'AGENT_EMPTY_MESSAGE' });
      }

      const agentKey = body.agentKey ? String(body.agentKey).trim().toLowerCase() : null;
      const userCode = String(request.user.username || '').trim();
      const displayName = String(request.user.displayName || userCode);
      const userRoles = getUserRolesFromRequest(request.user);
      const pool = await getPool();

      // 落历史：会话 + 用户消息
      try {
        await ensureConversation(pool, {
          conversationId,
          userCode,
          firstUserText: isResume ? '（继续对话）' : message,
        });
        if (!isResume) {
          await addMessage(pool, { conversationId, role: 'user', content: message });
        }
      } catch (err) {
        if (err.code === 'CONV_FORBIDDEN') {
          return reply.code(403).send({ error: '会话不属于当前用户', code: 'AGENT_CONV_FORBIDDEN' });
        }
        request.log.error({ err }, 'ai/agent/chat persist user msg');
      }

      // 组装上下文：历史 + skill 清单（按角色过滤=第 1 层权限）
      let history = [];
      try {
        const msgs = await getConversationMessages(pool, userCode, conversationId);
        history = (msgs || [])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-24)
          .map((m) => ({ role: m.role, content: m.content }));
      } catch {}

      // 组装 skill 清单与 Agent 专属指令（一次对话只查一次 agents 表；与 bot/定时报告共用）
      const { skills, agentPrompt } = await resolveAgentContext(pool, {
        agentKey,
        userRoles,
        log: request.log,
      });

      const scopedToken = signScopedToken({ userCode, displayName, roles: userRoles, conversationId });

      // 客户端断开检测：前端 abort 触发 socket close → 中止 Agent 转发
      const clientAbort = new AbortController();
      const onClose = () => clientAbort.abort();
      request.raw.on('close', onClose);

      // 调用 Agent；不可用时优雅降级到本地知识问答
      if (agentEnabled()) {
        try {
          const input = isResume
            ? { type: 'resume', field: String(body.resume.field || ''), value: body.resume.value }
            : { type: 'message', content: message };
          const { ok, data } = await postAgent(
            '/chat',
            {
              threadId: conversationId,
              input,
              messages: history,
              skills,
              user: { userCode, displayName, roles: userRoles },
              agentPrompt: agentPrompt || undefined,
              context: normalizeBiContext(body.context) || undefined,
              mode: normalizeMode(body.mode),
            },
            scopedToken,
            { signal: clientAbort.signal }
          );
          if (clientAbort.signal.aborted) {
            request.raw.removeListener('close', onClose);
            return reply.code(499).send({ error: 'client closed', code: 'CLIENT_CLOSED' });
          }
          if (ok && data && data.status) {
            const assistantText =
              data.status === 'need_clarification'
                ? String(data.clarification?.question || '请补充信息')
                : String(data.message || '');
            try {
              await addMessage(pool, {
                conversationId,
                role: 'assistant',
                content: assistantText,
                skillUsed: data.skillUsed || null,
                toolCalls: data.toolCalls || null,
                toolSteps: data.toolSteps || null,
              });
              await touchConversation(pool, conversationId);
            } catch (err) {
              request.log.error({ err }, 'ai/agent/chat persist assistant msg');
            }
            // Agent 若未返回 actions，用关键词规则兜底
            if (!Array.isArray(data.actions) || data.actions.length === 0) {
              data.actions = suggestNavActions(message);
            }
            return { conversationId, ...data };
          }
          // Agent 返回错误（如 checkpoint 历史损坏）：直接告知用户，不降级编造数据
          if (!ok && data?.detail && /INVALID_CHAT_HISTORY|tool_calls/.test(String(data.detail))) {
            const errMsg = '当前对话会话状态异常，请点击「+ 新对话」开始新会话后重试。';
            try { await addMessage(pool, { conversationId, role: 'assistant', content: errMsg }); } catch {}
            return { conversationId, status: 'final', message: errMsg };
          }
          request.log.warn({ status: data?.status, err: data?.error }, 'ai/agent unexpected response, falling back');
        } catch (err) {
          if (clientAbort.signal.aborted) {
            request.raw.removeListener('close', onClose);
            return reply.code(499).send({ error: 'client closed', code: 'CLIENT_CLOSED' });
          }
          request.log.warn({ err: err.message }, 'ai/agent unreachable, falling back to local knowledge chat');
        }
      }

      request.raw.removeListener('close', onClose);

      // ---- 降级：本地知识问答（保证 AI tab 在 Agent 不可用时仍能用）----
      const fallback = await localKnowledgeChat(history, message, request.user);
      if (!fallback.actions || fallback.actions.length === 0) {
        fallback.actions = suggestNavActions(message);
      }
      try {
        await addMessage(pool, { conversationId, role: 'assistant', content: fallback.message });
        await touchConversation(pool, conversationId);
      } catch {}
      return { conversationId, status: 'final', degraded: true, ...fallback };
    }
  );

  /**
   * 流式对话（SSE）：与 /ai/agent/chat 同一套逻辑（agentChatCore），但把过程事件实时推给前端：
   *   start → llm_start / delta / llm_end / tool_call / tool_result ... → final（data 与 /ai/agent/chat 返回体一致）
   * 出错为 error 事件。客户端断开会中止对 ai-agent 的转发，ai-agent 在下一次 LLM 调用前停止。
   */
  fastify.post(
    '/ai/agent/chat/stream',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const conversationId = String(body.conversationId || '').trim();
      if (!isValidConversationId(conversationId)) {
        return reply.code(400).send({ error: 'conversationId 不合法', code: 'AGENT_BAD_CONV_ID' });
      }
      const isResume = body.resume && typeof body.resume === 'object';
      const message = String(body.message || '').trim();
      if (!isResume && !message) {
        return reply.code(400).send({ error: '请提供 message', code: 'AGENT_EMPTY_MESSAGE' });
      }

      const userCode = String(request.user.username || '').trim();
      const displayName = String(request.user.displayName || userCode);

      // 接管响应：之后自行写 SSE。保留 CORS 等已设置的响应头（hijack 后 Fastify 不再自动附加）
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...reply.getHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 关闭 nginx 缓冲，否则事件会被攒到结束才出去
      });
      const send = (event) => {
        if (raw.writableEnded || raw.destroyed) return;
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // 客户端断开 → 中止转发
      const ac = new AbortController();
      raw.on('close', () => {
        if (!raw.writableFinished) ac.abort();
      });
      // 长耗时工具/LLM 期间定时发心跳，避免反向代理空闲超时切断连接
      const heartbeat = setInterval(() => {
        if (!raw.writableEnded && !raw.destroyed) raw.write(': ping\n\n');
      }, 15000);

      try {
        send({ type: 'start', conversationId });
        const result = await agentChatCore({
          userCode,
          displayName,
          conversationId,
          agentKey: body.agentKey ? String(body.agentKey).trim().toLowerCase() : null,
          message,
          resume: isResume ? body.resume : undefined,
          log: request.log,
          onEvent: send,
          signal: ac.signal,
          context: body.context,
          mode: body.mode,
        });
        if (result.status === 'cancelled') {
          // 客户端已走，无需再写
        } else if (result.error) {
          send({ type: 'error', message: result.error, code: result.code });
        } else {
          send({ type: 'final', data: result });
        }
      } catch (err) {
        request.log.error({ err }, 'ai/agent/chat/stream');
        send({ type: 'error', message: err.message || '对话失败' });
      } finally {
        clearInterval(heartbeat);
        if (!raw.writableEnded) raw.end();
      }
    }
  );

  /** 会话列表 */
  fastify.get(
    '/ai/agent/conversations',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const pool = await getPool();
      const userCode = String(request.user.username || '').trim();
      const items = await listConversations(pool, userCode);
      return { items };
    }
  );

  /** 会话消息（续聊时加载） */
  fastify.get(
    '/ai/agent/conversations/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const conversationId = String(request.params.id || '').trim();
      if (!isValidConversationId(conversationId)) {
        return reply.code(400).send({ error: 'conversationId 不合法', code: 'AGENT_BAD_CONV_ID' });
      }
      const pool = await getPool();
      const userCode = String(request.user.username || '').trim();
      const messages = await getConversationMessages(pool, userCode, conversationId);
      if (messages === null) {
        return reply.code(404).send({ error: '会话不存在', code: 'AGENT_CONV_NOT_FOUND' });
      }
      return { conversationId, messages };
    }
  );

  /** 删除会话 */
  fastify.delete(
    '/ai/agent/conversations/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const conversationId = String(request.params.id || '').trim();
      if (!isValidConversationId(conversationId)) {
        return reply.code(400).send({ error: 'conversationId 不合法', code: 'AGENT_BAD_CONV_ID' });
      }
      const pool = await getPool();
      const userCode = String(request.user.username || '').trim();
      const removed = await deleteConversation(pool, userCode, conversationId);
      return { success: removed };
    }
  );

  /** 当前用户可用的 skill（前端展示"AI 能做什么"） */
  fastify.get(
    '/ai/agent/skills',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const pool = await getPool();
      const userRoles = getUserRolesFromRequest(request.user);
      const skills = await listSkillsForRoles(pool, userRoles);
      return {
        items: skills.map((s) => ({
          name: s.name,
          description: s.description,
          producesDocument: s.producesDocument,
        })),
      };
    }
  );

  /** Agent 连接状态（前端指示灯） */
  fastify.get(
    '/ai/agent/status',
    { preHandler: [fastify.authenticate] },
    async () => probeAgentHealth()
  );

  // ===========================================================================
  // Internal Skill 回调（scoped token；由 ai-agent 容器调用）
  // ===========================================================================

  /** 只读报表查询 */
  fastify.post('/ai/agent/internal/run-report', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const routeKey = String(body.routeKey || '').trim().toLowerCase();
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    if (!routeKey) return reply.code(400).send({ error: '缺少 routeKey', code: 'AGENT_BAD_REQUEST' });

    const pool = await getPool();
    const userRoles = auth.user.roles;
    const row = await loadReportMenuForRoles(pool, reply, routeKey, userRoles);
    if (!row) return;

    const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
    if (!fs.ok) return reply.code(503).send({ error: fs.error, code: 'AGENT_SCHEMA_INVALID' });
    const mapParse = parseColumnNameMappingJson(row.column_name_mapping_json);
    const colMap = mapParse.ok ? mapParse.mapping : {};

    try {
      const template = normalizeTemplate(row.query_template || '');
      const templateKind = detectTemplateKind(template) || 'select';
      const result = await executeReportQuery(pool, {
        templateKind,
        sqlTemplate: row.query_template,
        schemaFields: fs.fields,
        params,
        sessionInject: buildReportSessionInject(auth.user),
        page: 1,
        pageSize: 50,
      });
      const mapped = applyColumnNameMapping(result, colMap);
      return {
        label: row.label,
        columns: mapped.columns || [],
        rows: mapped.rows || [],
        totalRowCount: mapped.totalRowCount || 0,
      };
    } catch (err) {
      request.log.error({ err, routeKey }, 'agent internal run-report');
      return reply.code(500).send({
        error: err.message || '查询失败',
        code: err.code || 'AGENT_QUERY_ERROR',
        detail: err.message,
      });
    }
  });

  /** 直接执行 Agent 生成的只读 SQL（SELECT only），并按 skill 做角色门禁 + 表白名单强制校验 */
  fastify.post('/ai/agent/internal/run-sql', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const rawSql = String(body.sql || '').trim();
    const skillName = String(body.skillName || '').trim().toLowerCase();
    if (!rawSql) return reply.code(400).send({ error: '缺少 sql', code: 'AGENT_BAD_REQUEST' });

    // 安全第一层：仅允许 SELECT / WITH / DECLARE / EXEC（EXEC 需 skill 白名单放行）
    const normalized = rawSql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const firstWord = (normalized.split(/\s+/)[0] || '').toUpperCase();
    const isExec = firstWord === 'EXEC' || firstWord === 'EXECUTE';
    const blocked = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'MERGE', 'GRANT', 'REVOKE'];
    if (blocked.includes(firstWord)) {
      return reply.code(403).send({ error: '仅允许 SELECT 查询', code: 'AGENT_SQL_WRITE_BLOCKED' });
    }
    // EXEC/EXECUTE 必须关联 skill（由 skill 白名单控制可执行的存储过程）
    if (isExec && !skillName) {
      return reply.code(403).send({ error: '执行存储过程必须关联 skill，且存储过程须在 skill 表白名单中', code: 'AGENT_SQL_WRITE_BLOCKED' });
    }

    const pool = await getPool();

    // 安全第二层：run_sql 必须挂在某个 skill 下；加载该 skill 做角色门禁，并按其白名单限定可引用的表。
    if (skillName) {
      let skill;
      try {
        skill = await getSkill(pool, skillName);
      } catch (err) {
        request.log.error({ err, skillName }, 'agent internal run-sql load skill');
        return reply.code(503).send({ error: '无法读取 skill 配置', code: 'AGENT_SKILL_LOAD_ERROR' });
      }
      if (!skill || !skill.enabled) {
        return reply.code(404).send({ error: 'skill 不存在或未启用', code: 'AGENT_SKILL_NOT_FOUND' });
      }
      if (!canUseSkill(auth.user.roles, skill.roles)) {
        return reply.code(403).send({ error: '无权使用该 skill', code: 'AGENT_FORBIDDEN' });
      }
      // 表白名单：skill 配置了 allowedTables 时强制校验 SQL 只能引用这些表（空=不限制）
      const check = checkSqlTablesAllowed(rawSql, skill.allowedTables);
      if (!check.ok) {
        return reply.code(403).send({
          error:
            `本 skill 仅允许查询这些表：${(skill.allowedTables || []).join(', ')}。` +
            `你的 SQL 引用了不被允许的表：${check.bad.join(', ')}。请改用允许的表，不要引入白名单外的表。`,
          code: 'AGENT_SQL_TABLE_NOT_ALLOWED',
          allowedTables: skill.allowedTables || [],
          blockedTables: check.bad,
        });
      }
    }

    try {
      const req = pool.request();
      req.timeout = 30000;

      // 流式读取：只保留前 N 行、其余只计数，避免大结果集整体进内存
      const out = await runSqlLimited(req, rawSql);
      return {
        columns: out.columns,
        rows: out.rows,
        totalRowCount: out.totalRowCount,
        truncated: out.truncated,
        totalCapped: out.totalCapped,
      };
    } catch (err) {
      request.log.error({ err }, 'agent internal run-sql');
      return reply.code(400).send({ error: err.message || 'SQL 执行失败', code: 'AGENT_SQL_ERROR' });
    }
  });

  /**
   * 执行 BI 命名查询（run_named_query 工具）：与看板卡片共用同一份定义与结果缓存，保证口径一致。
   * 门禁：按 scoped token 里的用户角色校验查询的 roles；参数只绑定定义里声明过的。
   */
  fastify.post('/ai/agent/internal/named-query', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const queryKey = String(body.queryKey || '').trim().toLowerCase();
    if (!queryKey) return reply.code(400).send({ error: '缺少 queryKey', code: 'AGENT_BAD_REQUEST' });
    const pool = await getPool();
    const query = await getBiQuery(pool, queryKey);
    if (!query || !query.enabled) {
      return reply.code(404).send({ error: `命名查询不存在或未启用：${queryKey}`, code: 'BI_NO_QUERY' });
    }
    if (!canUseBiQuery(auth.user.roles, query.roles)) {
      return reply.code(403).send({ error: '无权访问该数据', code: 'BI_FORBIDDEN' });
    }
    const n = Number(body.maxRows);
    const maxRows = Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : 200;
    try {
      const r = await runNamedQuery({ pool, query, params: body.params, roles: auth.user.roles });
      return {
        queryKey: query.queryKey,
        label: query.label,
        caliberNote: query.caliberNote,
        columns: r.columns,
        rows: r.rows.slice(0, maxRows),
        rowCount: r.rowCount,
        truncated: r.truncated || r.rows.length > maxRows,
        params: r.params,
        asOf: r.asOf,
        cached: r.cached,
      };
    } catch (err) {
      if (err instanceof BiParamError) return reply.code(400).send({ error: err.message, code: err.code });
      request.log.error({ err: err.message, queryKey }, 'agent internal named-query');
      return reply.code(500).send({ error: `查询执行失败：${err.message}`, code: 'BI_QUERY_FAILED' });
    }
  });

  /** 选项查找（用于实体消歧，如客户编码）：基于报表 filter 字段的 optionsSql */
  fastify.post('/ai/agent/internal/lookup-options', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const routeKey = String(body.routeKey || '').trim().toLowerCase();
    const fieldName = String(body.fieldName || '').trim().replace(/^@/, '');
    const keyword = String(body.keyword || '').trim().toLowerCase();
    if (!routeKey || !fieldName) {
      return reply.code(400).send({ error: '缺少 routeKey/fieldName', code: 'AGENT_BAD_REQUEST' });
    }

    const pool = await getPool();
    const row = await loadReportMenuForRoles(pool, reply, routeKey, auth.user.roles);
    if (!row) return;

    const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
    if (!fs.ok) return reply.code(503).send({ error: fs.error, code: 'AGENT_SCHEMA_INVALID' });
    const field = fs.fields.find((f) => f.name === fieldName);
    if (!field || !field.optionsSql) {
      return reply.code(404).send({ error: '该字段未配置 optionsSql', code: 'AGENT_FIELD_NOT_FOUND' });
    }

    try {
      const items = await loadFilterFieldOptionsItems(pool, field, buildReportSessionInject(auth.user));
      let options = items.map((it) => ({ value: it.code, label: it.name }));
      if (keyword) {
        options = options.filter((o) => String(o.label).toLowerCase().includes(keyword));
      }
      return { options: options.slice(0, 20), total: options.length };
    } catch (err) {
      request.log.error({ err, routeKey, fieldName }, 'agent internal lookup-options');
      return reply.code(500).send({ error: '选项查找失败', code: 'AGENT_OPTIONS_ERROR', detail: err.message });
    }
  });

  /** 知识检索（复用现有使用说明知识库） */
  fastify.post('/ai/agent/internal/knowledge-search', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const query = String(body.query || '').trim();
    const topK = Math.max(1, Math.min(10, Number(body.topK) || 5));
    if (!query) return reply.code(400).send({ error: '缺少 query', code: 'AGENT_BAD_REQUEST' });
    const chunks = retrieveRelevantChunks(query, topK).map((c) => ({
      title: c.title,
      body: c.body,
    }));
    return { chunks };
  });

  /**
   * 受控写入（单保存）：LLM 只传结构化 payload。
   * - target_kind='table'：按字段白名单参数化 INSERT；
   * - target_kind='action'：分发到 agent-actions.js 代码注册的业务动作（如返工单领料）。
   * 两种类型都落 ai_action_logs 审计。
   */
  fastify.post('/ai/agent/internal/save-record', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const entity = String(body.entity || '').trim().toLowerCase();
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const conversationId = auth.payload.cid || null;
    if (!entity) return reply.code(400).send({ error: '缺少 entity', code: 'AGENT_BAD_REQUEST' });

    const pool = await getPool();
    const target = await getWriteTarget(pool, entity);
    if (!target || !target.enabled) {
      return reply.code(404).send({ error: '写入目标不存在或未启用', code: 'AGENT_WRITE_TARGET_NOT_FOUND' });
    }
    if (!canAccessMenu(auth.user.roles, target.roles)) {
      await writeAuditLog(pool, {
        userCode: auth.user.username, conversationId, action: 'save_record',
        entity, payload, result: 'error', detail: 'forbidden',
      });
      return reply.code(403).send({ error: '无权写入该实体', code: 'AGENT_WRITE_FORBIDDEN' });
    }
    try {
      let inserted;
      if (target.targetKind === 'action') {
        const action = getAgentAction(target.targetTable);
        if (!action) {
          return reply.code(503).send({
            error: `动作「${target.targetTable}」未在代码注册表中（请检查 agent-actions.js）`,
            code: 'AGENT_ACTION_NOT_REGISTERED',
          });
        }
        inserted = await action.run({ user: auth.user, payload, log: request.log });
      } else {
        const { insertedRow } = await performWrite(pool, target, payload);
        inserted = insertedRow;
      }
      await writeAuditLog(pool, {
        userCode: auth.user.username, conversationId, action: 'save_record',
        entity, payload, result: 'ok',
        detail: `${target.targetKind === 'action' ? 'action:' : ''}${target.targetTable}`,
      });
      return { success: true, entity, inserted };
    } catch (err) {
      request.log.error({ err, entity }, 'agent internal save-record');
      await writeAuditLog(pool, {
        userCode: auth.user.username, conversationId, action: 'save_record',
        entity, payload, result: 'error', detail: err.message,
      });
      const code = err.code || 'AGENT_WRITE_ERROR';
      return reply.code(400).send({ error: '写入失败：' + err.message, code });
    }
  });

  /** Agent 产出文档落盘（base64），返回鉴权下载链接 */
  fastify.post('/ai/agent/internal/store-document', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const ext = String(body.ext || '').toLowerCase();
    const filename = String(body.filename || `document.${ext}`);
    const contentBase64 = String(body.contentBase64 || '');
    if (!ext || !contentBase64) {
      return reply.code(400).send({ error: '缺少 ext/contentBase64', code: 'AGENT_BAD_REQUEST' });
    }
    let bytes;
    try {
      bytes = Buffer.from(contentBase64, 'base64');
    } catch {
      return reply.code(400).send({ error: 'contentBase64 解析失败', code: 'AGENT_BAD_REQUEST' });
    }
    const maxBytes = Number(process.env.AI_DOC_MAX_BYTES || 10 * 1024 * 1024);
    if (bytes.length === 0 || bytes.length > maxBytes) {
      return reply.code(400).send({ error: '文档为空或过大', code: 'AGENT_DOC_SIZE' });
    }
    const pool = await getPool();
    try {
      const doc = await storeDocument(pool, {
        userCode: auth.user.username,
        conversationId: auth.payload.cid || null,
        filename,
        ext,
        bytes,
      });
      return { success: true, documentId: doc.id, filename: doc.filename, downloadUrl: `/ai/agent/documents/${doc.id}` };
    } catch (err) {
      request.log.error({ err }, 'agent internal store-document');
      return reply.code(400).send({ error: '保存文档失败：' + err.message, code: err.code || 'AGENT_DOC_ERROR' });
    }
  });

  /** Agent 按需读取 skill 文本资源（渐进式披露）；按用户角色做 skill 门禁 */
  fastify.post('/ai/agent/internal/skill-resource', async (request, reply) => {
    const auth = requireScopedToken(request, reply);
    if (!auth) return;
    const body = request.body || {};
    const skillName = String(body.skillName || '').trim().toLowerCase();
    const resourcePath = String(body.path || '').trim().replace(/^\/+/, '');
    if (!skillName || !resourcePath) {
      return reply.code(400).send({ error: '缺少 skillName/path', code: 'AGENT_BAD_REQUEST' });
    }
    const pool = await getPool();
    const skill = await getSkill(pool, skillName);
    if (!skill || !skill.enabled) {
      return reply.code(404).send({ error: 'skill 不存在或未启用', code: 'AGENT_SKILL_NOT_FOUND' });
    }
    if (!canUseSkill(auth.user.roles, skill.roles)) {
      return reply.code(403).send({ error: '无权使用该 skill', code: 'AGENT_FORBIDDEN' });
    }
    const res = skill.resources && skill.resources[resourcePath];
    if (!res || typeof res.content !== 'string') {
      const available = Object.keys(skill.resources || {});
      return reply.code(404).send({
        error: `资源不存在：${resourcePath}`,
        code: 'AGENT_RESOURCE_NOT_FOUND',
        available,
      });
    }
    return { skillName, path: resourcePath, content: res.content };
  });

  /** 鉴权下载（用户 JWT + 归属校验） */
  fastify.get(
    '/ai/agent/documents/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = String(request.params.id || '');
      const pool = await getPool();
      const userCode = String(request.user.username || '').trim();
      const doc = await getOwnedDocument(pool, userCode, id);
      if (!doc) return reply.code(404).send({ error: '文档不存在或无权访问', code: 'AGENT_DOC_NOT_FOUND' });
      try {
        const st = await fs.promises.stat(doc.diskPath);
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        return reply.code(404).send({ error: '文档文件丢失', code: 'AGENT_DOC_MISSING' });
      }
      const utf8Name = encodeURIComponent(doc.filename);
      return reply
        .header('Content-Type', doc.mime)
        .header('Content-Disposition', `attachment; filename="document.${doc.ext}"; filename*=UTF-8''${utf8Name}`)
        .send(fs.createReadStream(doc.diskPath));
    }
  );

  // ===========================================================================
  // Skill 管理（管理员）
  // ===========================================================================
  const {
    listAllSkills,
    validateSkillInput,
    upsertSkill,
    deleteSkill,
  } = require('../agent-skills');
  const { parseSkillPackage } = require('../skill-package');

  fastify.get(
    '/ai/agent/skills-admin',
    { preHandler: [fastify.requireAdmin] },
    async () => {
      const pool = await getPool();
      const items = await listAllSkills(pool);
      return { items };
    }
  );

  fastify.post(
    '/ai/agent/skills-admin',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const v = validateSkillInput(request.body || {});
      if (!v.ok) return reply.code(400).send({ error: v.error, code: 'SKILL_INVALID' });
      const pool = await getPool();
      try {
        const saved = await upsertSkill(pool, v.value);
        return { success: true, skill: saved };
      } catch (err) {
        request.log.error({ err }, 'skills-admin upsert');
        return reply.code(500).send({ error: '保存 skill 失败', code: 'SKILL_SAVE_ERROR', detail: err.message });
      }
    }
  );

  fastify.delete(
    '/ai/agent/skills-admin/:name',
    { preHandler: [fastify.requireAdmin] },
    async (request) => {
      const pool = await getPool();
      const removed = await deleteSkill(pool, request.params.name);
      return { success: removed };
    }
  );

  /**
   * 导入标准 Skill 压缩包（SKILL.md + references/ 等文本资源）。
   * - roles 不从包里读：新 skill 默认仅管理员；覆盖导入保留已配置的角色与启用状态。
   */
  fastify.post(
    '/ai/agent/skills-admin/import',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      let file;
      try {
        file = await request.file();
      } catch (err) {
        return reply.code(400).send({ error: '上传失败：' + err.message, code: 'SKILL_UPLOAD_ERROR' });
      }
      if (!file) {
        return reply.code(400).send({ error: '请上传 zip 文件', code: 'SKILL_NO_FILE' });
      }
      let buf;
      try {
        buf = await file.toBuffer();
      } catch {
        return reply.code(400).send({ error: 'zip 文件超出大小限制（5MB）', code: 'SKILL_ZIP_TOO_LARGE' });
      }

      const parsed = parseSkillPackage(buf);
      if (!parsed.ok) {
        return reply.code(400).send({ error: parsed.error, code: 'SKILL_PACKAGE_INVALID' });
      }

      const pool = await getPool();
      const existing = await getSkill(pool, parsed.value.name);
      const v = validateSkillInput({
        ...parsed.value,
        roles: existing ? existing.roles : [],
        enabled: existing ? existing.enabled : true,
      });
      if (!v.ok) return reply.code(400).send({ error: v.error, code: 'SKILL_INVALID' });

      try {
        const saved = await upsertSkill(pool, v.value);
        return {
          success: true,
          updated: !!existing,
          skill: {
            name: saved.name,
            description: saved.description,
            resourceCount: Object.keys(saved.resources || {}).length,
            roles: saved.roles,
          },
        };
      } catch (err) {
        request.log.error({ err }, 'skills-admin import');
        return reply.code(500).send({ error: '导入 skill 失败', code: 'SKILL_IMPORT_ERROR', detail: err.message });
      }
    }
  );

  // ===========================================================================
  // 写入目标管理（管理员）
  // ===========================================================================
  fastify.get(
    '/ai/agent/write-targets-admin',
    { preHandler: [fastify.requireAdmin] },
    async () => {
      const pool = await getPool();
      const items = await listWriteTargets(pool);
      return { items };
    }
  );

  /** 代码注册的 API 动作清单（供写入目标表单的动作下拉） */
  fastify.get(
    '/ai/agent/actions-admin',
    { preHandler: [fastify.requireAdmin] },
    async () => ({ items: listAgentActions() })
  );

  fastify.post(
    '/ai/agent/write-targets-admin',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const v = validateTargetInput(request.body || {});
      if (!v.ok) return reply.code(400).send({ error: v.error, code: 'WRITE_TARGET_INVALID' });
      const pool = await getPool();
      try {
        const saved = await upsertWriteTarget(pool, v.value);
        return { success: true, target: saved };
      } catch (err) {
        request.log.error({ err }, 'write-targets-admin upsert');
        return reply.code(500).send({ error: '保存写入目标失败', code: 'WRITE_TARGET_SAVE_ERROR', detail: err.message });
      }
    }
  );

  fastify.delete(
    '/ai/agent/write-targets-admin/:name',
    { preHandler: [fastify.requireAdmin] },
    async (request) => {
      const pool = await getPool();
      const removed = await deleteWriteTarget(pool, request.params.name);
      return { success: removed };
    }
  );
}

/** 降级：无 Agent 时用现有知识库 + LLM 直接问答 */
async function localKnowledgeChat(history, message, user) {
  try {
    const { buildHelpSystemPrompt } = require('../help-knowledge');
    const userRole = String(user?.role || 'operator');
    const lastUser = message || [...history].reverse().find((m) => m.role === 'user')?.content || '';
    const systemPrompt = buildHelpSystemPrompt(lastUser, userRole)
      + '\n\n【重要】你当前处于降级模式，无法访问数据库，不能执行任何SQL查询。如果用户询问具体的业务数据（如销售额、订单、库存等数字），请如实告知"当前无法查询数据库，请稍后重试或开启新对话"，严禁编造任何数据。';
    const sources = retrieveRelevantChunks(lastUser, 5).map((c) => c.title);
    const trimmed = message ? [...history, { role: 'user', content: message }] : history;
    const messages = [{ role: 'system', content: systemPrompt }, ...trimmed.slice(-24)];
    const result = await aiService.generateChat(messages, { maxTokens: 2048 });
    if (!result.success) {
      return { message: result.fallback || result.error || 'AI 暂不可用', sources: [] };
    }
    return { message: result.content, sources, provider: result.provider, model: result.model };
  } catch (err) {
    return { message: 'AI 暂不可用：' + (err.message || String(err)), sources: [] };
  }
}

module.exports = aiAgentRoutes;
