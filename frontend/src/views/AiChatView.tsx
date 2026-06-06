import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { apiFetch, apiUrl, authHeaders } from '../utils/api'
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

const DOC_URL_RE = /\/ai\/agent\/documents\/doc-[0-9a-f]+/g

/** 提取助手消息里的文档下载链接 */
function extractDocUrls(text: string): string[] {
  const found = text.match(DOC_URL_RE)
  if (!found) return []
  return Array.from(new Set(found))
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

export default function AiChatView() {
  const { showToast, setView, navigateTo, navMenus, openProSign } = useStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [topics, setTopics] = useState<HelpTopic[]>(FALLBACK_TOPICS)
  const [conversationId, setConversationId] = useState<string>(() => newConversationId())
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    let cancelled = false
    apiFetch('/ai/help/bootstrap')
      .then((data) => {
        if (cancelled) return
        if (Array.isArray(data?.topics) && data.topics.length > 0) setTopics(data.topics)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const navStore = { setView, navigateTo, navMenus, openProSign, showToast }

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
    const status = String(data?.status || 'final')
    if (status === 'need_clarification' && data?.clarification) {
      const cl = data.clarification as Clarification
      setMessages([
        ...base,
        {
          role: 'assistant',
          content: String(cl.question || '请补充信息'),
          clarification: {
            field: String(cl.field || 'value'),
            question: String(cl.question || ''),
            options: Array.isArray(cl.options) ? cl.options : [],
          },
        },
      ])
      return
    }
    const reply = typeof data?.message === 'string' ? data.message : String(data?.message ?? '')
    const sources = Array.isArray(data?.sources) ? data.sources.map((s: unknown) => String(s)) : undefined
    const actions = Array.isArray(data?.actions) ? (data.actions as HelpNavAction[]) : undefined
    setMessages([...base, { role: 'assistant', content: reply || '（无内容）', sources, actions }])
  }, [])

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || loading) return
      const userMsg: ChatMessage = { role: 'user', content: trimmed }
      const nextMsgs = [...messages, userMsg]
      setMessages(nextMsgs)
      setInput('')
      setLoading(true)
      try {
        const data = await apiFetch('/ai/agent/chat', {
          method: 'POST',
          body: JSON.stringify({ conversationId, message: trimmed }),
        })
        applyAgentResponse(nextMsgs, data)
        void refreshConversations()
      } catch (e: unknown) {
        setMessages((prev) => prev.slice(0, -1))
        showToast(e instanceof Error ? e.message : '发送失败，请检查网络或 AI 配置')
      } finally {
        setLoading(false)
      }
    },
    [loading, messages, showToast, conversationId, applyAgentResponse, refreshConversations],
  )

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
      try {
        const data = await apiFetch('/ai/agent/chat', {
          method: 'POST',
          body: JSON.stringify({ conversationId, resume: { field, value } }),
        })
        applyAgentResponse(withChoice, data)
        void refreshConversations()
      } catch (e: unknown) {
        showToast(e instanceof Error ? e.message : '操作失败')
      } finally {
        setLoading(false)
      }
    },
    [loading, messages, conversationId, applyAgentResponse, refreshConversations, showToast],
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
      const rawMsgs: Array<{ role?: string; content?: unknown }> = Array.isArray(data?.messages)
        ? data.messages
        : []
      const msgs: ChatMessage[] = rawMsgs.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
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

  const send = useCallback(() => void sendText(input), [input, sendText])

  return (
    <div className="flex flex-col bg-slate-50 min-h-[calc(100dvh-7.5rem)] max-w-2xl mx-auto relative">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white/80">
        <button
          type="button"
          onClick={() => {
            setShowHistory((v) => !v)
            void refreshConversations()
          }}
          className="text-xs text-sky-600"
        >
          ☰ 历史对话
        </button>
        <p className="text-xs text-slate-500">AI 智能助手</p>
        <button type="button" onClick={startNewChat} disabled={loading} className="text-xs text-sky-600 disabled:text-slate-300">
          + 新对话
        </button>
      </div>

      {showHistory && (
        <div className="absolute inset-0 z-30 bg-black/20" onClick={() => setShowHistory(false)}>
          <div
            className="absolute left-0 top-0 bottom-0 w-72 bg-white shadow-xl p-3 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-700">历史对话</span>
              <button onClick={startNewChat} className="text-xs text-sky-600">+ 新对话</button>
            </div>
            {conversations.length === 0 && <p className="text-xs text-slate-400 py-4 text-center">暂无历史</p>}
            {conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => void openConversation(c.id)}
                className={`group flex items-center justify-between gap-2 px-2 py-2 rounded-lg cursor-pointer text-sm ${
                  c.id === conversationId ? 'bg-sky-50 text-sky-800' : 'hover:bg-slate-50 text-slate-700'
                }`}
              >
                <span className="truncate flex-1">{c.title}</span>
                <button
                  onClick={(e) => void deleteConversation(c.id, e)}
                  className="text-xs text-slate-300 hover:text-red-500 shrink-0"
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
          <div className="rounded-2xl bg-white border border-slate-100 p-4 text-sm text-slate-600 shadow-sm space-y-3">
            <div>
              <p className="font-medium text-slate-800 mb-1">我可以帮您</p>
              <p className="text-xs text-slate-500">
                知识问答（操作说明）、按权限查询报表数据（如客户销售额）。涉及多个同名客户时会让您确认。
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 mb-2">快捷提问</p>
              <div className="flex flex-wrap gap-2">
                {topics.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={loading}
                    onClick={() => void sendText(t.question)}
                    className="text-left text-xs px-3 py-2 rounded-full border border-sky-200 bg-sky-50 text-sky-800 active:bg-sky-100 disabled:opacity-50"
                  >
                    {t.question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div
              className={
                'max-w-[88%] rounded-2xl px-3 py-2.5 text-sm whitespace-pre-wrap break-words ' +
                (m.role === 'user'
                  ? 'bg-sky-600 text-white rounded-br-md'
                  : 'bg-white border border-slate-100 text-slate-800 shadow-sm rounded-bl-md')
              }
            >
              {m.content}
            </div>

            {m.role === 'assistant' &&
              m.clarification &&
              !m.clarificationResolved &&
              m.clarification.type === 'save_confirm' && (
                <div className="mt-2 max-w-[88%] w-full rounded-xl border border-amber-300 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-800 mb-2">
                    即将保存到「{m.clarification.entity}」，请确认：
                  </p>
                  <div className="text-xs text-slate-700 space-y-1 mb-3">
                    {Object.entries(m.clarification.payload || {}).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-slate-400 shrink-0">{k}：</span>
                        <span className="break-all">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void confirmSave(i, true)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white active:bg-emerald-700 disabled:opacity-50"
                    >
                      确认保存
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void confirmSave(i, false)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 disabled:opacity-50"
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
                    <span className="text-xs text-slate-400">（无候选项）</span>
                  )}
                  {m.clarification.options.map((opt, j) => (
                    <button
                      key={j}
                      type="button"
                      disabled={loading}
                      onClick={() => void chooseOption(i, m.clarification!.field, opt)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 active:bg-amber-100 disabled:opacity-50"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}

            {m.role === 'assistant' &&
              extractDocUrls(m.content).map((url, j) => (
                <button
                  key={`doc-${j}`}
                  type="button"
                  onClick={() => downloadDocument(url).catch(() => showToast('下载失败'))}
                  className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-violet-300 bg-violet-50 text-violet-700 active:bg-violet-100"
                >
                  ⬇ 下载文档
                </button>
              ))}

            {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
              <p className="mt-1 text-[10px] text-slate-400 px-1 max-w-[88%]">参考：{m.sources.join(' · ')}</p>
            )}
            {m.role === 'assistant' && m.actions && m.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2 max-w-[88%]">
                {m.actions.map((action, j) => (
                  <button
                    key={j}
                    type="button"
                    onClick={() => runHelpNavAction(action, navStore)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 active:bg-emerald-100"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-white border border-slate-100 px-4 py-3 text-sm text-slate-400 shadow-sm">
              <span className="inline-flex gap-1">
                <span className="animate-pulse">正在思考</span>
                <span className="animate-bounce">…</span>
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div
        className="fixed left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur"
        style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="max-w-2xl mx-auto px-3 py-2">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              rows={2}
              maxLength={8000}
              placeholder="例如：查一下张三客户今年的销售订单额"
              disabled={loading}
              className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300 disabled:bg-slate-50"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={loading || !input.trim()}
              className="shrink-0 rounded-xl bg-sky-600 text-white px-4 py-2 text-sm font-medium active:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
