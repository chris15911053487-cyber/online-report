import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import type { MessageAlertItem } from '../types'

interface RuleItemsState {
  loading: boolean
  items: MessageAlertItem[]
  columns: string[]
  error: string | null
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function MessagesView() {
  const { messageSummary, fetchMessageSummary, showToast } = useStore()
  const [refreshing, setRefreshing] = useState(false)
  const [expandedRuleId, setExpandedRuleId] = useState<number | null>(null)
  const [ruleItems, setRuleItems] = useState<Record<number, RuleItemsState>>({})
  const [expandedItemKeys, setExpandedItemKeys] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await fetchMessageSummary()
      if (expandedRuleId != null) {
        setRuleItems((prev) => ({
          ...prev,
          [expandedRuleId]: { ...prev[expandedRuleId], loading: true },
        }))
        const data = await apiFetch(`/messages/rules/${expandedRuleId}/items`)
        setRuleItems((prev) => ({
          ...prev,
          [expandedRuleId]: {
            loading: false,
            items: Array.isArray(data?.items) ? data.items : [],
            columns: Array.isArray(data?.columns) ? data.columns : [],
            error: null,
          },
        }))
      }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [expandedRuleId, fetchMessageSummary, showToast])

  useEffect(() => {
    void fetchMessageSummary()
  }, [fetchMessageSummary])

  const loadRuleItems = async (ruleId: number) => {
    setRuleItems((prev) => ({
      ...prev,
      [ruleId]: { loading: true, items: [], columns: [], error: null },
    }))
    try {
      const data = await apiFetch(`/messages/rules/${ruleId}/items`)
      setRuleItems((prev) => ({
        ...prev,
        [ruleId]: {
          loading: false,
          items: Array.isArray(data?.items) ? data.items : [],
          columns: Array.isArray(data?.columns) ? data.columns : [],
          error: null,
        },
      }))
    } catch (e: unknown) {
      setRuleItems((prev) => ({
        ...prev,
        [ruleId]: {
          loading: false,
          items: [],
          columns: [],
          error: e instanceof Error ? e.message : '加载失败',
        },
      }))
    }
  }

  const toggleRule = async (ruleId: number) => {
    if (expandedRuleId === ruleId) {
      setExpandedRuleId(null)
      return
    }
    setExpandedRuleId(ruleId)
    if (!ruleItems[ruleId]) {
      await loadRuleItems(ruleId)
    }
  }

  const markRead = async (ruleId: number, keys: string[], all = false) => {
    try {
      await apiFetch(`/messages/rules/${ruleId}/read`, {
        method: 'POST',
        body: JSON.stringify(all ? { all: true } : { keys }),
      })
      await fetchMessageSummary()
      await loadRuleItems(ruleId)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '标记已读失败')
    }
  }

  const toggleItemDetail = (ruleId: number, key: string) => {
    const id = `${ruleId}:${key}`
    setExpandedItemKeys((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rules = messageSummary?.rules || []
  const totalUnread = messageSummary?.totalUnread || 0

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">
          {totalUnread > 0 ? (
            <span className="text-rose-600 font-medium">{totalUnread} 条未读</span>
          ) : (
            <span>暂无未读提醒</span>
          )}
          {messageSummary?.refreshedAt && (
            <span className="ml-2 text-xs">更新于 {formatTime(messageSummary.refreshedAt)}</span>
          )}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex items-center gap-1 text-sm text-sky-600 px-2 py-1 rounded hover:bg-sky-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {rules.length === 0 && (
        <div className="rounded-xl bg-white border border-slate-100 p-8 text-center text-slate-400 text-sm">
          暂无数据提醒
        </div>
      )}

      {rules.map((rule) => {
        const expanded = expandedRuleId === rule.id
        const detail = ruleItems[rule.id]
        return (
          <div key={rule.id} className="rounded-xl bg-white border border-slate-100 shadow-sm overflow-hidden">
            <button
              onClick={() => void toggleRule(rule.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 truncate">{rule.name}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  共 {rule.total} 条
                  {rule.fetchedAt ? ` · ${formatTime(rule.fetchedAt)}` : ''}
                </div>
              </div>
              {rule.error ? (
                <span className="text-xs text-rose-500 shrink-0">查询失败</span>
              ) : rule.unread > 0 ? (
                <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-xs font-medium flex items-center justify-center">
                  {rule.unread > 99 ? '99+' : rule.unread}
                </span>
              ) : (
                <span className="text-xs text-slate-300 shrink-0">已读</span>
              )}
            </button>

            {expanded && (
              <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/50">
                {rule.error && (
                  <div className="text-sm text-rose-600 mb-2">{rule.error}</div>
                )}
                {detail?.loading && (
                  <div className="text-sm text-slate-400 py-4 text-center">加载中...</div>
                )}
                {detail?.error && (
                  <div className="text-sm text-rose-600 py-2">{detail.error}</div>
                )}
                {detail && !detail.loading && !detail.error && (
                  <>
                    {detail.items.length > 0 && detail.items.some((i) => i.unread) && (
                      <button
                        onClick={() => void markRead(rule.id, [], true)}
                        className="mb-3 text-xs text-sky-600 hover:underline"
                      >
                        全部标为已读
                      </button>
                    )}
                    {detail.items.length === 0 ? (
                      <div className="text-sm text-slate-400 py-2 text-center">暂无数据</div>
                    ) : (
                      <ul className="space-y-2">
                        {detail.items.map((item) => {
                          const itemId = `${rule.id}:${item.key}`
                          const showDetail = expandedItemKeys.has(itemId)
                          return (
                            <li
                              key={item.key}
                              className={`rounded-lg border px-3 py-2 ${
                                item.unread
                                  ? 'border-sky-200 bg-white'
                                  : 'border-slate-100 bg-white/80'
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                {item.unread && (
                                  <span className="mt-1.5 w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                                )}
                                <button
                                  onClick={() => toggleItemDetail(rule.id, item.key)}
                                  className="flex-1 text-left text-sm text-slate-700"
                                >
                                  {item.title}
                                </button>
                                {item.unread && (
                                  <button
                                    onClick={() => void markRead(rule.id, [item.key])}
                                    className="text-xs text-sky-600 shrink-0 hover:underline"
                                  >
                                    标为已读
                                  </button>
                                )}
                              </div>
                              {showDetail && (
                                <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500 space-y-1">
                                  {(detail.columns.length ? detail.columns : Object.keys(item.row)).map(
                                    (col) => (
                                      <div key={col} className="flex gap-2">
                                        <span className="text-slate-400 shrink-0">{col}:</span>
                                        <span className="break-all">
                                          {item.row[col] == null ? '-' : String(item.row[col])}
                                        </span>
                                      </div>
                                    ),
                                  )}
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
