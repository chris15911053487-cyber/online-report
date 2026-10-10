import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { Tabs } from '../ui'
import InboxList from '../components/messages/InboxList'
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

type MessageTab = 'inbox' | 'todo'
const TAB_KEY = 'online_report_messages_tab'

function readTab(): MessageTab | null {
  try {
    const v = sessionStorage.getItem(TAB_KEY)
    return v === 'inbox' || v === 'todo' ? v : null
  } catch {
    return null
  }
}

/** 「消息」：通知（警报、定时报告推送的内容）+ 待办（打开时按 SQL 现查的提醒） */
export default function MessagesView() {
  const { messageSummary, fetchMessageSummary, showToast } = useStore()
  const [tab, setTab] = useState<MessageTab>(() => readTab() ?? 'inbox')
  const [refreshing, setRefreshing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const changeTab = (t: MessageTab) => {
    setTab(t)
    try {
      sessionStorage.setItem(TAB_KEY, t)
    } catch {
      /* 不可写时只是不记住页签 */
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetchMessageSummary()
      setReloadKey((k) => k + 1)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  const inboxUnread = messageSummary?.inboxUnread || 0
  const todoUnread = messageSummary?.todoUnread || 0
  const count = (n: number) => (n > 0 ? <span className="ml-1 text-danger num">{n > 99 ? '99+' : n}</span> : null)

  return (
    <div className="p-4 space-y-3 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <Tabs
          value={tab}
          onChange={changeTab}
          className="flex-1"
          options={[
            { value: 'inbox', label: <>通知{count(inboxUnread)}</> },
            { value: 'todo', label: <>待办{count(todoUnread)}</> },
          ]}
        />
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex items-center gap-1 text-sm text-primary px-2 py-1 rounded hover:bg-primary-soft disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      {tab === 'inbox' ? <InboxList reloadKey={reloadKey} /> : <TodoRules reloadKey={reloadKey} />}
    </div>
  )
}

/** 待办：打开时按 SQL 现查的提醒规则（管理后台 →「消息提醒」配置），逐条标已读 */
function TodoRules({ reloadKey }: { reloadKey: number }) {
  const { messageSummary, fetchMessageSummary, showToast } = useStore()
  const [expandedRuleId, setExpandedRuleId] = useState<number | null>(null)
  const [ruleItems, setRuleItems] = useState<Record<number, RuleItemsState>>({})
  const [expandedItemKeys, setExpandedItemKeys] = useState<Set<string>>(new Set())

  const reloadExpanded = useCallback(async () => {
    try {
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
    }
  }, [expandedRuleId, showToast])

  // 顶部「刷新」：摘要由外层刷新，这里重新拉展开着的那条规则
  useEffect(() => {
    if (reloadKey > 0) void reloadExpanded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey])

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
  const todoUnread = messageSummary?.todoUnread || 0

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted">
        {todoUnread > 0 ? (
          <span className="text-danger font-medium">{todoUnread} 条未读</span>
        ) : (
          <span>暂无未读提醒</span>
        )}
        {messageSummary?.refreshedAt && (
          <span className="ml-2 text-xs">更新于 {formatTime(messageSummary.refreshedAt)}</span>
        )}
      </div>

      {rules.length === 0 && (
        <div className="rounded-xl bg-surface border border-line p-8 text-center text-subtle text-sm">
          暂无待办提醒
        </div>
      )}

      {rules.map((rule) => {
        const expanded = expandedRuleId === rule.id
        const detail = ruleItems[rule.id]
        return (
          <div key={rule.id} className="rounded-xl bg-surface border border-line shadow-sm overflow-hidden">
            <button
              onClick={() => void toggleRule(rule.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4 text-subtle shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-subtle shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-fg truncate">{rule.name}</div>
                <div className="text-xs text-subtle mt-0.5">
                  共 {rule.total} 条
                  {rule.fetchedAt ? ` · ${formatTime(rule.fetchedAt)}` : ''}
                </div>
              </div>
              {rule.error ? (
                <span className="text-xs text-danger shrink-0">查询失败</span>
              ) : rule.unread > 0 ? (
                <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-danger text-white text-xs font-medium flex items-center justify-center">
                  {rule.unread > 99 ? '99+' : rule.unread}
                </span>
              ) : (
                <span className="text-xs text-subtle shrink-0">已读</span>
              )}
            </button>

            {expanded && (
              <div className="border-t border-line px-4 py-3 bg-surface-2/50">
                {rule.error && (
                  <div className="text-sm text-danger mb-2">{rule.error}</div>
                )}
                {detail?.loading && (
                  <div className="text-sm text-subtle py-4 text-center">加载中...</div>
                )}
                {detail?.error && (
                  <div className="text-sm text-danger py-2">{detail.error}</div>
                )}
                {detail && !detail.loading && !detail.error && (
                  <>
                    {detail.items.length > 0 && detail.items.some((i) => i.unread) && (
                      <button
                        onClick={() => void markRead(rule.id, [], true)}
                        className="mb-3 text-xs text-primary hover:underline"
                      >
                        全部标为已读
                      </button>
                    )}
                    {detail.items.length === 0 ? (
                      <div className="text-sm text-subtle py-2 text-center">暂无数据</div>
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
                                  ? 'border-primary/25 bg-surface'
                                  : 'border-line bg-surface/80'
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                {item.unread && (
                                  <span className="mt-1.5 w-2 h-2 rounded-full bg-primary shrink-0" />
                                )}
                                <button
                                  onClick={() => toggleItemDetail(rule.id, item.key)}
                                  className="flex-1 text-left text-sm text-fg-2"
                                >
                                  {item.title}
                                </button>
                                {item.unread && (
                                  <button
                                    onClick={() => void markRead(rule.id, [item.key])}
                                    className="text-xs text-primary shrink-0 hover:underline"
                                  >
                                    标为已读
                                  </button>
                                )}
                              </div>
                              {showDetail && (
                                <div className="mt-2 pt-2 border-t border-line text-xs text-muted space-y-1">
                                  {(detail.columns.length ? detail.columns : Object.keys(item.row)).map(
                                    (col) => (
                                      <div key={col} className="flex gap-2">
                                        <span className="text-subtle shrink-0">{col}:</span>
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
