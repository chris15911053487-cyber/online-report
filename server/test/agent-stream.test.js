/**
 * 流式对话网关：agentChatCore(onEvent) 与 POST /ai/agent/chat/stream。
 * 用本地假 ai-agent（HTTP + SSE）+ 桩掉 db/会话存储，不依赖 SQL Server。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

// ---- 桩模块（必须在 require 被测模块之前注入）----
function stub(rel, exports) {
  const file = require.resolve(path.join('../src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const store = { messages: [], touched: 0 };
stub('db.js', { getPool: async () => ({}), sql: {} });
stub('roles.js', {
  resolveUserRoles: async () => ['operator'],
  getUserRolesFromRequest: () => ['operator'],
  canAccessMenu: () => true,
  parseMenuRolesJson: () => [],
  normalizeRoleKeys: (x) => x || [],
});
stub('ai-conversations.js', {
  isValidConversationId: (id) => /^[\w-]{3,64}$/.test(String(id || '')),
  ensureConversation: async () => {},
  touchConversation: async () => { store.touched += 1; },
  addMessage: async (_pool, m) => { store.messages.push(m); },
  getConversationMessages: async () => [],
  listConversations: async () => [],
  deleteConversation: async () => true,
});
stub('agent-context.js', { resolveAgentContext: async () => ({ skills: [], agentPrompt: '' }) });
stub('help-knowledge.js', {
  retrieveRelevantChunks: () => [],
  suggestNavActions: () => [],
  buildHelpSystemPrompt: () => 'sys',
});
stub('ai.js', { aiService: { generateChat: async () => ({ success: true, content: '降级回答', provider: 'x', model: 'y' }) } });
stub('ai-scoped-token.js', { signScopedToken: () => 'tok', verifyScopedToken: () => ({ ok: false }), userFromScopedPayload: () => ({}) });

const { agentChatCore, parseSseBlock } = require('../src/agent-chat-core');

// ---- 假 ai-agent ----
let behavior = null; // async (req, res) => void
let lastRequest = null;
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  lastRequest = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : {} };
  await behavior(req, res);
});
const sse = (res, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
const startSse = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.AI_AGENT_URL = `http://127.0.0.1:${fake.address().port}`;
});
test.after(() => fake.close());
test.beforeEach(() => {
  store.messages = [];
  store.touched = 0;
  lastRequest = null;
});

const base = { userCode: 'U1', displayName: '张三', conversationId: 'conv-1', message: '昨天销量' };

test('parseSseBlock：解析 data 行，忽略注释/非 JSON', () => {
  assert.deepEqual(parseSseBlock('data: {"type":"delta","text":"a"}'), { type: 'delta', text: 'a' });
  assert.equal(parseSseBlock(': keepalive'), null);
  assert.equal(parseSseBlock('data: not-json'), null);
  assert.deepEqual(parseSseBlock('event: x\ndata: {"a":1}'), { a: 1 });
});

test('流式：过程事件实时转发，final 落库并返回', async () => {
  behavior = async (req, res) => {
    startSse(res);
    sse(res, { type: 'llm_start', id: 'l1', round: 1 });
    res.write(': keepalive\n\n');
    sse(res, { type: 'tool_call', id: 'r1', tool: 'run_sql', label: '执行 SQL 查询', args: { sql_query: 'select 1' } });
    sse(res, { type: 'tool_result', id: 'r1', toolCallId: 'c1', tool: 'run_sql', ok: true, durationMs: 120, preview: 'ok' });
    sse(res, { type: 'delta', text: '结果' });
    sse(res, {
      type: 'final',
      data: {
        status: 'final', message: '结果如下', actions: [], skillUsed: 'sales', toolCalls: ['run_sql'],
        toolSteps: [{ id: 'c1', tool: 'run_sql', durationMs: 120 }], timings: { totalMs: 900 },
      },
    });
    res.end();
  };
  const events = [];
  const result = await agentChatCore({ ...base, onEvent: (e) => events.push(e) });
  assert.equal(lastRequest.url, '/chat/stream');
  assert.equal(lastRequest.headers['x-scoped-token'], 'tok');
  assert.equal(lastRequest.body.threadId, 'conv-1');
  assert.deepEqual(events.map((e) => e.type), ['llm_start', 'tool_call', 'tool_result', 'delta']);
  assert.equal(result.status, 'final');
  assert.equal(result.message, '结果如下');
  assert.equal(result.timings.totalMs, 900);
  const assistant = store.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.content, '结果如下');
  assert.equal(assistant.toolSteps[0].durationMs, 120);
  assert.equal(store.touched, 1);
});

test('流式：事件被拆成多个 TCP 分片也能正确解析', async () => {
  behavior = async (req, res) => {
    startSse(res);
    const payload = `data: ${JSON.stringify({ type: 'delta', text: '你好' })}\n\ndata: ${JSON.stringify({ type: 'final', data: { status: 'final', message: 'ok' } })}\n\n`;
    const buf = Buffer.from(payload);
    for (let i = 0; i < buf.length; i += 5) {
      res.write(buf.subarray(i, i + 5)); // 5 字节一片，会切在多字节汉字中间
      await new Promise((r) => setTimeout(r, 2));
    }
    res.end();
  };
  const events = [];
  const result = await agentChatCore({ ...base, onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ type: 'delta', text: '你好' }]);
  assert.equal(result.message, 'ok');
});

test('流式：不提供 onEvent 时仍走原 /chat（兼容机器人/定时报告）', async () => {
  behavior = async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'final', message: '非流式' }));
  };
  const result = await agentChatCore({ ...base });
  assert.equal(lastRequest.url, '/chat');
  assert.equal(result.message, '非流式');
});

test('流式：agent 报 INVALID_CHAT_HISTORY 给出友好提示，不降级编造', async () => {
  behavior = async (req, res) => {
    startSse(res);
    sse(res, { type: 'error', message: 'agent error', detail: 'INVALID_CHAT_HISTORY tool_calls' });
    res.end();
  };
  const result = await agentChatCore({ ...base, onEvent: () => {} });
  assert.equal(result.status, 'final');
  assert.match(result.message, /会话状态异常/);
  assert.equal(result.degraded, undefined);
});

test('流式：agent 其它错误 → 降级本地知识问答', async () => {
  behavior = async (req, res) => {
    startSse(res);
    sse(res, { type: 'error', message: '模型不可用', detail: '模型不可用' });
    res.end();
  };
  const result = await agentChatCore({ ...base, onEvent: () => {} });
  assert.equal(result.degraded, true);
  assert.equal(result.message, '降级回答');
});

test('流式：流中途断开且没有 final → 降级', async () => {
  behavior = async (req, res) => {
    startSse(res);
    sse(res, { type: 'llm_start', id: 'l1', round: 1 });
    res.end();
  };
  const result = await agentChatCore({ ...base, onEvent: () => {} });
  assert.equal(result.degraded, true);
});

test('流式：ai-agent 返回 cancelled → 不落库 assistant 消息', async () => {
  behavior = async (req, res) => {
    startSse(res);
    sse(res, { type: 'cancelled' });
    res.end();
  };
  const result = await agentChatCore({ ...base, onEvent: () => {} });
  assert.equal(result.status, 'cancelled');
  assert.equal(store.messages.filter((m) => m.role === 'assistant').length, 0);
});

test('流式：客户端中止 → 返回 cancelled，并断开到 ai-agent 的连接', async () => {
  let agentSawClose;
  const closed = new Promise((r) => { agentSawClose = r; });
  behavior = async (req, res) => {
    startSse(res);
    sse(res, { type: 'llm_start', id: 'l1', round: 1 });
    res.on('close', agentSawClose);
    // 不结束，模拟长耗时
  };
  const ac = new AbortController();
  const events = [];
  const p = agentChatCore({
    ...base,
    signal: ac.signal,
    onEvent: (e) => { events.push(e); ac.abort(); },
  });
  const result = await p;
  assert.equal(result.status, 'cancelled');
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('ai-agent 未感知到断开')), 2000))]);
  assert.equal(store.messages.filter((m) => m.role === 'assistant').length, 0);
});

test('流式：ai-agent 不可达 → 降级', async () => {
  const saved = process.env.AI_AGENT_URL;
  process.env.AI_AGENT_URL = 'http://127.0.0.1:1';
  try {
    const result = await agentChatCore({ ...base, onEvent: () => {} });
    assert.equal(result.degraded, true);
  } finally {
    process.env.AI_AGENT_URL = saved;
  }
});

// ---- 路由：真实 fastify + 假鉴权 ----
test('POST /ai/agent/chat/stream：SSE 头、事件顺序、final；无 message 返回 400', async () => {
  const Fastify = require('fastify');
  const cors = require('@fastify/cors');
  const app = Fastify();
  await app.register(cors, { origin: true });
  app.decorate('authenticate', async (request) => { request.user = { username: 'U1', displayName: '张三' }; });
  app.decorate('requireAdmin', async () => {});
  await app.register(require('../src/routes/ai-agent'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server.address().port}/ai/agent/chat/stream`;

  try {
    behavior = async (req, res) => {
      startSse(res);
      sse(res, { type: 'tool_call', id: 'r1', tool: 'run_sql', label: '执行 SQL 查询', args: {} });
      sse(res, { type: 'final', data: { status: 'final', message: '好了', toolSteps: [], timings: { totalMs: 10 } } });
      res.end();
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify({ conversationId: 'conv-2', message: '你好' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.ok(res.headers.get('access-control-allow-origin'), 'hijack 后仍应带 CORS 头');
    const text = await res.text();
    const events = text.split('\n\n').map(parseSseBlock).filter(Boolean);
    assert.deepEqual(events.map((e) => e.type), ['start', 'tool_call', 'final']);
    assert.equal(events[0].conversationId, 'conv-2');
    assert.equal(events[2].data.message, '好了');
    assert.equal(events[2].data.conversationId, 'conv-2');
    assert.equal(store.messages.find((m) => m.role === 'assistant').content, '好了');

    const bad = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-2', message: '  ' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'AGENT_EMPTY_MESSAGE');

    const badId = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: '!!', message: 'x' }),
    });
    assert.equal(badId.status, 400);
  } finally {
    await app.close();
  }
});
