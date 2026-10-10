import { useCallback, useEffect, useState } from 'react'
import { Bell, FileText } from 'lucide-react'
import { useStore } from '../../store'
import { apiFetch } from '../../utils/api'
import { fmtWallClock, SOURCE_LABELS } from '../../utils/messages'
import { Badge, Button, EmptyState, Segmented, Skeleton } from '../../ui'
import { cn } from '../../ui/classes'
import type { InboxItem } from '../../types'

const PAGE_SIZE = 30

/** 「消息」→「通知」：警报、定时报告推送到收件箱的内容，按时间倒序，点开看全文（即已读） */
export default function InboxList({ reloadKey }: { reloadKey: number }) {
  const { openMessage, fetchMessageSummary, showToast } = useStore()
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  // 结果带上请求的 key：切换筛选 / 刷新后 key 变了即显示加载中，不用在 effect 里先清空
  const reqKey = `${filter}|${reloadKey}`
  const [page, setPage] = useState<{ key: string; items: InboxItem[]; hasMore: boolean; error: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const loading = page?.key !== reqKey
  const items = page?.items ?? []
  const hasMore = page?.hasMore ?? false
  const error = page?.error ?? null
  const setItems = (fn: (prev: InboxItem[]) => InboxItem[]) => setPage((p) => (p ? { ...p, items: fn(p.items) } : p))
  const setHasMore = (v: boolean) => setPage((p) => (p ? { ...p, hasMore: v } : p))

  const query = useCallback(
    (before?: number) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (before) p.set('before', String(before))
      if (filter === 'unread') p.set('unread', '1')
      return apiFetch(`/messages/inbox?${p.toString()}`) as Promise<{ items: InboxItem[]; hasMore: boolean }>
    },
    [filter],
  )

  useEffect(() => {
    let cancelled = false
    query()
      .then((data) => {
        if (!cancelled) setPage({ key: reqKey, items: Array.isArray(data?.items) ? data.items : [], hasMore: !!data?.hasMore, error: null })
      })
      .catch((e: unknown) => {
        if (!cancelled) setPage({ key: reqKey, items: [], hasMore: false, error: e instanceof Error ? e.message : '加载失败' })
      })
    return () => {
      cancelled = true
    }
  }, [query, reqKey])

  const loadMore = async () => {
    const last = items[items.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const data = await query(last.id)
      setItems((prev) => [...prev, ...(Array.isArray(data?.items) ? data.items : [])])
      setHasMore(!!data?.hasMore)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoadingMore(false)
    }
  }

  const markAllRead = async () => {
    try {
      await apiFetch('/messages/inbox/read', { method: 'POST', body: JSON.stringify({ all: true }) })
      setItems((prev) => (filter === 'unread' ? [] : prev.map((i) => ({ ...i, read: true }))))
      setHasMore(filter === 'unread' ? false : hasMore)
      await fetchMessageSummary()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '标记已读失败')
    }
  }

  const open = (item: InboxItem) => {
    // 详情页打开即已读；列表先改，返回时不用重新加载
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)))
    openMessage(item.id)
  }

  const hasUnread = items.some((i) => !i.read)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Segmented
          size="sm"
          className="w-40"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'unread', label: '未读' },
          ]}
        />
        {hasUnread && (
          <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
            全部标为已读
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl bg-surface border border-line p-6 text-center text-sm text-danger">{error}</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl bg-surface border border-line">
          <EmptyState
            icon={<Bell className="w-5 h-5" />}
            title={filter === 'unread' ? '没有未读通知' : '暂无通知'}
            description="警报和定时报告推送给你的内容会出现在这里，同时也会发到钉钉"
          />
        </div>
      ) : (
        <div className="rounded-xl bg-surface border border-line overflow-hidden">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => open(item)}
              data-inbox-id={item.id}
              className="w-full flex items-start gap-3 px-4 py-3 text-left border-t border-line first:border-t-0 hover:bg-surface-2 transition-colors"
            >
              <span
                className={cn(
                  'mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                  item.sourceType === 'alert' ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary',
                )}
              >
                {item.sourceType === 'alert' ? <Bell className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  {!item.read && <span className="w-2 h-2 rounded-full bg-danger shrink-0" aria-label="未读" />}
                  <span className={cn('text-sm truncate', item.read ? 'text-fg-2' : 'text-fg font-semibold')}>{item.title}</span>
                </span>
                {item.preview && <span className="block text-xs text-muted truncate mt-0.5">{item.preview}</span>}
                <span className="flex items-center gap-2 mt-1 text-[11px] text-subtle">
                  <Badge tone={item.sourceType === 'alert' ? 'warning' : 'primary'}>{SOURCE_LABELS[item.sourceType] || '通知'}</Badge>
                  {item.sourceName && item.sourceName !== item.title && <span className="truncate">{item.sourceName}</span>}
                  <span className="num shrink-0 ml-auto">{fmtWallClock(item.createdAt)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!loading && hasMore && (
        <div className="text-center">
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? '加载中…' : '加载更多'}
          </Button>
        </div>
      )}
    </div>
  )
}
