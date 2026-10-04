import { useCallback, useEffect, useRef, useState } from 'react'
import AgentStatusBadge from '../components/AgentStatusBadge'
import AgentLiveTrace from '../components/AgentLiveTrace'
import AgentTracePanel, { parseAgentTrace, type AgentTimings, type AgentToolStep } from '../components/AgentTracePanel'
import ChatMarkdown, { bareDocUrls } from '../components/ChatMarkdown'
import { useStore } from '../store'
import { apiFetch, apiUrl, authHeaders } from '../utils/api'
import { attachToolResults, createLiveFeed, stripActionsBlock, streamAgentChat, type LiveState } from '../utils/agentStream'
import { runHelpNavAction, type HelpNavAction } from '../utils/helpActions'

type ChatRole = 'user' | 'assistant'

interface ClarificationOption {
  value: string | number
  label: string
}

interface Clarification {
  type?: string
  field: string
  question: string
  options: ClarificationOption[]
  entity?: string
  payload?: Record<string, unknown>
}

/** 带鉴权下载文档（JWT 不能走普通 <a>，需 fetch blob） */
async function downloadDocument(url: string) {
  const res = await fetch(apiUrl(url), { headers: authHeaders() })
  if (!res.ok) throw new Error('下载失败')
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') || ''
  let name = 'document'
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition)
  if (m) {
    try {
      name = decodeURIComponent(m[1])
    } catch {
      /* ignore */
    }
  }
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objUrl)
}

interface ChatMessage {
  role: ChatRole
  content: string
  sources?: string[]
  actions?: HelpNavAction[]
  clarification?: Clarification
  clarificationResolved?: boolean
  skillUsed?: string
  toolSteps?: AgentToolStep[]
  timings?: AgentTimings
  /** 本轮执行过程快照（含每步耗时、模型输出、完整 SQL/结果）；仅本次会话内有，历史会话没有 */
  trace?: LiveState
  degraded?: boolean
  charts?: Record<string, unknown>[]
}

interface HelpTopic {
  id: string
  question: string
  keywords?: string[]
}

interface ConversationItem {
  id: string
  title: string
  updatedAt?: string
}

interface AgentSkill {
  name: string
  description: string
  producesDocument?: boolean
}

/** 从 skill 描述推导一键提问文案（优先引号内示例话术） */
function skillQuickPrompt(skill: AgentSkill): string {
  const d = skill.description.trim()
  const quoted = d.match(/[「『"']([^」』"']{2,48})[」』"']/)
  if (quoted?.[1]) return quoted[1]
  const head = d.split(/[。；;\n]/)[0]?.trim() || ''
  if (/^当用户/.test(head)) {
    const sub = head.replace(/^当用户(要求|说|提到|需要)/, '').trim()
    if (sub) return sub.length <= 48 ? sub : `${sub.slice(0, 46)}…`
  }
  if (head && head.length <= 48) {
    return head.endsWith('？') || head.endsWith('?') ? head : `请帮我${head}`
  }
  return `请帮我处理：${skill.name.replace(/-/g, ' ')}`
}

/** 按钮上显示的短标签 */
function skillChipLabel(skill: AgentSkill): string {
  const prompt = skillQuickPrompt(skill)
  return prompt.length > 28 ? `${prompt.slice(0, 26)}…` : prompt
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

const FALLBACK_TOPICS: HelpTopic[] = [
  { id: 'password', question: '如何修改密码？' },
  { id: 'pro-sign-receive', question: '生产报工怎么接单？' },
  { id: 'pro-sign-complete', question: '待完工怎么报工、怎么暂停？' },
  { id: 'report-query', question: '查一下某客户今年的销售订单额' },
]

function newConversationId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

/** 从 toolSteps 中提取 generate_chart 工具返回的 ECharts option */
function extractCharts(steps?: AgentToolStep[]): Record<string, unknown>[] | undefined {
  if (!steps) return undefined
  const charts: Record<string, unknown>[] = []
  for (const s of steps) {
    if (s.tool !== 'generate_chart') continue
    const raw = s.resultFull || s.resultPreview || ''
    try {
      const data = JSON.parse(raw)
      if (data?.success && data.chart) charts.push(data.chart as Record<string, unknown>)
    } catch { /* ignore */ }
  }
  return charts.length > 0 ? charts : undefined
}

export default function AiChatView() {
  const { showToast, setView, navigateTo, navMenus, openProSign, pendingChatSkill, consumePendingChatSkill } = useStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [topics, setTopics] = useState<HelpTopic[]>(FALLBACK_TOPICS)
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [conversationId, setConversationId] = useState<string>(() => newConversationId())
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [feedback, setFeedback] = useState<Record<number, 'up' | 'down'>>({})
  const [quotedMsg, setQuotedMsg] = useState<{ index: number; text: string } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** 流式进行中的实时步骤与文本；null = 当前没有进行中的对话 */
  const [live, setLive] = useState<LiveState | null>(null)
  const lastTraceRef = useRef<LiveState | null>(null) // 最近一轮结束时的执行过程快照

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, live?.steps.length, live?.text.length])

  /** 流式调用 Agent：过程事件实时写入 live，返回最终结果（与非流式接口同形） */
  const runAgent = useCallback(async (body: Record<string, unknown>, signal: AbortSignal) => {
    const feed = createLiveFeed(setLive)
    try {
      return await streamAgentChat(body, { signal, onEvent: feed.push })
    } finally {
      feed.stop()
      lastTraceRef.current = feed.getState()
      setLive(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      apiFetch('/ai/help/bootstrap').catch(() => null),
      apiFetch('/ai/agent/skills').catch(() => null),
    ]).then(([bootstrap, skillData]) => {
      if (cancelled) return
      if (Array.isArray(bootstrap?.topics) && bootstrap.topics.length > 0) setTopics(bootstrap.topics)
      if (Array.isArray(skillData?.items)) setSkills(skillData.items)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 语音输入：对话页挂载期间，悬浮语音按钮识别出的文本由 voice.js 经此钩子填入输入框
  useEffect(() => {
    const w = window as Window & { __voiceAiChatInput?: (text: string) => boolean }
    w.__voiceAiChatInput = (text: string) => {
      const t = String(text || '').trim()
      if (!t) return false
      setInput((prev) => (prev ? `${prev}${t}` : t))
      return true
    }
    return () => {
      delete w.__voiceAiChatInput
    }
  }, [])

  const navStoreBase = { setView, navigateTo, navMenus, openProSign, showToast }

  const refreshConversations = useCallback(async () => {
    try {
      const data = await apiFetch('/ai/agent/conversations')
      setConversations(Array.isArray(data?.items) ? data.items : [])
    } catch {
      /* ignore */
    }
  }, [])

  /** 统一处理 Agent 响应（最终回答 / 需要澄清） */
  const applyAgentResponse = useCallback((base: ChatMessage[], data: Record<string, unknown>) => {
    const parsed = parseAgentTrace(data)
    const liveTrace = lastTraceRef.current ? attachToolResults(lastTraceRef.current, parsed.toolSteps) : undefined
    const trace = { ...parsed, trace: liveTrace }
    const charts = extractCharts(trace.toolSteps)
    const status = String(data?.status || 'final')
    if (status === 'need_clarification' && data?.clarification) {
      const cl = data.clarification as Clarification
      setMessages([
        ...base,
        {
          role: 'assistant',
          content: String(cl.question || '请补充信息'),
          clarification: {
            type: cl.type,
            field: String(cl.field || 'value'),
            question: String(cl.question || ''),
            options: Array.isArray(cl.options) ? cl.options : [],
            entity: cl.entity,
            payload: cl.payload,
          },
          charts,
          ...trace,
        },
      ])
      return
    }
    const reply = typeof data?.message === 'string' ? data.message : String(data?.message ?? '')
    const sources = Array.isArray(data?.sources) ? data.sources.map((s: unknown) => String(s)) : undefined
    const actions = Array.isArray(data?.actions) ? (data.actions as HelpNavAction[]) : undefined
    setMessages([
      ...base,
      { role: 'assistant', content: reply || '（无内容）', sources, actions, charts, ...trace },
    ])
  }, [])

  const sendText = useCallback(
    async (text: string, opts?: { freshThread?: boolean }) => {
      const trimmed = text.trim()
      if (!trimmed || loading) return
      const cid = opts?.freshThread ? newConversationId() : conversationId
      const base = opts?.freshThread ? [] : messages
      if (opts?.freshThread) {
        setMessages([])
        setConversationId(cid)
      }
      const userMsg: ChatMessage = { role: 'user', content: trimmed }
      const nextMsgs = [...base, userMsg]
      setMessages(nextMsgs)
      setInput('')
      setLoading(true)
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const data = await runAgent({ conversationId: cid, message: trimmed }, controller.signal)
        applyAgentResponse(nextMsgs, data)
        void refreshConversations()
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          setMessages([...nextMsgs, { role: 'assistant', content: '⏹ 已停止生成。', trace: lastTraceRef.current ?? undefined }])
        } else {
          setMessages((prev) => (opts?.freshThread ? [] : prev.slice(0, -1)))
          showToast(e instanceof Error ? e.message : '发送失败，请检查网络或 AI 配置')
        }
      } finally {
        abortRef.current = null
        setLoading(false)
      }
    },
    [loading, messages, showToast, conversationId, applyAgentResponse, refreshConversations, runAgent],
  )

  const navStore = { ...navStoreBase, sendText }

  const invokeSkill = useCallback(
    (skill: AgentSkill) => {
      const fresh = messages.length > 0
      void sendText(skillQuickPrompt(skill), fresh ? { freshThread: true } : undefined)
    },
    [messages.length, sendText],
  )

  // 从 Skill 管理点击"对话"跳转而来：skills 加载后自动调用指定 skill
  useEffect(() => {
    if (!pendingChatSkill || skills.length === 0) return
    const target = skills.find((s) => s.name === pendingChatSkill)
    consumePendingChatSkill()
    if (target) invokeSkill(target)
    else showToast(`未找到可用的 Skill「${pendingChatSkill}」（可能未启用或无权限）`)
  }, [pendingChatSkill, skills, consumePendingChatSkill, invokeSkill, showToast])

  /** 通用：用户做出选择/确认 → 恢复对话 */
  const resumeWith = useCallback(
    async (msgIndex: number, field: string, value: string | number, bubble: string) => {
      if (loading) return
      const base: ChatMessage[] = messages.map((m, i) =>
        i === msgIndex ? { ...m, clarificationResolved: true } : m,
      )
      const withChoice = [...base, { role: 'user' as const, content: bubble }]
      setMessages(withChoice)
      setLoading(true)
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const data = await runAgent({ conversationId, resume: { field, value } }, controller.signal)
        applyAgentResponse(withChoice, data)
        void refreshConversations()
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          setMessages([...withChoice, { role: 'assistant', content: '⏹ 已停止生成。', trace: lastTraceRef.current ?? undefined }])
        } else {
          showToast(e instanceof Error ? e.message : '操作失败')
        }
      } finally {
        abortRef.current = null
        setLoading(false)
      }
    },
    [loading, messages, conversationId, applyAgentResponse, refreshConversations, showToast, runAgent],
  )

  const chooseOption = useCallback(
    (msgIndex: number, field: string, opt: ClarificationOption) =>
      resumeWith(msgIndex, field, opt.value, `已选择：${opt.label}`),
    [resumeWith],
  )

  const confirmSave = useCallback(
    (msgIndex: number, confirm: boolean) =>
      resumeWith(msgIndex, 'confirm', confirm ? 'confirm' : 'cancel', confirm ? '确认保存' : '取消'),
    [resumeWith],
  )

  const startNewChat = useCallback(() => {
    if (loading) return
    setMessages([])
    setInput('')
    setConversationId(newConversationId())
    setShowHistory(false)
  }, [loading])

  const openConversation = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const data = await apiFetch(`/ai/agent/conversations/${id}`)
      const rawMsgs: Array<{
        role?: string
        content?: unknown
        skillUsed?: string
        toolSteps?: AgentToolStep[]
      }> = Array.isArray(data?.messages) ? data.messages : []
      const msgs: ChatMessage[] = rawMsgs.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
        skillUsed: m.skillUsed,
        toolSteps: Array.isArray(m.toolSteps) ? m.toolSteps : undefined,
        charts: extractCharts(Array.isArray(m.toolSteps) ? m.toolSteps : undefined),
      }))
      setMessages(msgs)
      setConversationId(id)
      setShowHistory(false)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载会话失败')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  const deleteConversation = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await apiFetch(`/ai/agent/conversations/${id}`, { method: 'DELETE' })
        setConversations((prev) => prev.filter((c) => c.id !== id))
        if (id === conversationId) startNewChat()
      } catch {
        showToast('删除失败')
      }
    },
    [conversationId, startNewChat, showToast],
  )

  const send = useCallback(() => {
    if (quotedMsg) {
      const prefix = `> ${quotedMsg.text.slice(0, 100)}${quotedMsg.text.length > 100 ? '…' : ''}\n\n`
      void sendText(prefix + input)
      setQuotedMsg(null)
    } else {
      void sendText(input)
    }
  }, [input, sendText, quotedMsg])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const regenerate = useCallback(() => {
    // 找到最后一条用户消息，重新发送
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
    if (lastUserIdx < 0 || loading) return
    const lastUserMsg = messages[lastUserIdx].content
    // 移除最后一轮（最后的assistant回复）
    const trimmed = messages.slice(0, lastUserIdx)
    setMessages(trimmed)
    void sendText(lastUserMsg)
  }, [messages, loading, sendText])

  const clearChat = useCallback(() => {
    if (loading) return
    setMessages([])
    setConversationId(newConversationId())
    setFeedback({})
    setQuotedMsg(null)
    showToast('对话已清空')
  }, [loading, showToast])

  const copyMessage = useCallback((text: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('已复制')).catch(() => {
        fallbackCopy(text)
        showToast('已复制')
      })
    } else {
      fallbackCopy(text)
      showToast('已复制')
    }
  }, [showToast])

  // 斜杠命令：输入以 "/" 开头时，列出匹配的 Skill 供快速调用
  const slashActive = input.startsWith('/')
  const slashQuery = slashActive ? input.slice(1).trim().toLowerCase() : ''
  const slashMatches = slashActive
    ? skills.filter(
        (s) =>
          !slashQuery ||
          s.name.toLowerCase().includes(slashQuery) ||
          s.description.toLowerCase().includes(slashQuery),
      )
    : []
  const showSlashMenu = slashActive && skills.length > 0

  const selectSlashSkill = useCallback(
    (skill: AgentSkill) => {
      setInput('')
      invokeSkill(skill)
    },
    [invokeSkill],
  )

  return (
    <div className="flex flex-col bg-surface-2 min-h-[calc(100dvh-7.5rem)] max-w-2xl mx-auto md:max-w-none relative">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface/80">
        <button
          type="button"
          onClick={() => {
            setShowHistory((v) => !v)
            void refreshConversations()
          }}
          className="text-xs text-primary"
        >
          ☰ 历史对话
        </button>
        {skills.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowSkills((v) => !v)}
            className="text-xs text-muted"
          >
            AI 智能助手
            <span className="ml-1 text-accent">· {skills.length} 个 Skill</span>
          </button>
        ) : (
          <p className="text-xs text-muted">AI 智能助手</p>
        )}
        <button type="button" onClick={startNewChat} disabled={loading} className="text-xs text-primary disabled:text-subtle">
          + 新对话
        </button>
        <button type="button" onClick={clearChat} disabled={loading || messages.length === 0} className="text-xs text-danger disabled:text-subtle">
          清空
        </button>
      </div>
      <AgentStatusBadge variant="compact" />

      {showSkills && skills.length > 0 && (
        <div className="absolute inset-0 z-30 bg-black/20" onClick={() => setShowSkills(false)}>
          <div
            className="absolute left-3 right-3 top-12 max-h-[70vh] bg-surface shadow-xl rounded-xl p-3 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-fg-2">可用 Skill（{skills.length}）</span>
              <button type="button" onClick={() => setShowSkills(false)} className="text-xs text-subtle">
                关闭
              </button>
            </div>
            <p className="text-[10px] text-subtle mb-2">点击后将开启新对话并发送（确保 Skill 工作流完整加载）</p>
            <div className="space-y-2">
              {skills.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setShowSkills(false)
                    invokeSkill(s)
                  }}
                  className="w-full text-left rounded-xl border border-accent/25 bg-accent-soft/80 px-3 py-2.5 active:bg-accent-soft disabled:opacity-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-accent">{skillChipLabel(s)}</span>
                    {s.producesDocument && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-soft text-accent shrink-0">
                        文档
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-accent/70 mt-0.5 line-clamp-2">{s.description}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="absolute inset-0 z-30 bg-black/20" onClick={() => setShowHistory(false)}>
          <div
            className="absolute left-0 top-0 bottom-0 w-72 bg-surface shadow-xl p-3 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-fg-2">历史对话</span>
              <button onClick={startNewChat} className="text-xs text-primary">+ 新对话</button>
            </div>
            {conversations.length === 0 && <p className="text-xs text-subtle py-4 text-center">暂无历史</p>}
            {conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => void openConversation(c.id)}
                className={`group flex items-center justify-between gap-2 px-2 py-2 rounded-lg cursor-pointer text-sm ${
                  c.id === conversationId ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2 text-fg-2'
                }`}
              >
                <span className="truncate flex-1">{c.title}</span>
                <button
                  onClick={(e) => void deleteConversation(c.id, e)}
                  className="text-xs text-subtle hover:text-danger shrink-0"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 pb-40">
        {messages.length === 0 && (
          <div className="rounded-2xl bg-surface border border-line p-4 text-sm text-fg-2 shadow-sm space-y-3">
            <div>
              <p className="font-medium text-fg mb-1">我可以帮您</p>
              <p className="text-xs text-muted">
                知识问答（操作说明）、按权限查询报表数据（如客户销售额）。
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted mb-2">快捷提问</p>
              <div className="flex flex-wrap gap-2">
                {topics.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={loading}
                    onClick={() => void sendText(t.question)}
                    className="text-left text-xs px-3 py-2 rounded-full border border-primary/25 bg-primary-soft text-primary active:bg-primary-soft disabled:opacity-50"
                  >
                    {t.question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col w-full ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            {m.role === 'assistant' &&
              (m.trace && m.trace.steps.length > 0 && !m.degraded ? (
                <AgentLiveTrace
                  live={m.trace}
                  running={false}
                  totalMs={m.timings?.totalMs}
                  timings={m.timings}
                  skillUsed={m.skillUsed}
                />
              ) : (
                <AgentTracePanel
                  skillUsed={m.skillUsed}
                  toolSteps={m.toolSteps}
                  timings={m.timings}
                  degraded={m.degraded}
                />
              ))}
            <div
              className={
                (m.role === 'user' ? 'max-w-[88%] ' : 'max-w-full w-full ') +
                'rounded-2xl break-words ' +
                (m.role === 'user'
                  ? 'px-3 py-2.5 text-sm bg-primary text-white rounded-br-md whitespace-pre-wrap'
                  : 'px-3.5 py-3 text-sm bg-surface border border-line text-fg shadow-sm rounded-bl-md')
              }
            >
              {m.role === 'assistant' ? (
                <ChatMarkdown
                  content={m.content}
                  onDocDownload={(url) => downloadDocument(url).catch(() => showToast('下载失败'))}
                  charts={m.charts}
                />
              ) : (
                m.content
              )}
            </div>

            {m.role === 'assistant' &&
              m.clarification &&
              !m.clarificationResolved &&
              m.clarification.type === 'save_confirm' && (
                <div className="mt-2 max-w-[88%] w-full rounded-xl border border-warning/40 bg-warning-soft p-3">
                  <p className="text-xs font-medium text-warning mb-2">
                    即将保存到「{m.clarification.entity}」，请确认：
                  </p>
                  <div className="text-xs text-fg-2 space-y-1 mb-3">
                    {Object.entries(m.clarification.payload || {}).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-subtle shrink-0">{k}：</span>
                        <span className="break-all">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void confirmSave(i, true)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-success text-white active:bg-success disabled:opacity-50"
                    >
                      确认保存
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void confirmSave(i, false)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-line-strong text-fg-2 disabled:opacity-50"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

            {m.role === 'assistant' &&
              m.clarification &&
              !m.clarificationResolved &&
              m.clarification.type !== 'save_confirm' && (
                <div className="mt-2 flex flex-wrap gap-2 max-w-[88%]">
                  {m.clarification.options.length === 0 && (
                    <span className="text-xs text-subtle">（无候选项）</span>
                  )}
                  {m.clarification.options.map((opt, j) => (
                    <button
                      key={j}
                      type="button"
                      disabled={loading}
                      onClick={() => void chooseOption(i, m.clarification!.field, opt)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-warning/40 bg-warning-soft text-warning active:bg-warning-soft disabled:opacity-50"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}

            {m.role === 'assistant' &&
              bareDocUrls(m.content).map((url, j) => (
                <button
                  key={`doc-${j}`}
                  type="button"
                  onClick={() => downloadDocument(url).catch(() => showToast('下载失败'))}
                  className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-accent/40 bg-accent-soft text-accent active:bg-accent-soft"
                >
                  ⬇ 下载文档
                </button>
              ))}

            {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
              <p className="mt-1 text-[10px] text-subtle px-1 max-w-[88%]">参考：{m.sources.join(' · ')}</p>
            )}
            {m.role === 'assistant' && m.actions && m.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2 max-w-[88%]">
                {m.actions.map((action, j) => (
                  <button
                    key={j}
                    type="button"
                    onClick={() => runHelpNavAction(action, navStore)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-success/25 bg-success-soft text-success active:bg-success-soft"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}

            {m.role === 'assistant' && m.content && m.content !== '（无内容）' && (
              <div className="mt-1.5 flex items-center gap-0.5 px-0.5 text-[11px]">
                <button type="button" onClick={() => copyMessage(m.content)} className="px-1.5 py-0.5 rounded text-subtle hover:text-fg-2 hover:bg-surface-2">
                  复制
                </button>
                <button type="button" onClick={() => setQuotedMsg({ index: i, text: m.content.slice(0, 200) })} className="px-1.5 py-0.5 rounded text-subtle hover:text-fg-2 hover:bg-surface-2">
                  引用
                </button>
                {i === messages.length - 1 && (
                  <button type="button" onClick={regenerate} disabled={loading} className="px-1.5 py-0.5 rounded text-subtle hover:text-fg-2 hover:bg-surface-2 disabled:opacity-30">
                    重新生成
                  </button>
                )}
                <span className="mx-0.5 text-inverse-fg">|</span>
                <button
                  type="button"
                  onClick={() => setFeedback((f) => ({ ...f, [i]: f[i] === 'up' ? undefined! : 'up' }))}
                  className={`px-1.5 py-0.5 rounded ${feedback[i] === 'up' ? 'text-success bg-success-soft' : 'text-subtle hover:text-fg-2 hover:bg-surface-2'}`}
                >
                  有用
                </button>
                <button
                  type="button"
                  onClick={() => setFeedback((f) => ({ ...f, [i]: f[i] === 'down' ? undefined! : 'down' }))}
                  className={`px-1.5 py-0.5 rounded ${feedback[i] === 'down' ? 'text-danger bg-danger-soft' : 'text-subtle hover:text-fg-2 hover:bg-surface-2'}`}
                >
                  没用
                </button>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex flex-col items-start w-full gap-2">
            {live ? (
              <>
                <AgentLiveTrace live={live} />
                {stripActionsBlock(live.text).trim() && (
                  <div className="max-w-full w-full rounded-2xl rounded-bl-md px-3.5 py-3 text-sm bg-surface border border-line text-fg shadow-sm break-words">
                    <ChatMarkdown content={stripActionsBlock(live.text)} />
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-2xl rounded-bl-md bg-surface border border-line px-4 py-3 text-sm text-subtle shadow-sm">
                <span className="animate-pulse">正在处理…</span>
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div
        // 手机：停在底部 Tab 之上；PC：没有底部 Tab，贴底并让出左侧导航
        className="fixed left-0 right-0 lg:left-[var(--sidebar-w)] bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur"
      >
        <div className="max-w-2xl mx-auto md:max-w-none px-3 py-2">
          {quotedMsg && (
            <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border-l-2 border-primary/60 text-[11px] text-fg-2">
              <span className="flex-1 line-clamp-1">引用：{quotedMsg.text}</span>
              <button type="button" onClick={() => setQuotedMsg(null)} className="text-subtle hover:text-fg-2 shrink-0">✕</button>
            </div>
          )}
          {showSlashMenu && (
            <div className="mb-2 max-h-60 overflow-y-auto rounded-xl border border-accent/25 bg-surface shadow-lg">
              <div className="px-3 py-1.5 text-[10px] text-subtle border-b border-line sticky top-0 bg-surface">
                调用 Skill{slashQuery ? `（匹配「${slashQuery}」）` : ''} · 点击直接发起
              </div>
              {slashMatches.length === 0 ? (
                <div className="px-3 py-3 text-xs text-subtle">无匹配的 Skill</div>
              ) : (
                slashMatches.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    disabled={loading}
                    onClick={() => selectSlashSkill(s)}
                    className="w-full text-left px-3 py-2 border-b border-line last:border-0 hover:bg-accent-soft active:bg-accent-soft disabled:opacity-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-accent">/{s.name}</span>
                      {s.producesDocument && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-soft text-accent shrink-0">
                          文档
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted mt-0.5 line-clamp-1">{s.description}</p>
                  </button>
                ))
              )}
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (showSlashMenu) {
                    if (slashMatches.length > 0) selectSlashSkill(slashMatches[0])
                    return
                  }
                  send()
                } else if (e.key === 'Escape' && showSlashMenu) {
                  setInput('')
                }
              }}
              rows={2}
              maxLength={8000}
              placeholder="输入问题；输入 / 调用 Skill（如 /report-query）"
              disabled={loading}
              className="flex-1 resize-none rounded-xl border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 disabled:bg-surface-2"
            />
            <button
              type="button"
              onClick={() => {
                if (loading) {
                  stop()
                  return
                }
                if (showSlashMenu) {
                  if (slashMatches.length > 0) selectSlashSkill(slashMatches[0])
                  return
                }
                void send()
              }}
              disabled={loading ? false : !input.trim() || (showSlashMenu && slashMatches.length === 0)}
              className={
                'shrink-0 rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed ' +
                (loading ? 'bg-danger active:bg-danger' : 'bg-primary active:bg-primary-hover')
              }
            >
              {loading ? '⏹ 停止' : showSlashMenu ? '调用' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
