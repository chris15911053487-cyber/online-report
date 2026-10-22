import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { Tabs } from '../ui'
import InboxList from '../components/messages/InboxList'
import TaskList from '../components/messages/TaskList'

/** 「消息」：通知（警报、定时报告、待办汇总推送的内容）+ 待办（规则按数据生成、归到每个人的事项） */
export default function MessagesView() {
  const { messageSummary, fetchMessageSummary, showToast, messagesTab, setMessagesTab } = useStore()
  const [refreshing, setRefreshing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

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
  const todoOpen = messageSummary?.todoOpen || 0
  const count = (n: number) => (n > 0 ? <span className="ml-1 text-danger num">{n > 99 ? '99+' : n}</span> : null)

  return (
    <div className="p-4 space-y-3 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <Tabs
          value={messagesTab}
          onChange={setMessagesTab}
          className="flex-1"
          options={[
            { value: 'inbox', label: <>通知{count(inboxUnread)}</> },
            { value: 'todo', label: <>待办{count(todoOpen)}</> },
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
      {messagesTab === 'inbox' ? <InboxList reloadKey={reloadKey} /> : <TaskList reloadKey={reloadKey} />}
    </div>
  )
}
