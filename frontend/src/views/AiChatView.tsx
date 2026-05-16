import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'

type ChatRole = 'user' | 'assistant'

interface ChatMessage {
  role: ChatRole
  content: string
}

export default function AiChatView() {
  const { showToast } = useStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    const userMsg: ChatMessage = { role: 'user', content: text }
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
      setMessages([...nextMsgs, { role: 'assistant', content: reply || '（无内容）' }])
    } catch (e: any) {
      setMessages((prev) => prev.slice(0, -1))
      showToast(e?.message || '发送失败，请检查网络或 AI 配置')
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, showToast])

  const clearChat = useCallback(() => {
    if (loading) return
    setMessages([])
    setInput('')
  }, [loading])

  return (
    <div className="flex flex-col bg-slate-50 min-h-[calc(100dvh-7.5rem)] max-w-2xl mx-auto relative">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white/80">
        <p className="text-xs text-slate-500">
          生产报工与报表相关问答（需服务端配置 AI Key）
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

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 pb-36">
        {messages.length === 0 && (
          <div className="rounded-2xl bg-white border border-slate-100 p-4 text-sm text-slate-600 shadow-sm">
            <p className="font-medium text-slate-800 mb-2">我可以帮您</p>
            <ul className="list-disc list-inside space-y-1 text-slate-600">
              <li>理解报工、接单、合并报工等流程</li>
              <li>说明报表筛选与常见操作思路</li>
              <li>讨论生产现场管理与数据指标</li>
            </ul>
            <p className="mt-3 text-xs text-slate-400">
              输入问题后点击发送；内容由 AI 生成，请以实际业务与系统为准。
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
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
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
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
