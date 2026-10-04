/**
 * AgentRunView — 对齐 HTML 原型的 Agent 运行页
 *
 * 移动端（< 900px）：
 *   - 主页面 = 画布区（数据卡直出，不藏在聊天气泡里）
 *   - 右下角 FAB（脉冲光晕）→ 点击弹底部抽屉（圆角 + backdrop blur）
 *   - 抽屉：快捷 chip + 输入框，发送后抽屉收起，结果展示在主页面
 *   - 进入即展示默认内容（defaultEnabled = true 时自动发第一轮）
 *
 * PC 端（≥ 900px）：
 *   - 左栏 420px：对话流 + 输入栏（可收起，宽度过渡到 0）
 *   - 右栏 flex-1：画布输出区（4 列 KPI、大图表、无横滚动表格）
 *   - 左栏折叠时右栏全屏，左上角展开按钮
 *
 * 关联了 BI 看板（agent.dashboardKey）时：
 *   - 进入即显示看板（读缓存，秒开），不再自动执行 defaultPrompt
 *   - PC 右栏为「看板 / 当前结果」两个页签，回答出来后自动切到「当前结果」
 *   - 移动端顶部为「看板 / 对话」页签，提问后自动切到「对话」
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot, Plus, ChevronRight, Loader2, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { useStore } from '../store'
import { tv } from '../theme'
import { useIsPc } from '../hooks/useMediaQuery'
import { apiFetch } from '../utils/api'
import { attachToolResults, createLiveFeed, streamAgentChat, type LiveState } from '../utils/agentStream'
import ChartRenderer from '../components/ChartRenderer'
import AgentLiveTrace, { AgentLiveStatus } from '../components/AgentLiveTrace'
import PinToDashboard from '../components/bi/PinToDashboard'
import AgentTracePanel, { parseAgentTrace, type AgentTimings, type AgentToolStep } from '../components/AgentTracePanel'
import ChatMarkdown from '../components/ChatMarkdown'
import DashboardPanel from '../components/bi/DashboardPanel'
import BiPickPopover from '../components/bi/BiPickPopover'
import { buildBiContext, explainPrompt, toWireContext, type BiContextPayload, type BiPick } from '../utils/biContext'
import type { BiDashboard, BiFilterValues } from '../utils/bi'
import type { Agent, AgentQuickPrompt } from '../types'

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface MetricItem {
  label: string
  value: string | number
  delta?: string
  deltaUp?: boolean
}

interface TableRow { [col: string]: string | number }

interface TableData {
  columns: string[]
  rows: TableRow[]
}

interface CanvasData {
  intent?: string
  metrics?: MetricItem[]
  table?: TableData
  insight?: string
}

interface CanvasTurn {
  id: string
  query: string
  intent?: string
  canvas: CanvasData
  charts: Record<string, unknown>[]
  message: string
  toolSteps?: AgentToolStep[]
  timings?: AgentTimings
  timestamp: number
}

interface ClarificationData {
  type?: string
  field: string
  question: string
  options: { value: string | number; label: string }[]
  entity?: string
  payload?: Record<string, unknown>
}

interface ChatItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  turnRef?: string
  clarification?: ClarificationData
  clarificationResolved?: boolean
  loading?: boolean
  /** 用户消息带的看板上下文（显示为气泡上方的小胶囊） */
  contextCaption?: string
  /** 本轮执行过程快照（每步耗时）；完成后仍保留在对话里 */
  trace?: LiveState
  timings?: AgentTimings
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function newConvId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch { /* ignore */ }
  return 'ag-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function extractCharts(steps?: AgentToolStep[]): Record<string, unknown>[] {
  if (!steps) return []
  const out: Record<string, unknown>[] = []
  for (const s of steps) {
    if (s.tool !== 'generate_chart') continue
    const raw = s.resultFull || s.resultPreview || ''
    try {
      const d = JSON.parse(raw)
      if (d?.success && d.chart) out.push(d.chart as Record<string, unknown>)
    } catch { /* ignore */ }
  }
  return out
}

/** 一轮结束后固化执行过程：并入 final.toolSteps 的完整 SQL 与完整结果，点开工具行即可查看 */
function finishTrace(live: LiveState | null, data: Record<string, unknown>): LiveState | undefined {
  if (!live) return undefined
  return attachToolResults(live, parseAgentTrace(data).toolSteps)
}

function extractCanvas(text: string): { cleaned: string; canvas: CanvasData } {
  const re = /```canvas\s*\n([\s\S]*?)\n```/m
  const m = re.exec(text)
  if (!m) return { cleaned: text, canvas: {} }
  const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()
  try {
    return { cleaned, canvas: JSON.parse(m[1].trim()) as CanvasData }
  } catch {
    return { cleaned, canvas: {} }
  }
}

const INTENT_CFG: Record<string, { text: string; bg: string; color: string }> = {
  report:  { text: '预置报表', bg: tv('info-soft'), color: tv('info') },
  explore: { text: '探索分析', bg: tv('warning-soft'), color: tv('warning') },
  insight: { text: '趋势洞察', bg: tv('accent-soft'), color: tv('accent') },
  explain: { text: '智能解答', bg: tv('success-soft'), color: tv('success') },
}

// ─── 子组件 ───────────────────────────────────────────────────────────────────

function IntentBadge({ intent }: { intent?: string }) {
  if (!intent) return null
  const cfg = INTENT_CFG[intent]
  if (!cfg) return null
  return (
    <span
      className="text-[10.5px] font-medium px-2 py-0.5 rounded-md flex-shrink-0"
      style={{ background: cfg.bg, color: cfg.color }}
    >
      {cfg.text}
    </span>
  )
}

/** KPI 指标卡网格，PC 端 4 列 */
function MetricsGrid({ metrics, pcMode }: { metrics: MetricItem[]; pcMode?: boolean }) {
  return (
    <div className={`grid gap-2.5 ${pcMode ? 'grid-cols-4' : 'grid-cols-2'}`}>
      {metrics.map((m, i) => (
        <div
          key={i}
          className="rounded-xl p-3 border"
          style={{ background: tv('surface-2'), borderColor: tv('surface-2') }}
        >
          <div className="text-[11.5px]" style={{ color: tv('subtle') }}>{m.label}</div>
          <div
            className="font-bold mt-1 leading-tight"
            style={{ fontSize: pcMode ? 22 : 19, color: tv('fg'), letterSpacing: '-0.3px' }}
          >
            {m.value}
          </div>
          {m.delta && (
            <div
              className="text-[11.5px] mt-1 font-medium"
              style={{ color: m.deltaUp ? tv('success') : tv('danger') }}
            >
              {m.delta}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** 数据表格，数字列右对齐，降幅用红色胶囊 */
function DataTable({ table, pcMode }: { table: TableData; pcMode?: boolean }) {
  const isNumeric = (v: string | number) =>
    typeof v === 'number' || /^[¥$\-\d]/.test(String(v ?? ''))
  const isDown = (v: string | number) => {
    const s = String(v ?? '')
    return (s.includes('-') || s.includes('↓')) && /\d/.test(s)
  }

  return (
    <div
      className={pcMode ? 'overflow-x-visible' : 'overflow-x-auto -mx-4 px-4'}
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      <table
        className="border-collapse"
        style={{
          width: '100%',
          fontSize: 12.5,
          minWidth: pcMode ? 'auto' : 480,
        }}
      >
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th
                key={i}
                style={{
                  padding: '9px 10px',
                  fontWeight: 500,
                  color: tv('subtle'),
                  fontSize: 11.5,
                  borderBottom: '1px solid rgb(var(--c-surface-2))',
                  whiteSpace: 'nowrap',
                  textAlign: i > 0 ? 'right' : 'left',
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: '1px solid rgb(var(--c-bg))' }}>
              {table.columns.map((c, ci) => {
                const val = row[c] ?? ''
                const right = ci > 0 && isNumeric(val)
                const down = ci > 0 && isDown(val)
                return (
                  <td
                    key={ci}
                    style={{
                      padding: '10px',
                      color: tv('fg'),
                      whiteSpace: 'nowrap',
                      textAlign: right ? 'right' : 'left',
                      fontVariantNumeric: right ? 'tabular-nums' : undefined,
                    }}
                  >
                    {down ? (
                      <span
                        className="inline-block text-[10.5px] px-1.5 py-0.5 rounded"
                        style={{ background: tv('danger-soft'), color: tv('danger'), fontWeight: 500 }}
                      >
                        {String(val)}
                      </span>
                    ) : (
                      String(val)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** fadeUp 动画包装 */
function FadeUp({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <div
      style={{
        animation: `agentFadeUp 0.35s ease both`,
        animationDelay: `${delay}ms`,
      }}
    >
      {children}
    </div>
  )
}

/** 单张分析卡片 */
function CanvasCard({
  title,
  badge,
  children,
  delay = 0,
}: {
  title?: string
  badge?: string
  children: React.ReactNode
  delay?: number
}) {
  return (
    <FadeUp delay={delay}>
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: tv('surface'),
          border: '1px solid rgb(var(--c-surface-2))',
          boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        }}
      >
        {title && (
          <div
            className="flex items-center justify-between px-4 pt-3.5 pb-2.5"
            style={{ borderBottom: '1px solid rgb(var(--c-bg))' }}
          >
            <span className="text-[13px] font-semibold" style={{ color: tv('fg') }}>
              {title}
            </span>
            {badge && <IntentBadge intent={badge} />}
          </div>
        )}
        <div className="px-4 pt-3 pb-4">{children}</div>
      </div>
    </FadeUp>
  )
}

/** 主画布渲染区 */
function CanvasPanel({
  turn,
  loading,
  query,
  pcMode,
  live,
}: {
  turn: CanvasTurn | null
  loading: boolean
  query?: string
  pcMode?: boolean
  /** 流式进行中的实时步骤（有则替代骨架屏） */
  live?: LiveState | null
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {/* 「正在分析…」header，与原型一致 */}
        <FadeUp>
          <div
            className="flex items-center gap-2 px-4 py-3 rounded-xl text-[13px] font-medium"
            style={{
              background: 'linear-gradient(135deg,rgb(var(--c-primary-soft)),rgb(var(--c-accent-soft)))',
              color: tv('primary'),
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }}
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            正在分析「{query || '…'}」…
          </div>
        </FadeUp>
        {/* 实时执行过程（每步耗时）；流式不可用时退回骨架屏 */}
        {live ? (
          <AgentLiveTrace live={live} />
        ) : (
          [0, 1].map((i) => (
            <div
              key={i}
              className="h-36 rounded-2xl animate-pulse"
              style={{ background: tv('surface-2'), animationDelay: `${i * 150}ms` }}
            />
          ))
        )}
      </div>
    )
  }

  if (!turn) return null

  const { canvas, charts, message, toolSteps, timings, intent, query: q } = turn
  const hasAny = (canvas.metrics?.length ?? 0) > 0 || charts.length > 0 || canvas.table || canvas.insight || message

  if (!hasAny) return null

  const cardIntent = intent ?? canvas.intent

  return (
    <div className="space-y-3">
      {/* 指标卡 */}
      {canvas.metrics && canvas.metrics.length > 0 && (
        <CanvasCard title={q} badge={cardIntent} delay={0}>
          <MetricsGrid metrics={canvas.metrics} pcMode={pcMode} />
        </CanvasCard>
      )}

      {/* 图表 */}
      {charts.map((opt, i) => (
        <CanvasCard key={i} delay={i * 80 + 50}>
          <div style={{ height: pcMode ? 260 : 220 }}>
            <ChartRenderer option={opt} />
          </div>
          {canvas.insight && i === charts.length - 1 && (
            <div
              className="mt-3 text-[12.5px] leading-relaxed rounded-r-lg py-2.5 px-3.5"
              style={{
                borderLeft: '3px solid rgb(var(--c-primary))',
                background: tv('surface-2'),
                color: tv('fg-2'),
              }}
            >
              <strong style={{ color: tv('fg') }}>AI 洞察：</strong>
              {canvas.insight}
            </div>
          )}
        </CanvasCard>
      ))}

      {/* 无图表但有 insight */}
      {charts.length === 0 && canvas.insight && (
        <CanvasCard delay={100}>
          <div
            className="text-[12.5px] leading-relaxed rounded-r-lg py-2.5 px-3.5"
            style={{
              borderLeft: '3px solid rgb(var(--c-primary))',
              background: tv('surface-2'),
              color: tv('fg-2'),
            }}
          >
            <strong style={{ color: tv('fg') }}>AI 洞察：</strong>
            {canvas.insight}
          </div>
        </CanvasCard>
      )}

      {/* 数据表 */}
      {canvas.table && (
        <CanvasCard title="数据明细" delay={120}>
          <DataTable table={canvas.table} pcMode={pcMode} />
        </CanvasCard>
      )}

      {/* 叙述文字 */}
      {message && (
        <CanvasCard delay={140}>
          <div className="text-[13px] leading-relaxed" style={{ color: tv('fg-2') }}>
            <ChatMarkdown content={message} />
          </div>
          {((toolSteps && toolSteps.length > 0) || timings) && (
            <div className="mt-3">
              <AgentTracePanel toolSteps={toolSteps} timings={timings} />
            </div>
          )}
          <PinToDashboard steps={toolSteps} question={q} />
        </CanvasCard>
      )}
    </div>
  )
}

/** PC 右栏页签按钮 */
function RightTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="flex items-center gap-1.5 px-3.5 py-2 text-[13px] rounded-t-lg -mb-px transition-colors"
      style={
        active
          ? { background: tv('surface'), color: tv('fg'), fontWeight: 600, border: '1px solid rgb(var(--c-line))', borderBottomColor: tv('surface') }
          : { color: tv('muted'), border: '1px solid transparent' }
      }
    >
      {children}
    </button>
  )
}

/** 历史轮切换 chip */
function TurnChip({
  turn, isCurrent, onClick,
}: { turn: CanvasTurn; isCurrent: boolean; onClick: () => void }) {
  const cfg = INTENT_CFG[turn.intent ?? turn.canvas.intent ?? '']
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[12px] border transition-colors flex-shrink-0"
      style={
        isCurrent
          ? { borderColor: tv('primary'), background: tv('primary-soft'), color: tv('primary') }
          : { borderColor: tv('line'), background: tv('surface'), color: tv('fg-2') }
      }
    >
      <span className="truncate max-w-[100px]">{turn.query}</span>
      {cfg && (
        <span
          className="text-[10px] px-1 py-0.5 rounded flex-shrink-0"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {cfg.text}
        </span>
      )}
      {isCurrent && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tv('primary') }} />
      )}
    </button>
  )
}

/** 「你可能还想问」建议 chips */
function Suggestions({
  items, onSend,
}: { items: string[]; onSend: (t: string) => void }) {
  if (items.length === 0) return null
  return (
    <FadeUp delay={200}>
      <div className="space-y-1.5">
        <div
          className="flex items-center gap-1 text-[11.5px] pl-0.5"
          style={{ color: tv('subtle') }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12 }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          你可能还想问
        </div>
        {items.map((text, i) => (
          <button
            key={i}
            onClick={() => onSend(text)}
            className="w-full flex items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13px] transition-all border"
            style={{ background: tv('surface'), borderColor: tv('line'), color: tv('fg-2') }}
            onMouseEnter={e => {
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = tv('primary')
              ;(e.currentTarget as HTMLButtonElement).style.color = tv('primary')
            }}
            onMouseLeave={e => {
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = tv('line')
              ;(e.currentTarget as HTMLButtonElement).style.color = tv('fg-2')
            }}
          >
            <span>{text}</span>
            <span style={{ color: tv('line-strong'), flexShrink: 0 }}>›</span>
          </button>
        ))}
      </div>
    </FadeUp>
  )
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export default function AgentRunView() {
  // PC 双栏 / 手机单栏：随窗口宽度实时切换（断点与外壳侧栏一致）
  const isPc = useIsPc()
  const { currentAgentKey, showToast } = useStore()

  const [agent, setAgent] = useState<Agent | null>(null)
  const [agentLoading, setAgentLoading] = useState(true)

  const [conversationId, setConversationId] = useState(newConvId)
  const [turns, setTurns] = useState<CanvasTurn[]>([])
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null)
  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [sending, setSending] = useState(false)
  const [pendingQuery, setPendingQuery] = useState('')   // 正在加载时显示「正在分析…」
  const [live, setLive] = useState<LiveState | null>(null)  // 流式进行中的实时步骤
  const lastTraceRef = useRef<LiveState | null>(null)         // 最近一轮结束时的执行过程快照

  // 移动端输入栏
  const [mobileInput, setMobileInput] = useState('')
  const [mobileInputFocused, setMobileInputFocused] = useState(false)

  // PC 左栏收起
  const [pcLeftCollapsed, setPcLeftCollapsed] = useState(false)

  const [pcInput, setPcInput] = useState('')

  // 关联看板时的页签：PC 右栏「看板 / 当前结果」；移动端「看板 / 对话」
  const [rightTab, setRightTab] = useState<'dashboard' | 'result'>('dashboard')
  const [mobileTab, setMobileTab] = useState<'dashboard' | 'chat'>('dashboard')

  // 看板点击：浮层 + 「问点别的」时挂在输入框上方的上下文胶囊
  const [biPopover, setBiPopover] = useState<{ pick: BiPick; dashboard: BiDashboard; filters: BiFilterValues } | null>(null)
  const [pendingContext, setPendingContext] = useState<BiContextPayload | null>(null)
  const pcInputRef = useRef<HTMLInputElement>(null)
  const mobileInputRef = useRef<HTMLInputElement>(null)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const currentTurn = turns.find((t) => t.id === currentTurnId) ?? turns[turns.length - 1] ?? null
  const followupSuggestions: string[] = [] // 从 actions 里提取，见 doSend
  void followupSuggestions

  // 加载 agent 配置
  useEffect(() => {
    if (!currentAgentKey) { setAgentLoading(false); return }
    setAgentLoading(true)
    apiFetch(`/agents/${encodeURIComponent(currentAgentKey)}`)
      .then((d) => {
        setAgent(d.agent as Agent)
        useStore.setState({ currentAgentLabel: (d.agent as Agent)?.label || null })
      })
      .catch(() => { /* 无配置也能用 */ })
      .finally(() => setAgentLoading(false))
  }, [currentAgentKey])

  // defaultEnabled → 自动发第一轮（关联了看板时以看板为默认内容，不再跑）
  useEffect(() => {
    if (!agent?.defaultEnabled || !agent.defaultPrompt || agent.dashboardKey) return
    if (turns.length > 0) return
    void doSend(agent.defaultPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatItems, sending])

  // ─── 发送核心 ──────────────────────────────────────────────────────────────

  /** 流式调用 Agent：过程事件实时写入 live，返回最终结果（与非流式接口同形） */
  const runAgent = useCallback(async (body: Record<string, unknown>, signal: AbortSignal) => {
    const feed = createLiveFeed(setLive)
    try {
      return await streamAgentChat(body, { signal, onEvent: feed.push })
    } finally {
      feed.stop()
      lastTraceRef.current = feed.getState() // 成功/失败/中止都保留，调用方据此固化到对话里
      setLive(null)
    }
  }, [])

  const doSend = useCallback(
    /**
     * @param opts.context 看板上下文；未传时使用输入框上方挂着的胶囊（pendingContext）
     * @param opts.mode    'fast' = 快模型（点击「AI 解读」）
     */
    async (text: string, opts: { context?: BiContextPayload | null; mode?: 'fast' } = {}) => {
      const trimmed = text.trim()
      if (!trimmed || sending) return
      const ctx = opts.context !== undefined ? opts.context : pendingContext
      setPendingContext(null)
      setMobileInput('')
      setPcInput('')
      setSending(true)
      setPendingQuery(trimmed)
      setMobileTab('chat')

      const tempId = uid()
      const userItem: ChatItem = { id: uid(), role: 'user', content: trimmed, contextCaption: ctx?.caption }
      const loadingItem: ChatItem = { id: tempId, role: 'assistant', content: '', loading: true }
      setChatItems((prev) => [...prev, userItem, loadingItem])

      const ctrl = new AbortController()
      abortRef.current = ctrl

      try {
        const data = await runAgent(
          {
            conversationId,
            agentKey: currentAgentKey ?? undefined,
            message: trimmed,
            context: ctx ? toWireContext(ctx) : undefined,
            mode: opts.mode,
          },
          ctrl.signal,
        )
        // 在 setState 回调之外取快照：回调可能稍后才执行，届时 ref 已可能被下一轮覆盖
        const finishedTrace = finishTrace(lastTraceRef.current, data)

        if (data?.status === 'need_clarification' && data.clarification) {
          const cl = data.clarification as ClarificationData
          setChatItems((prev) =>
            prev.map((it) =>
              it.id === tempId
                ? { ...it, loading: false, content: cl.question, clarification: cl, trace: finishedTrace, timings: parseAgentTrace(data).timings }
                : it,
            ),
          )
          setSending(false)
          setPendingQuery('')
          return
        }

        const rawMessage = typeof data?.message === 'string' ? data.message : ''
        const { cleaned, canvas } = extractCanvas(rawMessage)
        const trace = parseAgentTrace(data)
        const charts = extractCharts(trace.toolSteps)

        const newTurn: CanvasTurn = {
          id: uid(),
          query: trimmed.length > 40 ? trimmed.slice(0, 38) + '…' : trimmed,
          intent: canvas.intent,
          canvas,
          charts,
          message: cleaned,
          toolSteps: trace.toolSteps,
          timings: trace.timings,
          timestamp: Date.now(),
        }
        setTurns((prev) => [...prev, newTurn])
        setCurrentTurnId(newTurn.id)
        setRightTab('result')

        // 从 actions 提取追问建议
        const followups = Array.isArray(data?.actions)
          ? (data.actions as { type: string; label: string }[])
              .filter((a) => a.type === 'followup')
              .map((a) => a.label)
          : []

        const assistantContent = cleaned || rawMessage || '（完成）'
        setChatItems((prev) => {
          const updated = prev.map((it) =>
            it.id === tempId
              ? { ...it, loading: false, content: assistantContent, turnRef: newTurn.id, trace: finishedTrace, timings: trace.timings }
              : it,
          )
          // 追问建议追加为单独 item，内容用特殊前缀区分
          if (followups.length > 0) {
            updated.push({
              id: uid(),
              role: 'assistant',
              content: '__followups__:' + followups.join('|'),
              turnRef: newTurn.id,
            })
          }
          return updated
        })
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          setChatItems((prev) =>
            prev.map((it) => (it.id === tempId ? { ...it, loading: false, content: '⏹ 已停止', trace: lastTraceRef.current ?? undefined } : it)),
          )
        } else {
          setChatItems((prev) => prev.filter((it) => it.id !== tempId))
          showToast(e instanceof Error ? e.message : '发送失败，请检查网络或 AI 配置')
        }
      } finally {
        abortRef.current = null
        setSending(false)
        setPendingQuery('')
      }
    },
    [sending, conversationId, currentAgentKey, showToast, runAgent, pendingContext],
  )

  const resumeWith = useCallback(
    async (itemId: string, field: string, value: string | number, label: string) => {
      setChatItems((prev) =>
        prev.map((it) => (it.id === itemId ? { ...it, clarificationResolved: true } : it)),
      )
      const userItem: ChatItem = { id: uid(), role: 'user', content: `已选择：${label}` }
      const tempId = uid()
      const loadingItem: ChatItem = { id: tempId, role: 'assistant', content: '', loading: true }
      setChatItems((prev) => [...prev, userItem, loadingItem])
      setSending(true)
      setPendingQuery(label)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        const data = await runAgent(
          { conversationId, agentKey: currentAgentKey ?? undefined, resume: { field, value } },
          ctrl.signal,
        )
        const finishedTrace = finishTrace(lastTraceRef.current, data)
        const rawMessage = typeof data?.message === 'string' ? data.message : ''
        const { cleaned, canvas } = extractCanvas(rawMessage)
        const trace = parseAgentTrace(data)
        const charts = extractCharts(trace.toolSteps)
        const newTurn: CanvasTurn = {
          id: uid(), query: label, intent: canvas.intent, canvas, charts,
          message: cleaned, toolSteps: trace.toolSteps, timings: trace.timings, timestamp: Date.now(),
        }
        setTurns((prev) => [...prev, newTurn])
        setCurrentTurnId(newTurn.id)
        setRightTab('result')
        setChatItems((prev) =>
          prev.map((it) =>
            it.id === tempId
              ? { ...it, loading: false, content: cleaned || rawMessage || '（完成）', turnRef: newTurn.id, trace: finishedTrace, timings: trace.timings }
              : it,
          ),
        )
      } catch {
        setChatItems((prev) => prev.filter((it) => it.id !== tempId))
        showToast('操作失败')
      } finally {
        abortRef.current = null
        setSending(false)
        setPendingQuery('')
      }
    },
    [conversationId, currentAgentKey, showToast, runAgent],
  )

  const startNew = useCallback(() => {
    if (sending) { abortRef.current?.abort(); return }
    setConversationId(newConvId())
    setTurns([])
    setCurrentTurnId(null)
    setChatItems([])
    setMobileInput('')
    setPcInput('')
    setPendingQuery('')
    setRightTab('dashboard')
  }, [sending])

  /** 看板上点中元素 → 通用点击浮层 */
  const handleBiPick = useCallback(
    (pick: BiPick, ctx: { dashboard: BiDashboard; filters: BiFilterValues }) => {
      setBiPopover({ pick, dashboard: ctx.dashboard, filters: ctx.filters })
    },
    [],
  )
  const closeBiPopover = useCallback(() => setBiPopover(null), [])

  /** ✨ AI 解读：直接发送，快模型；回答出来后右栏自动切到「当前结果」 */
  const biExplain = () => {
    if (!biPopover) return
    const ctx = buildBiContext(biPopover.pick, biPopover.dashboard, biPopover.filters, 'explain')
    setBiPopover(null)
    if (sending) {
      showToast('上一个问题还在分析中，请稍候')
      return
    }
    if (isPc) setPcLeftCollapsed(false)
    void doSend(explainPrompt(ctx), { context: ctx, mode: 'fast' })
  }

  /** 问点别的：上下文挂到输入框上方，用户自己补一句 */
  const biAsk = () => {
    if (!biPopover) return
    const ctx = buildBiContext(biPopover.pick, biPopover.dashboard, biPopover.filters, 'ask')
    setBiPopover(null)
    setPendingContext(ctx)
    if (isPc) {
      setPcLeftCollapsed(false)
      setTimeout(() => pcInputRef.current?.focus(), 50)
    } else {
      setMobileTab('chat')
      setTimeout(() => mobileInputRef.current?.focus(), 50)
    }
  }

  const biDrill = () => {
    biPopover?.pick.drill()
    setBiPopover(null)
  }

  /** 输入框上方的上下文胶囊 */
  const contextChip = pendingContext ? (
    <div className="flex items-center gap-1.5 mb-2 text-[12px]">
      <span
        className="inline-flex items-center gap-1 max-w-full px-2.5 py-1 rounded-full"
        style={{ background: tv('primary-soft'), color: tv('primary') }}
        title={`将带上看板上下文：${pendingContext.caption}`}
      >
        <span aria-hidden>📎</span>
        <span className="truncate">{pendingContext.caption}</span>
        <button
          type="button"
          onClick={() => setPendingContext(null)}
          className="ml-0.5 rounded-full w-4 h-4 inline-flex items-center justify-center hover:bg-surface/70"
          aria-label="移除看板上下文"
        >
          ×
        </button>
      </span>
    </div>
  ) : null

  const popoverEl = biPopover ? (
    <BiPickPopover
      x={biPopover.pick.x}
      y={biPopover.pick.y}
      title={buildBiContext(biPopover.pick, biPopover.dashboard, biPopover.filters, 'ask').caption}
      drillLabel={biPopover.pick.drillLabel}
      onExplain={biExplain}
      onDrill={biDrill}
      onAsk={biAsk}
      onClose={closeBiPopover}
    />
  ) : null

  const quickPrompts: AgentQuickPrompt[] = agent?.quickPrompts ?? []

  // ─── 渲染 ─────────────────────────────────────────────────────────────────

  if (agentLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-sm gap-2" style={{ color: tv('subtle') }}>
        <Loader2 className="w-4 h-4 animate-spin" />
        加载中…
      </div>
    )
  }

  const showCanvas = sending || currentTurn !== null
  const hasDashboard = !!agent?.dashboardKey
  const showWelcome = !showCanvas && turns.length === 0

  // ─── PC 输入框组件（复用逻辑） ─────────────────────────────────────────────

  const PcInputBar = (
    <div style={{ padding: '16px 24px 20px', borderTop: '1px solid rgb(var(--c-surface-2))', flexShrink: 0, minWidth: 420 }}>
      {contextChip}
      <div
        className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 transition-colors"
        style={{ background: tv('bg'), border: '1px solid transparent' }}
        onFocus={(e) => (e.currentTarget.style.borderColor = tv('primary'))}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'transparent')}
      >
        <input
          ref={pcInputRef}
          value={pcInput}
          onChange={(e) => setPcInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(pcInput) }
          }}
          placeholder={pendingContext ? '针对这个数据，想问什么？' : '问点什么…'}
          disabled={sending}
          className="flex-1 bg-transparent outline-none disabled:opacity-50"
          style={{ fontSize: 13.5, color: tv('fg') }}
        />
        <button
          onClick={() => sending ? abortRef.current?.abort() : void doSend(pcInput)}
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
          style={{
            background: sending ? tv('danger-soft') : pcInput.trim() ? tv('primary') : tv('line'),
            color: sending ? tv('danger') : pcInput.trim() ? tv('surface') : tv('subtle'),
          }}
        >
          {sending ? (
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )

  // ─── PC 左侧对话气泡渲染 ───────────────────────────────────────────────────

  const renderChatItem = (item: ChatItem) => {
    if (item.content.startsWith('__followups__:')) {
      const labels = item.content.replace('__followups__:', '').split('|').filter(Boolean)
      return (
        <div key={item.id} className="flex gap-2.5 max-w-full">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: tv('primary-soft'), color: tv('primary'), fontSize: 11, fontWeight: 600 }}>AI</div>
          <div className="flex-1 min-w-0">
            <Suggestions items={labels} onSend={(t) => void doSend(t)} />
          </div>
        </div>
      )
    }

    if (item.role === 'user') {
      return (
        <div key={item.id} className="flex gap-2.5 flex-row-reverse max-w-full">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: tv('inverse'), color: tv('inverse-fg'), fontSize: 11, fontWeight: 600 }}>我</div>
          <div style={{ maxWidth: 300 }} className="flex flex-col items-end">
            {item.contextCaption && (
              <span className="mb-1 inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-full text-[11px]" style={{ background: tv('primary-soft'), color: tv('primary') }} title="带有看板上下文">
                <span aria-hidden>📎</span>
                <span className="truncate">{item.contextCaption}</span>
              </span>
            )}
            <div className="px-3.5 py-2.5 rounded-xl text-[13.5px] leading-relaxed" style={{ background: tv('inverse'), color: tv('inverse-fg'), borderTopRightRadius: 4, wordBreak: 'break-word' }}>
              {item.content}
            </div>
          </div>
        </div>
      )
    }

    // assistant
    return (
      <div key={item.id} className="flex gap-2.5 max-w-full">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: tv('primary-soft'), color: tv('primary'), fontSize: 11, fontWeight: 600 }}>AI</div>
        <div className="flex-1 min-w-0" style={{ maxWidth: 300 }}>
          {/* 执行过程放在左侧对话里：运行中实时刷新，完成后保留（可折叠） */}
          {item.loading &&
            (live ? <AgentLiveTrace live={live} /> : <AgentLiveStatus live={null} />)}
          {!item.loading && item.trace && item.trace.steps.length > 0 && (
            <div className="mb-2">
              <AgentLiveTrace live={item.trace} running={false} totalMs={item.timings?.totalMs} timings={item.timings} />
            </div>
          )}
          {item.loading ? null : item.clarification && !item.clarificationResolved ? (
            <div className="rounded-xl rounded-tl px-3.5 py-3 border text-[13px]" style={{ background: tv('bg'), borderTopLeftRadius: 4 }}>
              <p className="mb-2" style={{ color: tv('fg') }}>{item.clarification.question}</p>
              {item.clarification.type === 'save_confirm' ? (
                <div className="flex gap-2">
                  <button onClick={() => void resumeWith(item.id, 'confirm', 'confirm', '确认保存')} className="flex-1 py-1.5 rounded-lg text-[12.5px] font-medium" style={{ background: tv('primary'), color: tv('primary-fg') }}>确认</button>
                  <button onClick={() => void resumeWith(item.id, 'confirm', 'cancel', '取消')} className="flex-1 py-1.5 rounded-lg text-[12.5px] border" style={{ color: tv('muted') }}>取消</button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {item.clarification.options.map((opt) => (
                    <button key={String(opt.value)} onClick={() => void resumeWith(item.id, item.clarification!.field, opt.value, opt.label)} className="px-2.5 py-1 rounded-full text-[12px] border" style={{ borderColor: tv('primary', 0.35), background: tv('primary-soft'), color: tv('primary') }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              className="w-full text-left rounded-xl rounded-tl px-3.5 py-2.5 text-[13.5px] leading-relaxed transition-colors border"
              style={{ background: item.turnRef === currentTurnId ? tv('primary-soft') : tv('bg'), borderTopLeftRadius: 4, borderColor: 'transparent', color: tv('fg'), wordBreak: 'break-word' }}
              onClick={() => { if (item.turnRef) { setCurrentTurnId(item.turnRef); setRightTab('result') } }}
            >
              <div className="flex items-start gap-1.5 flex-wrap mb-1">
                {(item as ChatItem & { skillTag?: string }).skillTag && (
                  <IntentBadge intent={(item as ChatItem & { skillTag?: string }).skillTag} />
                )}
              </div>
              <span className="line-clamp-3">{item.content || '（完成）'}</span>
              {item.turnRef && (
                <span className="flex items-center gap-0.5 mt-1.5 text-[11px]" style={{ color: tv('primary', 0.7) }}>
                  点击查看完整分析 <ChevronRight className="w-3 h-3" />
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    )
  }

  // ─── 全局 CSS 注入（fadeUp + spin + 细滚动条） ────────────────────────────
  const globalStyle = `
    @keyframes agentFadeUp {
      from { opacity:0; transform:translateY(8px); }
      to   { opacity:1; transform:translateY(0); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .agent-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
    .agent-scrollbar::-webkit-scrollbar-track { background: transparent; }
    .agent-scrollbar::-webkit-scrollbar-thumb { background: rgb(var(--c-line-strong)); border-radius: 3px; }
  `

  // ─── 渲染分支：PC 双栏 ────────────────────────────────────────────────────

  if (isPc) {
    return (
      <>
        <style>{globalStyle}</style>
        {popoverEl}
        <div className="flex overflow-hidden" style={{ height: 'calc(100vh - 3.5rem)', background: tv('bg') }}>

          {/* 左栏：对话 + 输入 */}
          <div
            className="flex flex-col overflow-hidden transition-all duration-300"
            style={{
              width: pcLeftCollapsed ? 0 : 420,
              minWidth: pcLeftCollapsed ? 0 : 420,
              background: tv('surface'),
              borderRight: pcLeftCollapsed ? 'none' : '1px solid rgb(var(--c-line))',
            }}
          >
            {/* 左栏 header */}
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgb(var(--c-surface-2))', flexShrink: 0, minWidth: 420 }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[17px] font-semibold" style={{ color: tv('fg') }}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: tv('success'), boxShadow: '0 0 0 3px rgb(var(--c-success) / 0.15)' }} />
                    {agent?.label ?? 'Agent'}
                  </div>
                  {agent?.subtitle && (
                    <div className="text-[12px] mt-1" style={{ color: tv('subtle') }}>{agent.subtitle}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={startNew} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[12px] transition-colors" style={{ color: tv('muted'), border: '1px solid rgb(var(--c-line))' }}>
                    <Plus className="w-3.5 h-3.5" /> 新对话
                  </button>
                  <button onClick={() => setPcLeftCollapsed(true)} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ border: '1px solid rgb(var(--c-line))', color: tv('muted') }} title="收起对话栏">
                    <PanelLeftClose className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* 消息流 */}
            <div className="flex-1 overflow-y-auto agent-scrollbar" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 420 }}>
              {/* 欢迎 + 快捷入口 */}
              {chatItems.length === 0 && (
                <div>
                  <div className="flex gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: tv('primary-soft'), color: tv('primary'), fontSize: 11, fontWeight: 600 }}>AI</div>
                    <div className="flex-1 min-w-0">
                      <div className="rounded-xl rounded-tl px-3.5 py-2.5 text-[13.5px] leading-relaxed" style={{ background: tv('bg'), borderTopLeftRadius: 4, color: tv('fg') }}>
                        {agent?.welcomeMd
                          ? <ChatMarkdown content={agent.welcomeMd} />
                          : `你好，我是${agent?.label ?? 'Agent'}。已为你准备好默认报告，右侧是完整内容。`}
                      </div>
                      {quickPrompts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {quickPrompts.map((q, i) => (
                            <button key={i} onClick={() => void doSend(q.prompt)} className="text-[12px] px-3 py-1.5 rounded-full border transition-colors" style={{ borderColor: tv('line'), color: tv('fg-2'), background: tv('surface') }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = tv('primary'); (e.currentTarget as HTMLElement).style.color = tv('primary') }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = tv('line'); (e.currentTarget as HTMLElement).style.color = tv('fg-2') }}
                            >
                              {q.icon ? `${q.icon} ` : ''}{q.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {chatItems.map(renderChatItem)}

              <div ref={chatEndRef} />
            </div>

            {PcInputBar}
          </div>

          {/* 右栏：画布输出 */}
          <div className="flex flex-col flex-1 overflow-hidden relative">
            {/* 折叠时左上角展开按钮 */}
            {pcLeftCollapsed && (
              <button
                onClick={() => setPcLeftCollapsed(false)}
                className="absolute top-4 left-4 z-10 w-9 h-9 rounded-xl flex items-center justify-center transition-colors"
                style={{ border: '1px solid rgb(var(--c-line))', background: tv('surface'), color: tv('fg-2'), boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}
                title="展开对话栏"
              >
                <PanelLeftOpen className="w-5 h-5" />
              </button>
            )}

            {/* 关联看板：页签头 */}
            {hasDashboard && (
              <div
                className="flex items-center gap-1 flex-shrink-0"
                role="tablist"
                aria-label="右栏内容"
                style={{ padding: pcLeftCollapsed ? '16px 28px 0 68px' : '16px 28px 0', borderBottom: '1px solid rgb(var(--c-line))', background: tv('bg') }}
              >
                <RightTabButton active={rightTab === 'dashboard'} onClick={() => setRightTab('dashboard')}>📊 看板</RightTabButton>
                <RightTabButton active={rightTab === 'result'} onClick={() => setRightTab('result')}>
                  当前结果
                  {sending && <Loader2 className="w-3 h-3 animate-spin" style={{ color: tv('primary') }} aria-label="分析中" />}
                </RightTabButton>
              </div>
            )}

            {/* 看板：切走时只隐藏不卸载，保留筛选、下钻与已加载的数据 */}
            {hasDashboard && currentAgentKey && (
              <div
                className="flex-1 overflow-y-auto agent-scrollbar"
                role="tabpanel"
                style={{ padding: '20px 28px 28px', display: rightTab === 'dashboard' ? 'block' : 'none' }}
              >
                <DashboardPanel agentKey={currentAgentKey} pcMode onPick={handleBiPick} />
              </div>
            )}

            <div
              className="flex-1 overflow-y-auto agent-scrollbar"
              role={hasDashboard ? 'tabpanel' : undefined}
              style={{ padding: '24px 28px', display: !hasDashboard || rightTab === 'result' ? 'flex' : 'none', flexDirection: 'column', gap: 20 }}
            >
              {hasDashboard && turns.length === 0 && !sending && (
                <div className="text-[13px] text-center py-16" style={{ color: tv('subtle') }}>
                  还没有分析结果。在左侧提问，或在看板上点击数字、图表让 AI 解读。
                </div>
              )}
              {/* 默认报告标题行 */}
              {(turns.length > 0 || sending) && (
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-[16px] font-semibold" style={{ color: tv('fg') }}>
                      {currentTurn?.query ?? pendingQuery ?? agent?.label ?? 'Agent'}
                    </h2>
                    {agent?.defaultCacheSecs && agent.defaultCacheSecs > 0 && (
                      <div className="text-[12px] mt-0.5" style={{ color: tv('subtle') }}>
                        数据每 {Math.round(agent.defaultCacheSecs / 60)} 分钟更新
                      </div>
                    )}
                  </div>
                  {turns.length > 1 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {turns.map((t) => (
                        <TurnChip key={t.id} turn={t} isCurrent={t.id === currentTurnId} onClick={() => setCurrentTurnId(t.id)} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              <CanvasPanel turn={currentTurn} loading={sending} query={pendingQuery} pcMode />
            </div>
          </div>
        </div>
      </>
    )
  }

  // ─── 移动端 ───────────────────────────────────────────────────────────────

  return (
    <>
      <style>{globalStyle}</style>
      {popoverEl}

      {/* 整体：flex col，撑满视口（减去顶部 header 56px + 底部安全区） */}
      <div
        className="flex flex-col"
        style={{ height: 'calc(100dvh - 3.5rem)', background: tv('bg') }}
      >
        {/* 关联看板：顶部页签 */}
        {hasDashboard && (
          <div className="flex-shrink-0 flex gap-1 p-1 mx-4 mt-3 rounded-xl" role="tablist" aria-label="内容" style={{ background: tv('line') }}>
            {(['dashboard', 'chat'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={mobileTab === t}
                onClick={() => setMobileTab(t)}
                className="flex-1 py-1.5 rounded-lg text-[13px] flex items-center justify-center gap-1"
                style={mobileTab === t ? { background: tv('surface'), color: tv('fg'), fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,.06)' } : { color: tv('muted') }}
              >
                {t === 'dashboard' ? '📊 看板' : '对话'}
                {t === 'chat' && sending && <Loader2 className="w-3 h-3 animate-spin" style={{ color: tv('primary') }} />}
              </button>
            ))}
          </div>
        )}

        {/* 看板（移动端单列）；切走时只隐藏不卸载 */}
        {hasDashboard && currentAgentKey && (
          <div className="flex-1 min-h-0 overflow-y-auto agent-scrollbar" style={{ display: mobileTab === 'dashboard' ? 'block' : 'none', padding: 16 }}>
            <DashboardPanel agentKey={currentAgentKey} pcMode={false} onPick={handleBiPick} />
          </div>
        )}

        {/* ── 主滚动区 ── */}
        <div className="flex-1 min-h-0 overflow-y-auto agent-scrollbar" style={{ display: !hasDashboard || mobileTab === 'chat' ? undefined : 'none' }}>
          <div style={{ padding: '16px 16px 16px' }}>

            {/* 历史轮切换 */}
            {turns.length > 1 && (
              <div className="flex gap-2 mb-3 overflow-x-auto pb-1 agent-scrollbar">
                {turns.map((t) => (
                  <TurnChip key={t.id} turn={t} isCurrent={t.id === currentTurnId} onClick={() => setCurrentTurnId(t.id)} />
                ))}
              </div>
            )}

            {/* 画布区 —— 主内容，直接展示在页面上 */}
            <div className="mb-3">
              <CanvasPanel turn={currentTurn} loading={sending} query={pendingQuery} live={live} />
            </div>

            {/* 欢迎语（无内容时） */}
            {showWelcome && (
              <FadeUp>
                <div className="rounded-2xl p-4 mb-3" style={{ background: tv('surface'), border: '1px solid rgb(var(--c-surface-2))' }}>
                  <div className="flex items-center gap-2 mb-2" style={{ color: tv('primary') }}>
                    <Bot className="w-4 h-4" />
                    <span className="text-[13px] font-medium">{agent?.label ?? 'Agent'}</span>
                  </div>
                  {agent?.welcomeMd
                    ? <ChatMarkdown content={agent.welcomeMd} />
                    : <p className="text-[13px] leading-relaxed" style={{ color: tv('fg-2') }}>你好，我是 {agent?.label ?? 'Agent'}，有什么可以帮你？</p>
                  }
                </div>
              </FadeUp>
            )}

            {/* 快捷提问（无历史时展示在欢迎语下方） */}
            {showWelcome && quickPrompts.length > 0 && (
              <div className="space-y-2 mb-3">
                {quickPrompts.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => void doSend(q.prompt)}
                    className="w-full flex items-center justify-between gap-2 rounded-xl px-3.5 py-3 text-left border transition-colors active:scale-[0.99]"
                    style={{ background: tv('surface'), borderColor: tv('surface-2'), color: tv('fg') }}
                  >
                    <span className="text-[13px]">
                      {q.icon ? `${q.icon} ` : ''}{q.label}
                    </span>
                    <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: tv('line-strong') }} />
                  </button>
                ))}
              </div>
            )}

            {/* 追问建议（有结果时） */}
            {currentTurn && (() => {
              const sugs = chatItems
                .filter((it) => it.turnRef === currentTurnId && it.content.startsWith('__followups__:'))
                .flatMap((it) => it.content.replace('__followups__:', '').split('|').filter(Boolean))
              return sugs.length > 0 ? (
                <div className="mt-3">
                  <Suggestions items={sugs} onSend={(t) => void doSend(t)} />
                </div>
              ) : null
            })()}

            <div ref={chatEndRef} />
          </div>
        </div>

        {/* ── 底部固定输入栏 ── */}
        <div
          className="flex-shrink-0 border-t"
          style={{
            background: tv('surface'),
            borderColor: tv('surface-2'),
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          {/* 快捷 chip（有内容后仍显示） */}
          {quickPrompts.length > 0 && !showWelcome && (
            <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto agent-scrollbar">
              {quickPrompts.map((q, i) => (
                <button
                  key={i}
                  onClick={() => void doSend(q.prompt)}
                  disabled={sending}
                  className="text-[12px] px-3 py-1.5 rounded-full border whitespace-nowrap flex-shrink-0 transition-colors disabled:opacity-40"
                  style={{ borderColor: tv('line'), color: tv('fg-2'), background: tv('surface') }}
                >
                  {q.icon ? `${q.icon} ` : ''}{q.label}
                </button>
              ))}
            </div>
          )}

          <div className="px-4 py-3">
            {contextChip}
            <div
              className="flex items-center gap-2 rounded-2xl px-4 py-2.5 transition-colors"
              style={{
                background: tv('bg'),
                border: `1px solid ${mobileInputFocused ? tv('primary') : 'transparent'}`,
              }}
            >
              <input
                ref={mobileInputRef}
                type="text"
                value={mobileInput}
                onChange={(e) => setMobileInput(e.target.value)}
                onFocus={() => setMobileInputFocused(true)}
                onBlur={() => setMobileInputFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(mobileInput) }
                }}
                placeholder={sending ? '思考中…' : agent ? `问问${agent.label}…` : '输入问题…'}
                disabled={sending}
                className="flex-1 bg-transparent outline-none min-w-0 disabled:opacity-50"
                style={{ fontSize: 14, color: tv('fg') }}
              />
              <button
                onClick={() => sending ? abortRef.current?.abort() : void doSend(mobileInput)}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all"
                style={{
                  background: sending
                    ? tv('danger-soft')
                    : mobileInput.trim() ? tv('primary') : tv('subtle'),
                  color: tv('primary-fg'),
                  border: 'none',
                  opacity: (!sending && !mobileInput.trim()) ? 0.5 : 1,
                }}
              >
                {sending ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
                    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
