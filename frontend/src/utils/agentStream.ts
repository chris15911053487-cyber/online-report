/**
 * Agent 流式对话：SSE 客户端 + 实时步骤状态（纯函数 reducer，便于测试）。
 *
 * 事件（POST /ai/agent/chat/stream）：
 *   start → llm_start / delta / llm_end / tool_call / tool_result ... → final | error
 * 模式参考 ChrisAI agent.html：每个工具调用一行，运行中转圈，完成后显示 ✓/✕ 与耗时。
 */
import { apiFetch, apiUrl, authHeaders, type ApiError } from './api'

// ─── 事件 ────────────────────────────────────────────────────────────────────

export type AgentStreamEvent =
  | { type: 'start'; conversationId?: string }
  | { type: 'llm_start'; id: string; round?: number }
  | { type: 'delta'; text: string; llmId?: string }
  | {
      type: 'llm_end'
      id: string
      round?: number | null
      durationMs?: number
      toolCalls?: number
      inputTokens?: number
      outputTokens?: number
      /** 实际使用的模型名（快模型 / 主模型） */
      model?: string
      error?: string
    }
  | { type: 'tool_call'; id: string; tool: string; label?: string; args?: Record<string, unknown> }
  | {
      type: 'tool_result'
      id: string
      toolCallId?: string | null
      tool?: string
      ok?: boolean
      waiting?: boolean
      durationMs?: number
      preview?: string
    }
  | { type: 'final'; data: Record<string, unknown> }
  | { type: 'error'; message?: string; code?: string }

// ─── 实时状态 ─────────────────────────────────────────────────────────────────

export type LiveStepStatus = 'run' | 'ok' | 'error' | 'waiting'

export interface LiveStep {
  id: string
  kind: 'llm' | 'tool'
  label: string
  tool?: string
  args?: Record<string, unknown>
  round?: number
  status: LiveStepStatus
  startedAt: number
  durationMs?: number
  preview?: string
  toolCalls?: number
  inputTokens?: number
  outputTokens?: number
  /** llm：实际使用的模型名 */
  model?: string
  /** llm：这一轮模型输出的文本（工具调用前的旁白，或最终回答）；用于点开查看 */
  output?: string
  /** tool：发起这次调用的 llm 步骤 id，用于在模型行下列出它决定调用的工具 */
  parentId?: string
  /** tool：tool_call_id，用于结束后与 final.toolSteps 对齐 */
  toolCallId?: string
  /** tool：完整结果（结束后由 attachToolResults 补入；运行中只有 preview） */
  resultFull?: string
}

/** 单步输出文本的保留上限，避免超长回答撑大状态 */
const MAX_STEP_OUTPUT = 20000

export interface LiveState {
  startedAt: number
  steps: LiveStep[]
  /** 当前这次 LLM 调用已流出的文本（若该次调用以工具调用收尾，则会被丢弃） */
  text: string
  llmId?: string
}

export function emptyLive(now: number): LiveState {
  return { startedAt: now, steps: [], text: '' }
}

function updateStep(steps: LiveStep[], id: string, patch: Partial<LiveStep>): LiveStep[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s))
}

export function reduceLive(state: LiveState, ev: AgentStreamEvent, now: number): LiveState {
  switch (ev.type) {
    case 'llm_start': {
      const round = ev.round ?? state.steps.filter((s) => s.kind === 'llm').length + 1
      const step: LiveStep = {
        id: ev.id,
        kind: 'llm',
        label: `第 ${round} 轮 · 思考中`,
        round,
        status: 'run',
        startedAt: now,
      }
      return { ...state, steps: [...state.steps, step], text: '', llmId: ev.id }
    }
    case 'delta': {
      if (state.llmId && ev.llmId && ev.llmId !== state.llmId) return state
      const steps = state.llmId
        ? state.steps.map((s) =>
            s.id === state.llmId && s.kind === 'llm'
              ? {
                  ...s,
                  label: s.status === 'run' ? `第 ${s.round ?? '?'} 轮 · 生成中` : s.label,
                  output: ((s.output ?? '') + ev.text).slice(0, MAX_STEP_OUTPUT),
                }
              : s,
          )
        : state.steps
      return { ...state, steps, text: state.text + ev.text }
    }
    case 'llm_end': {
      const existing = state.steps.find((s) => s.id === ev.id)
      const round = existing?.round ?? ev.round ?? undefined
      const n = ev.toolCalls ?? 0
      const label = ev.error
        ? `第 ${round ?? '?'} 轮 · 模型调用失败`
        : n > 0
          ? `第 ${round ?? '?'} 轮 · 决定调用 ${n} 个工具`
          : `第 ${round ?? '?'} 轮 · 生成回答`
      return {
        ...state,
        steps: updateStep(state.steps, ev.id, {
          label,
          status: ev.error ? 'error' : 'ok',
          durationMs: ev.durationMs,
          toolCalls: n,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          model: ev.model,
          preview: ev.error,
        }),
        // 以工具调用收尾的那次输出只是过程旁白，丢弃，避免闪现后消失
        text: n > 0 ? '' : state.text,
      }
    }
    case 'tool_call': {
      const step: LiveStep = {
        id: ev.id,
        kind: 'tool',
        label: ev.label || ev.tool,
        tool: ev.tool,
        args: ev.args,
        parentId: state.llmId,
        status: 'run',
        startedAt: now,
      }
      return { ...state, steps: [...state.steps, step], text: '' }
    }
    case 'tool_result': {
      const status: LiveStepStatus = ev.waiting ? 'waiting' : ev.ok === false ? 'error' : 'ok'
      return {
        ...state,
        steps: updateStep(state.steps, ev.id, {
          status,
          durationMs: ev.durationMs,
          preview: ev.preview,
          toolCallId: ev.toolCallId ?? undefined,
        }),
      }
    }
    default:
      return state
  }
}

/** final.toolSteps 中与 attachToolResults 相关的字段 */
export interface FinalToolStep {
  id?: string | null
  args?: Record<string, unknown>
  resultFull?: string
  resultPreview?: string
}

/**
 * 一轮结束后，把 final.toolSteps 里的完整参数与完整结果并入实时步骤（按 tool_call_id 对齐），
 * 这样点开工具行能看到完整 SQL 和完整结果，而不只是流式事件里的 180 字预览。
 */
export function attachToolResults(live: LiveState, toolSteps: FinalToolStep[] | undefined): LiveState {
  if (!toolSteps || toolSteps.length === 0) return live
  const byId = new Map<string, FinalToolStep>()
  for (const t of toolSteps) if (t.id) byId.set(t.id, t)
  return {
    ...live,
    steps: live.steps.map((s) => {
      if (s.kind !== 'tool' || !s.toolCallId) return s
      const t = byId.get(s.toolCallId)
      if (!t) return s
      return { ...s, args: t.args ?? s.args, resultFull: t.resultFull ?? t.resultPreview ?? s.resultFull }
    }),
  }
}

// ─── 展示辅助 ─────────────────────────────────────────────────────────────────

/** 耗时文案：<1s 用毫秒，其余保留一位小数的秒，>=60s 用分秒 */
export function formatDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s - m * 60)
  return `${m}m${String(rest).padStart(2, '0')}s`
}

const ACTIONS_FENCE = '```suggested_actions'

/**
 * 流式展示时隐藏末尾的 suggested_actions 块（最终消息里服务端已剥离并转成按钮）。
 * 也处理围栏只流出一半（如 "``" / "```sugg"）的情况，避免闪现乱码。
 */
export function stripActionsBlock(text: string): string {
  const i = text.indexOf(ACTIONS_FENCE)
  if (i >= 0) return text.slice(0, i).trimEnd()
  for (let k = Math.min(text.length, ACTIONS_FENCE.length - 1); k >= 1; k--) {
    if (ACTIONS_FENCE.startsWith(text.slice(-k))) return text.slice(0, text.length - k)
  }
  return text
}

// ─── 整轮耗时汇总 ─────────────────────────────────────────────────────────────

/** 整轮耗时汇总（ai-agent 的 timings） */
export interface AgentTimings {
  totalMs: number
  /** 所有 LLM 调用耗时之和 */
  llmMs: number
  /** 工具执行与框架开销（并行工具按墙钟计） */
  otherMs: number
  llmCalls: number
  inputTokens?: number
  outputTokens?: number
}

export function parseTimings(v: unknown): AgentTimings | undefined {
  if (!v || typeof v !== 'object') return undefined
  const t = v as Record<string, unknown>
  if (typeof t.totalMs !== 'number') return undefined
  return {
    totalMs: t.totalMs,
    llmMs: Number(t.llmMs) || 0,
    otherMs: Number(t.otherMs) || 0,
    llmCalls: Number(t.llmCalls) || 0,
    inputTokens: typeof t.inputTokens === 'number' ? t.inputTokens : undefined,
    outputTokens: typeof t.outputTokens === 'number' ? t.outputTokens : undefined,
  }
}

/** 一行耗时拆解：共 X · 模型 Y（N 次调用）· 工具/其它 Z */
export function describeTimings(t: AgentTimings): string {
  const parts = [
    `共 ${formatDuration(t.totalMs)}`,
    `模型 ${formatDuration(t.llmMs)}（${t.llmCalls} 次调用）`,
    `工具/其它 ${formatDuration(t.otherMs)}`,
  ]
  if (t.inputTokens != null) parts.push(`输入 ${t.inputTokens} tokens`)
  return parts.join(' · ')
}

// ─── 节流喂入 ─────────────────────────────────────────────────────────────────

/**
 * 把事件折叠进 LiveState 并通知 UI。文本增量按动画帧节流（token 很密，逐个渲染 Markdown 会卡），
 * 其余事件（步骤开始/结束）立即刷新。
 */
export function createLiveFeed(onChange: (s: LiveState) => void) {
  let state = emptyLive(Date.now())
  let raf: number | null = null
  const hasRaf = typeof requestAnimationFrame === 'function'
  const flush = () => {
    raf = null
    onChange(state)
  }
  onChange(state)
  return {
    push(ev: AgentStreamEvent) {
      state = reduceLive(state, ev, Date.now())
      if (ev.type === 'delta' && hasRaf) {
        if (raf == null) raf = requestAnimationFrame(flush)
        return
      }
      if (raf != null && hasRaf) cancelAnimationFrame(raf)
      raf = null
      onChange(state)
    },
    stop() {
      if (raf != null && hasRaf) cancelAnimationFrame(raf)
      raf = null
    },
    /** 当前最新状态（含尚未被节流刷新到 UI 的增量）；用于结束后把过程固化到消息里 */
    getState(): LiveState {
      return state
    },
  }
}

// ─── SSE 客户端 ───────────────────────────────────────────────────────────────

function parseBlock(block: string): AgentStreamEvent | null {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return null
  try {
    return JSON.parse(dataLines.join('\n')) as AgentStreamEvent
  } catch {
    return null
  }
}

export interface StreamAgentOptions {
  signal?: AbortSignal
  onEvent?: (ev: AgentStreamEvent) => void
}

/**
 * 流式调用 Agent 对话，返回与 POST /ai/agent/chat 相同的最终结果。
 * - 中止（signal）会抛 AbortError，与 apiFetch 行为一致；
 * - 后端尚未提供流式接口（404）时自动退回非流式，保证前后端可以分别上线。
 */
export async function streamAgentChat(
  body: Record<string, unknown>,
  opts: StreamAgentOptions = {},
): Promise<Record<string, unknown>> {
  const { signal, onEvent } = opts
  const res = await fetch(apiUrl('/ai/agent/chat/stream'), {
    method: 'POST',
    headers: { ...authHeaders(), Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })

  if (res.status === 404 || res.status === 405) {
    return apiFetch('/ai/agent/chat', { method: 'POST', body: JSON.stringify(body), signal })
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    let data: Record<string, unknown>
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { error: text }
    }
    let line = String(data.error || data.message || `${res.status} ${res.statusText}`)
    if (data.code) line += ` [${String(data.code)}]`
    const err: ApiError = new Error(line.trim() || '请求失败')
    err.status = res.status
    err.data = data
    throw err
  }

  // 用对象承载结果：TS 不跟踪闭包内对 let 变量的赋值，直接用 let 会被收窄成 null
  const out: { final: Record<string, unknown> | null; failure: string | null } = { final: null, failure: null }
  const handle = (block: string) => {
    const ev = parseBlock(block)
    if (!ev) return
    if (ev.type === 'final') out.final = ev.data
    else if (ev.type === 'error') out.failure = ev.message || '对话失败'
    else onEvent?.(ev)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      handle(buf.slice(0, i))
      buf = buf.slice(i + 2)
    }
  }
  if (buf.trim()) handle(buf)

  if (out.failure) throw new Error(out.failure)
  if (!out.final) throw new Error('连接中断，未收到完整回复，请重试')
  return out.final
}
