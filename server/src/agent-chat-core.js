/**
 * agentChatCore：可复用的 AI Agent 对话核心逻辑。
 * 被 /ai/agent/chat 路由 和 bot webhook（钉钉等）共同调用。
 */
const { getPool, sql } = require('./db');
const { resolveUserRoles } = require('./roles');
const { signScopedToken } = require('./ai-scoped-token');
const { listSkillsForRoles } = require('./agent-skills');
const {
  isValidConversationId,
  ensureConversation,
  touchConversation,
  addMessage,
  getConversationMessages,
} = require('./ai-conversations');
const { retrieveRelevantChunks, suggestNavActions } = require('./help-knowledge');
const { aiService } = require('./ai');

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

async function postAgent(pathname, payload, scopedToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agentTimeoutMs());
  try {
    const res = await fetch(`${agentBaseUrl()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scoped-Token': scopedToken },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 核心对话入口。
 * @param {object} opts
 * @param {string} opts.userCode       - OUSR USER_CODE
 * @param {string} opts.displayName    - 显示名
 * @param {string} opts.conversationId - 会话 ID
 * @param {string} [opts.message]      - 用户消息（非 resume 时必填）
 * @param {object} [opts.resume]       - 恢复中断 {field, value}
 * @param {object} [opts.log]          - fastify logger（可选）
 * @returns {Promise<object>}          - { conversationId, status, message, ... }
 */
async function agentChatCore(opts) {
  const { userCode, displayName, conversationId, message, resume, log } = opts;
  if (!isValidConversationId(conversationId)) {
    return { error: 'conversationId 不合法', code: 'AGENT_BAD_CONV_ID' };
  }
  const isResume = resume && typeof resume === 'object';
  if (!isResume && !message) {
    return { error: '请提供 message', code: 'AGENT_EMPTY_MESSAGE' };
  }

  const pool = await getPool();
  const userRoles = await resolveUserRoles(pool, userCode);

  // 落历史
  try {
    await ensureConversation(pool, { conversationId, userCode, firstUserText: isResume ? '（继续对话）' : message });
    if (!isResume) {
      await addMessage(pool, { conversationId, role: 'user', content: message });
    }
  } catch (err) {
    if (err.code === 'CONV_FORBIDDEN') {
      return { error: '会话不属于当前用户', code: 'AGENT_CONV_FORBIDDEN' };
    }
    log?.error?.({ err }, 'agentChatCore persist user msg');
  }

  // 组装上下文
  let history = [];
  try {
    const msgs = await getConversationMessages(pool, userCode, conversationId);
    history = (msgs || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-24)
      .map((m) => ({ role: m.role, content: m.content }));
  } catch {}

  let skills = [];
  try {
    skills = (await listSkillsForRoles(pool, userRoles)).map((s) => ({
      name: s.name,
      description: s.description,
      bodyMd: s.bodyMd,
      producesDocument: s.producesDocument,
      allowedTables: s.allowedTables || [],
      resources: Object.entries(s.resources || {}).map(([p, r]) => ({
        path: p,
        size: Number(r?.size) || (typeof r?.content === 'string' ? r.content.length : 0),
      })),
    }));
  } catch {}

  const scopedToken = signScopedToken({ userCode, displayName, roles: userRoles, conversationId });

  // 调 Agent
  if (agentEnabled()) {
    try {
      const input = isResume
        ? { type: 'resume', field: String(resume.field || ''), value: resume.value }
        : { type: 'message', content: message };
      const { ok, data } = await postAgent(
        '/chat',
        { threadId: conversationId, input, messages: history, skills, user: { displayName, roles: userRoles } },
        scopedToken,
      );
      if (ok && data && data.status) {
        const assistantText = data.status === 'need_clarification'
          ? String(data.clarification?.question || '请补充信息')
          : String(data.message || '');
        try {
          await addMessage(pool, { conversationId, role: 'assistant', content: assistantText, skillUsed: data.skillUsed || null, toolCalls: data.toolCalls || null, toolSteps: data.toolSteps || null });
          await touchConversation(pool, conversationId);
        } catch (err) {
          log?.error?.({ err }, 'agentChatCore persist assistant msg');
        }
        if (!Array.isArray(data.actions) || data.actions.length === 0) {
          data.actions = suggestNavActions(message || '');
        }
        return { conversationId, ...data };
      }
      if (!ok && data?.detail && /INVALID_CHAT_HISTORY|tool_calls/.test(String(data.detail))) {
        const errMsg = '当前对话会话状态异常，请开始新会话后重试。';
        try { await addMessage(pool, { conversationId, role: 'assistant', content: errMsg }); } catch {}
        return { conversationId, status: 'final', message: errMsg };
      }
      log?.warn?.({ status: data?.status, err: data?.error }, 'agent unexpected response, falling back');
    } catch (err) {
      log?.warn?.({ err: err.message }, 'agent unreachable, falling back');
    }
  }

  // 降级：本地知识问答
  const fallback = await localKnowledgeChat(history, message, userRoles);
  if (!fallback.actions || fallback.actions.length === 0) {
    fallback.actions = suggestNavActions(message || '');
  }
  try {
    await addMessage(pool, { conversationId, role: 'assistant', content: fallback.message });
    await touchConversation(pool, conversationId);
  } catch {}
  return { conversationId, status: 'final', degraded: true, ...fallback };
}

async function localKnowledgeChat(history, message, userRoles) {
  try {
    const { buildHelpSystemPrompt } = require('./help-knowledge');
    const userRole = userRoles.includes('admin') ? 'admin' : 'operator';
    const lastUser = message || [...history].reverse().find((m) => m.role === 'user')?.content || '';
    const systemPrompt = buildHelpSystemPrompt(lastUser, userRole)
      + '\n\n【重要】你当前处于降级模式，无法访问数据库，不能执行任何SQL查询。如果用户询问具体的业务数据，请如实告知"当前无法查询数据库，请稍后重试"，严禁编造任何数据。';
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

module.exports = { agentChatCore };
