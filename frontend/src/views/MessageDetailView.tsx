import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { fmtWallClock, SOURCE_LABELS } from '../utils/messages'
import { Badge, Button, EmptyState, Skeleton } from '../ui'
import ChatMarkdown from '../components/ChatMarkdown'
import type { InboxDetail } from '../types'

/** 按钮链接只放行 http(s) 与站内地址 */
const SAFE_LINK = /^(https?:\/\/|\/(?!\/))/i

/** 一条通知的全文（/messages/:id）：从「消息」列表或钉钉消息的「在系统中查看」进入，打开即已读 */
export default function MessageDetailView() {
  const { messageId, fetchMessageSummary, goBack } = useStore()
  // 结果带上 id：换了一条通知即显示加载中，不用在 effect 里先清空
  const [loaded, setLoaded] = useState<{ id: number; item: InboxDetail | null; error: string | null } | null>(null)
  const current = loaded && loaded.id === messageId ? loaded : null
  const item = current?.item ?? null
  const error = current?.error ?? null

  useEffect(() => {
    if (!messageId) return
    let cancelled = false
    apiFetch(`/messages/inbox/${messageId}`)
      .then((data) => {
        if (cancelled) return
        setLoaded({ id: messageId, item: data?.item ?? null, error: data?.item ? null : '通知不存在' })
        void fetchMessageSummary()
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded({ id: messageId, item: null, error: e instanceof Error ? e.message : '加载失败' })
      })
    return () => {
      cancelled = true
    }
  }, [messageId, fetchMessageSummary])

  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-xl bg-surface border border-line">
          <EmptyState
            title={error}
            action={
              <Button variant="secondary" size="sm" onClick={goBack}>
                返回消息
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="p-4 space-y-3 max-w-3xl">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  return (
    <div className="p-4 max-w-3xl">
      <article className="rounded-xl bg-surface border border-line p-4 lg:p-6 space-y-4">
        <header className="space-y-2">
          <h1 className="text-lg font-semibold text-fg leading-snug">{item.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={item.sourceType === 'alert' ? 'warning' : 'primary'}>{SOURCE_LABELS[item.sourceType] || '通知'}</Badge>
            {item.sourceName && item.sourceName !== item.title && <span>{item.sourceName}</span>}
            <span className="num">{fmtWallClock(item.createdAt)}</span>
          </div>
        </header>
        {item.body ? (
          <div className="text-sm text-fg-2">
            <ChatMarkdown content={item.body} raw />
          </div>
        ) : (
          <p className="text-sm text-subtle">（无正文）</p>
        )}
        {item.linkUrl && SAFE_LINK.test(item.linkUrl) && (
          <a
            href={item.linkUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-primary text-primary-fg text-sm font-medium hover:bg-primary-hover"
          >
            {item.linkTitle || '查看详情'}
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </article>
    </div>
  )
}
