import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { runHelpNavAction, type HelpNavAction } from '../utils/helpActions'

type ChatRole = 'user' | 'assistant'

interface ChatMessage {
  role: ChatRole
  content: string
  sources?: string[]
  actions?: HelpNavAction[]
}

interface HelpTopic {
  id: string
  question: string
  keywords?: string[]
}

const FALLBACK_TOPICS: HelpTopic[] = [
  { id: 'password', question: '如何修改密码？' },
  { id: 'pro-sign-receive', question: '生产报工怎么接单？' },
  { id: 'pro-sign-complete', question: '待完工怎么报工、怎么暂停？' },
  { id: 'pro-sign-resume', question: '暂停报工之后怎么操作？' },
  { id: 'status-codes', question: 'Status 0、1、8 分别是什么意思？' },
]

export default function AiChatView() {
  const { showToast, setView, navigateTo, navMenus, openProSign } = useStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [topics, setTopics] = useState<HelpTopic[]>(FALLBACK_TOPICS)
  const [helpVersion, setHelpVersion] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    let cancelled = false
    apiFetch('/ai/help/bootstrap')
      .then((data) => {
        if (cancelled) return
        if (Array.isArray(data?.topics) && data.topics.length > 0) {
          setTopics(data.topics)
        }
        if (data?.version) setHelpVersion(String(data.version))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const navStore = { setView, navigateTo, navMenus, openProSign, showToast }

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
        const data = await apiFetch('/ai/chat', {
          method: 'POST',
          body: JSON.stringify({ messages: nextMsgs }),
        })
        const reply =
          typeof data?.message === 'string' ? data.message : String(data?.message ?? '')
        const sources = Array.isArray(data?.sources)
          ? data.sources.map((s: unknown) => String(s))
          : undefined
        const actions = Array.isArray(data?.actions) ? (data.actions as HelpNavAction[]) : undefined
        if (data?.helpVersion) setHelpVersion(String(data.helpVersion))

        setMessages([
          ...nextMsgs,
          {
            role: 'assistant',
            content: reply || '（无内容）',
            sources,
            actions,
          },
        ])
      } catch (e: unknown) {
        setMessages((prev) => prev.slice(0, -1))
        const msg = e instanceof Error ? e.message : '发送失败，请检查网络或 AI 配置'
        showToast(msg)
      } finally {
        setLoading(false)
      }
    },
    [loading, messages, showToast],
  )

  const send = useCallback(() => {
    void sendText(input)
  }, [input, sendText])

  const clearChat = useCallback(() => {
    if (loading) return
    setMessages([])
    setInput('')
  }, [loading])

  const onQuickTopic = (question: string) => {
    void sendText(question)
  }

  return (
    <div className="flex flex-col bg-slate-50 min-h-[calc(100dvh-7.5rem)] max-w-2xl mx-auto relative">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white/80">
        <p className="text-xs text-slate-500">
          系统使用说明助手
          {helpVersion ? ` · 文档 ${helpVersion}` : ''}
        </p>
        <button
          type="button"
          onClick={clearChat}
          disabled={loading || messages.length === 0}
          className="text-xs text-sky-600 disabled:text-slate-300 disabled:cursor-not-allowed"
        >
          清空
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 pb-40">
        {messages.length === 0 && (
          <div className="rounded-2xl bg-white border border-slate-100 p-4 text-sm text-slate-600 shadow-sm space-y-3">
            <div>
              <p className="font-medium text-slate-800 mb-1">我可以帮您</p>
              <p className="text-xs text-slate-500">
                根据内置使用说明回答：改密码、生产报工、暂停与恢复、报表查询等。回答依据说明书，不编造菜单。
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
                    onClick={() => onQuickTopic(t.question)}
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
          <div
            key={i}
            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
          >
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
            {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
              <p className="mt-1 text-[10px] text-slate-400 px-1 max-w-[88%]">
                参考：{m.sources.join(' · ')}
              </p>
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
                <span className="animate-pulse">正在查阅说明并思考</span>
                <span className="animate-bounce">…</span>
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div
        className="fixed left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur"
        style={{
          bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))',
        }}
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
              placeholder="例如：如何修改密码？暂停后怎么恢复报工？"
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
