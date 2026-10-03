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
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot, Plus, ChevronRight, Loader2, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { createLiveFeed, streamAgentChat, type LiveState } from '../utils/agentStream'
import ChartRenderer from '../components/ChartRenderer'
import AgentLiveTrace, { AgentLiveStatus } from '../components/AgentLiveTrace'
import AgentTracePanel, { parseAgentTrace, type AgentTimings, type AgentToolStep } from '../components/AgentTracePanel'
import ChatMarkdown from '../components/ChatMarkdown'
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
  report:  { text: '预置报表', bg: '#e0f2fe', color: '#0369a1' },
  explore: { text: '探索分析', bg: '#fef3c7', color: '#b45309' },
  insight: { text: '趋势洞察', bg: '#ede9fe', color: '#6d28d9' },
  explain: { text: '智能解答', bg: '#dcfce7', color: '#15803d' },
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
          style={{ background: '#fafbfc', borderColor: '#f0f1f3' }}
        >
          <div className="text-[11.5px]" style={{ color: '#8b8fa3' }}>{m.label}</div>
          <div
            className="font-bold mt-1 leading-tight"
            style={{ fontSize: pcMode ? 22 : 19, color: '#1a1a2e', letterSpacing: '-0.3px' }}
          >
            {m.value}
          </div>
          {m.delta && (
            <div
              className="text-[11.5px] mt-1 font-medium"
              style={{ color: m.deltaUp ? '#16a34a' : '#dc2626' }}
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
                  color: '#8b8fa3',
                  fontSize: 11.5,
                  borderBottom: '1px solid #f0f1f3',
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
            <tr key={ri} style={{ borderBottom: '1px solid #f5f6f8' }}>
              {table.columns.map((c, ci) => {
                const val = row[c] ?? ''
                const right = ci > 0 && isNumeric(val)
                const down = ci > 0 && isDown(val)
                return (
                  <td
                    key={ci}
                    style={{
                      padding: '10px',
                      color: '#2d3142',
                      whiteSpace: 'nowrap',
                      textAlign: right ? 'right' : 'left',
                      fontVariantNumeric: right ? 'tabular-nums' : undefined,
                    }}
                  >
                    {down ? (
                      <span
                        className="inline-block text-[10.5px] px-1.5 py-0.5 rounded"
                        style={{ background: '#fef2f2', color: '#dc2626', fontWeight: 500 }}
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
          background: '#fff',
          border: '1px solid #eef0f4',
          boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        }}
      >
        {title && (
          <div
            className="flex items-center justify-between px-4 pt-3.5 pb-2.5"
            style={{ borderBottom: '1px solid #f5f6f8' }}
          >
            <span className="text-[13px] font-semibold" style={{ color: '#1a1a2e' }}>
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
              background: 'linear-gradient(135deg,#eef2ff,#f5f3ff)',
              color: '#4f6ef7',
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
              style={{ background: '#eef0f4', animationDelay: `${i * 150}ms` }}
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
                borderLeft: '3px solid #4f6ef7',
                background: '#f8f9ff',
                color: '#3a3f55',
              }}
            >
              <strong style={{ color: '#1a1a2e' }}>AI 洞察：</strong>
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
              borderLeft: '3px solid #4f6ef7',
              background: '#f8f9ff',
              color: '#3a3f55',
            }}
          >
            <strong style={{ color: '#1a1a2e' }}>AI 洞察：</strong>
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
          <div className="text-[13px] leading-relaxed" style={{ color: '#4a4f63' }}>
            <ChatMarkdown content={message} />
          </div>
          {((toolSteps && toolSteps.length > 0) || timings) && (
            <div className="mt-3">
              <AgentTracePanel toolSteps={toolSteps} timings={timings} />
            </div>
          )}
        </CanvasCard>
      )}
    </div>
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
          ? { borderColor: '#4f6ef7', background: '#eef2ff', color: '#4f6ef7' }
          : { borderColor: '#e8eaf0', background: '#fff', color: '#3a3f55' }
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
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#4f6ef7' }} />
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
          style={{ color: '#a0a4b8' }}
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
            style={{ background: '#fff', borderColor: '#e8eaf0', color: '#3a3f55' }}
            onMouseEnter={e => {
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = '#4f6ef7'
              ;(e.currentTarget as HTMLButtonElement).style.color = '#4f6ef7'
            }}
            onMouseLeave={e => {
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = '#e8eaf0'
              ;(e.currentTarget as HTMLButtonElement).style.color = '#3a3f55'
            }}
          >
            <span>{text}</span>
            <span style={{ color: '#c0c3d4', flexShrink: 0 }}>›</span>
          </button>
        ))}
      </div>
    </FadeUp>
  )
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export default function AgentRunView() {
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

  // 移动端输入栏
  const [mobileInput, setMobileInput] = useState('')
  const [mobileInputFocused, setMobileInputFocused] = useState(false)

  // PC 左栏收起
  const [pcLeftCollapsed, setPcLeftCollapsed] = useState(false)

  const [pcInput, setPcInput] = useState('')

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
      .then((d) => setAgent(d.agent as Agent))
      .catch(() => { /* 无配置也能用 */ })
      .finally(() => setAgentLoading(false))
  }, [currentAgentKey])

  // defaultEnabled → 自动发第一轮
  useEffect(() => {
    if (!agent?.defaultEnabled || !agent.defaultPrompt) return
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
      setLive(null)
    }
  }, [])

  const doSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || sending) return
      setMobileInput('')
      setPcInput('')
      setSending(true)
      setPendingQuery(trimmed)

      const tempId = uid()
      const userItem: ChatItem = { id: uid(), role: 'user', content: trimmed }
      const loadingItem: ChatItem = { id: tempId, role: 'assistant', content: '', loading: true }
      setChatItems((prev) => [...prev, userItem, loadingItem])

      const ctrl = new AbortController()
      abortRef.current = ctrl

      try {
        const data = await runAgent(
          { conversationId, agentKey: currentAgentKey ?? undefined, message: trimmed },
          ctrl.signal,
        )

        if (data?.status === 'need_clarification' && data.clarification) {
          const cl = data.clarification as ClarificationData
          setChatItems((prev) =>
            prev.map((it) =>
              it.id === tempId
                ? { ...it, loading: false, content: cl.question, clarification: cl }
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
              ? { ...it, loading: false, content: assistantContent, turnRef: newTurn.id }
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
            prev.map((it) => (it.id === tempId ? { ...it, loading: false, content: '⏹ 已停止' } : it)),
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
    [sending, conversationId, currentAgentKey, showToast, runAgent],
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
        setChatItems((prev) =>
          prev.map((it) =>
            it.id === tempId
              ? { ...it, loading: false, content: cleaned || rawMessage || '（完成）', turnRef: newTurn.id }
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
  }, [sending])

  const quickPrompts: AgentQuickPrompt[] = agent?.quickPrompts ?? []

  // ─── 渲染 ─────────────────────────────────────────────────────────────────

  if (agentLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-sm gap-2" style={{ color: '#8b8fa3' }}>
        <Loader2 className="w-4 h-4 animate-spin" />
        加载中…
      </div>
    )
  }

  const showCanvas = sending || currentTurn !== null
  const showWelcome = !showCanvas && turns.length === 0

  // ─── PC 输入框组件（复用逻辑） ─────────────────────────────────────────────

  const PcInputBar = (
    <div style={{ padding: '16px 24px 20px', borderTop: '1px solid #f0f1f3', flexShrink: 0, minWidth: 420 }}>
      <div
        className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 transition-colors"
        style={{ background: '#f5f6f8', border: '1px solid transparent' }}
        onFocus={(e) => (e.currentTarget.style.borderColor = '#4f6ef7')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'transparent')}
      >
        <input
          value={pcInput}
          onChange={(e) => setPcInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(pcInput) }
          }}
          placeholder="问点什么…"
          disabled={sending}
          className="flex-1 bg-transparent outline-none disabled:opacity-50"
          style={{ fontSize: 13.5, color: '#1a1a2e' }}
        />
        <button
          onClick={() => sending ? abortRef.current?.abort() : void doSend(pcInput)}
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
          style={{
            background: sending ? '#fee2e2' : pcInput.trim() ? '#4f6ef7' : '#e2e8f0',
            color: sending ? '#dc2626' : pcInput.trim() ? '#fff' : '#94a3b8',
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
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#eef2ff', color: '#4f6ef7', fontSize: 11, fontWeight: 600 }}>AI</div>
          <div className="flex-1 min-w-0">
            <Suggestions items={labels} onSend={(t) => void doSend(t)} />
          </div>
        </div>
      )
    }

    if (item.role === 'user') {
      return (
        <div key={item.id} className="flex gap-2.5 flex-row-reverse max-w-full">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#1a1a2e', color: '#fff', fontSize: 11, fontWeight: 600 }}>我</div>
          <div style={{ maxWidth: 300 }}>
            <div className="px-3.5 py-2.5 rounded-xl text-[13.5px] leading-relaxed" style={{ background: '#1a1a2e', color: '#fff', borderTopRightRadius: 4, wordBreak: 'break-word' }}>
              {item.content}
            </div>
          </div>
        </div>
      )
    }

    // assistant
    return (
      <div key={item.id} className="flex gap-2.5 max-w-full">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#eef2ff', color: '#4f6ef7', fontSize: 11, fontWeight: 600 }}>AI</div>
        <div className="flex-1 min-w-0" style={{ maxWidth: 300 }}>
          {item.loading ? (
            <AgentLiveStatus live={live} />
          ) : item.clarification && !item.clarificationResolved ? (
            <div className="rounded-xl rounded-tl px-3.5 py-3 border text-[13px]" style={{ background: '#f5f6f8', borderTopLeftRadius: 4 }}>
              <p className="mb-2" style={{ color: '#2d3142' }}>{item.clarification.question}</p>
              {item.clarification.type === 'save_confirm' ? (
                <div className="flex gap-2">
                  <button onClick={() => void resumeWith(item.id, 'confirm', 'confirm', '确认保存')} className="flex-1 py-1.5 rounded-lg text-[12.5px] font-medium" style={{ background: '#4f6ef7', color: '#fff' }}>确认</button>
                  <button onClick={() => void resumeWith(item.id, 'confirm', 'cancel', '取消')} className="flex-1 py-1.5 rounded-lg text-[12.5px] border" style={{ color: '#6b7089' }}>取消</button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {item.clarification.options.map((opt) => (
                    <button key={String(opt.value)} onClick={() => void resumeWith(item.id, item.clarification!.field, opt.value, opt.label)} className="px-2.5 py-1 rounded-full text-[12px] border" style={{ borderColor: '#c7d2fe', background: '#eef2ff', color: '#4f6ef7' }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              className="w-full text-left rounded-xl rounded-tl px-3.5 py-2.5 text-[13.5px] leading-relaxed transition-colors border"
              style={{ background: item.turnRef === currentTurnId ? '#eef2ff' : '#f5f6f8', borderTopLeftRadius: 4, borderColor: 'transparent', color: '#2d3142', wordBreak: 'break-word' }}
              onClick={() => { if (item.turnRef) setCurrentTurnId(item.turnRef) }}
            >
              <div className="flex items-start gap-1.5 flex-wrap mb-1">
                {(item as ChatItem & { skillTag?: string }).skillTag && (
                  <IntentBadge intent={(item as ChatItem & { skillTag?: string }).skillTag} />
                )}
              </div>
              <span className="line-clamp-3">{item.content || '（完成）'}</span>
              {item.turnRef && (
                <span className="flex items-center gap-0.5 mt-1.5 text-[11px]" style={{ color: '#818cf8' }}>
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
    .agent-scrollbar::-webkit-scrollbar-thumb { background: #d8dae5; border-radius: 3px; }
  `

  // ─── 渲染分支：PC 双栏 ────────────────────────────────────────────────────

  const isPcLayout = typeof window !== 'undefined' && window.innerWidth >= 900

  if (isPcLayout) {
    return (
      <>
        <style>{globalStyle}</style>
        <div className="flex overflow-hidden" style={{ height: 'calc(100vh - 3.5rem)', background: '#f5f6f8' }}>

          {/* 左栏：对话 + 输入 */}
          <div
            className="flex flex-col overflow-hidden transition-all duration-300"
            style={{
              width: pcLeftCollapsed ? 0 : 420,
              minWidth: pcLeftCollapsed ? 0 : 420,
              background: '#fff',
              borderRight: pcLeftCollapsed ? 'none' : '1px solid #e8eaed',
            }}
          >
            {/* 左栏 header */}
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f0f1f3', flexShrink: 0, minWidth: 420 }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[17px] font-semibold" style={{ color: '#1a1a2e' }}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#22c55e', boxShadow: '0 0 0 3px rgba(34,197,94,.15)' }} />
                    {agent?.label ?? 'Agent'}
                  </div>
                  {agent?.subtitle && (
                    <div className="text-[12px] mt-1" style={{ color: '#8b8fa3' }}>{agent.subtitle}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={startNew} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[12px] transition-colors" style={{ color: '#6b7089', border: '1px solid #e8eaed' }}>
                    <Plus className="w-3.5 h-3.5" /> 新对话
                  </button>
                  <button onClick={() => setPcLeftCollapsed(true)} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ border: '1px solid #e8eaed', color: '#6b7089' }} title="收起对话栏">
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
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#eef2ff', color: '#4f6ef7', fontSize: 11, fontWeight: 600 }}>AI</div>
                    <div className="flex-1 min-w-0">
                      <div className="rounded-xl rounded-tl px-3.5 py-2.5 text-[13.5px] leading-relaxed" style={{ background: '#f5f6f8', borderTopLeftRadius: 4, color: '#2d3142' }}>
                        {agent?.welcomeMd
                          ? <ChatMarkdown content={agent.welcomeMd} />
                          : `你好，我是${agent?.label ?? 'Agent'}。已为你准备好默认报告，右侧是完整内容。`}
                      </div>
                      {quickPrompts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {quickPrompts.map((q, i) => (
                            <button key={i} onClick={() => void doSend(q.prompt)} className="text-[12px] px-3 py-1.5 rounded-full border transition-colors" style={{ borderColor: '#e0e2e8', color: '#4a4f63', background: '#fff' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#4f6ef7'; (e.currentTarget as HTMLElement).style.color = '#4f6ef7' }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#e0e2e8'; (e.currentTarget as HTMLElement).style.color = '#4a4f63' }}
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
                style={{ border: '1px solid #e8eaed', background: '#fff', color: '#4a4f63', boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}
                title="展开对话栏"
              >
                <PanelLeftOpen className="w-5 h-5" />
              </button>
            )}

            <div className="flex-1 overflow-y-auto agent-scrollbar" style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* 默认报告标题行 */}
              {(turns.length > 0 || sending) && (
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-[16px] font-semibold" style={{ color: '#1a1a2e' }}>
                      {currentTurn?.query ?? pendingQuery ?? agent?.label ?? 'Agent'}
                    </h2>
                    {agent?.defaultCacheSecs && agent.defaultCacheSecs > 0 && (
                      <div className="text-[12px] mt-0.5" style={{ color: '#8b8fa3' }}>
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

              <CanvasPanel turn={currentTurn} loading={sending} query={pendingQuery} pcMode live={live} />
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

      {/* 整体：flex col，撑满视口（减去顶部 header 56px + 底部安全区） */}
      <div
        className="flex flex-col"
        style={{ height: 'calc(100dvh - 3.5rem)', background: '#f5f6f8' }}
      >
        {/* ── 主滚动区 ── */}
        <div className="flex-1 min-h-0 overflow-y-auto agent-scrollbar">
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
                <div className="rounded-2xl p-4 mb-3" style={{ background: '#fff', border: '1px solid #eef0f4' }}>
                  <div className="flex items-center gap-2 mb-2" style={{ color: '#4f6ef7' }}>
                    <Bot className="w-4 h-4" />
                    <span className="text-[13px] font-medium">{agent?.label ?? 'Agent'}</span>
                  </div>
                  {agent?.welcomeMd
                    ? <ChatMarkdown content={agent.welcomeMd} />
                    : <p className="text-[13px] leading-relaxed" style={{ color: '#4a4f63' }}>你好，我是 {agent?.label ?? 'Agent'}，有什么可以帮你？</p>
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
                    style={{ background: '#fff', borderColor: '#eef0f4', color: '#2d3142' }}
                  >
                    <span className="text-[13px]">
                      {q.icon ? `${q.icon} ` : ''}{q.label}
                    </span>
                    <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: '#c0c3d4' }} />
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
            background: '#fff',
            borderColor: '#eef0f4',
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
                  style={{ borderColor: '#e0e2e8', color: '#4a4f63', background: '#fff' }}
                >
                  {q.icon ? `${q.icon} ` : ''}{q.label}
                </button>
              ))}
            </div>
          )}

          <div className="px-4 py-3">
            <div
              className="flex items-center gap-2 rounded-2xl px-4 py-2.5 transition-colors"
              style={{
                background: '#f5f6f8',
                border: `1px solid ${mobileInputFocused ? '#4f6ef7' : 'transparent'}`,
              }}
            >
              <input
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
                style={{ fontSize: 14, color: '#1a1a2e' }}
              />
              <button
                onClick={() => sending ? abortRef.current?.abort() : void doSend(mobileInput)}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all"
                style={{
                  background: sending
                    ? '#fee2e2'
                    : mobileInput.trim() ? '#4f6ef7' : '#94a3b8',
                  color: '#fff',
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
