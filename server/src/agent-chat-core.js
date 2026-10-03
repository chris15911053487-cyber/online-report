/**
 * agentChatCore：可复用的 AI Agent 对话核心逻辑。
 * 被 /ai/agent/chat 路由 和 bot webhook（钉钉等）共同调用。
 */
const { getPool, sql } = require('./db');
const { resolveUserRoles } = require('./roles');
const { signScopedToken } = require('./ai-scoped-token');
const { resolveAgentContext } = require('./agent-context');
const {
  isValidConversationId,
  ensureConversation,
  touchConversation,
  addMessage,
  getConversationMessages,
} = require('./ai-conversations');
const { retrieveRelevantChunks, suggestNavActions } = require('./help-knowledge');
const { aiService } = require('./ai');
const { normalizeBiContext, normalizeMode } = require('./bi-context');

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

/** 流式整轮的总超时：用户能实时看到进度，比一次性等待可以更宽松 */
function agentStreamTimeoutMs() {
  const n = Number(process.env.AI_AGENT_STREAM_TIMEOUT_MS || 180000);
  return Number.isFinite(n) && n > 0 ? n : 180000;
}

/** 把外部 signal（如客户端断开）与超时合并到一个 AbortController；返回 { controller, cleanup } */
function linkedAbort(timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    controller,
    cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function postAgent(pathname, payload, scopedToken, opts) {
  const { controller, cleanup } = linkedAbort(agentTimeoutMs(), opts?.signal);
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
    cleanup();
  }
}

/** 解析一个 SSE 块（可含多行 data:），返回事件对象；注释/心跳/非 JSON 返回 null */
function parseSseBlock(block) {
  const dataLines = [];
  for (const line of String(block).split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try { return JSON.parse(dataLines.join('\n')); } catch { return null; }
}

/**
 * 调用 ai-agent 的 SSE 接口。过程事件经 onEvent 实时回调，最终返回与 postAgent 同形的 { ok, status, data }：
 * - 收到 final → { ok: true, data: final.data }
 * - 收到 error → { ok: false, data: { error, detail } }
 * - 收到 cancelled → { ok: false, cancelled: true }
 * 连接失败或流中途断开（没有 final）会抛错，由调用方走降级。
 */
async function postAgentStream(pathname, payload, scopedToken, opts = {}) {
  const { signal, onEvent } = opts;
  const { controller, cleanup } = linkedAbort(agentStreamTimeoutMs(), signal);
  try {
    const res = await fetch(`${agentBaseUrl()}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Scoped-Token': scopedToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      return { ok: false, status: res.status, data };
    }
    let result = null;
    const handle = (block) => {
      const ev = parseSseBlock(block);
      if (!ev) return;
      if (ev.type === 'final') result = { ok: true, status: 200, data: ev.data };
      else if (ev.type === 'error') result = { ok: false, status: 500, data: { error: ev.message, detail: ev.detail || ev.message } };
      else if (ev.type === 'cancelled') result = { ok: false, status: 499, cancelled: true, data: {} };
      else if (onEvent) {
        try { onEvent(ev); } catch { /* 下游写出失败不应中断取数 */ }
      }
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    if (buf.trim()) handle(buf);
    if (!result) throw new Error('agent stream ended without final event');
    return result;
  } finally {
    cleanup();
  }
}

/**
 * 核心对话入口。
 * @param {object} opts
 * @param {string} opts.userCode       - OUSR USER_CODE
 * @param {string} opts.displayName    - 显示名
 * @param {string} opts.conversationId - 会话 ID
 * @param {string} [opts.agentKey]     - 可选：指定 Agent（过滤关联 skill，注入附加指令）
 * @param {string} [opts.message]      - 用户消息（非 resume 时必填）
 * @param {object} [opts.resume]       - 恢复中断 {field, value}
 * @param {object} [opts.log]          - fastify logger（可选）
 * @param {(event:object)=>void} [opts.onEvent] - 提供后走流式：过程事件（llm_start/delta/tool_call/tool_result…）实时回调
 * @param {AbortSignal} [opts.signal]  - 外部中止信号（如客户端断开）；中止后返回 { status: 'cancelled' }
 * @param {object} [opts.context]      - 看板点击上下文（见 bi-context.js），注入本轮用户消息
 * @param {string} [opts.mode]         - 'fast' = 用快模型（点击解读）
 * @returns {Promise<object>}          - { conversationId, status, message, ... }
 */
async function agentChatCore(opts) {
  const { userCode, displayName, conversationId, agentKey, message, resume, log, onEvent, signal } = opts;
  const context = normalizeBiContext(opts.context);
  const mode = normalizeMode(opts.mode);
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

  const { skills, agentPrompt } = await resolveAgentContext(pool, { agentKey, userRoles, log });

  const scopedToken = signScopedToken({ userCode, displayName, roles: userRoles, conversationId });

  // 调 Agent
  if (agentEnabled()) {
    try {
      const input = isResume
        ? { type: 'resume', field: String(resume.field || ''), value: resume.value }
        : { type: 'message', content: message };
      const agentPayload = {
        threadId: conversationId,
        input,
        messages: history,
        skills,
        user: { userCode, displayName, roles: userRoles },
        agentPrompt: agentPrompt || undefined,
        context: context || undefined,
        mode,
      };
      const { ok, data, cancelled } = onEvent
        ? await postAgentStream('/chat/stream', agentPayload, scopedToken, { signal, onEvent })
        : await postAgent('/chat', agentPayload, scopedToken, { signal });
      if (cancelled) return { conversationId, status: 'cancelled' };
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
      if (signal?.aborted) return { conversationId, status: 'cancelled' };
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

module.exports = { agentChatCore, postAgentStream, parseSseBlock };
