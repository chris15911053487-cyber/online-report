import { useStore } from '../store'
import { Home, Sparkles, MessageCircle, Settings, Bot } from 'lucide-react'
import type { ViewName } from '../types'

type Tab = { id: ViewName; label: string; icon: typeof Home }

/** 中间凸起的主入口（Agent），单独渲染 */
const centerTab: Tab = { id: 'agent-hub', label: 'Agent', icon: Bot }

const leftTabs: Tab[] = [
  { id: 'catalog', label: '菜单', icon: Home },
  { id: 'ai', label: 'AI', icon: Sparkles },
]

const rightTabs: Tab[] = [
  { id: 'messages', label: '消息', icon: MessageCircle },
  { id: 'settings', label: '设置', icon: Settings },
]

export default function BottomNav() {
  const { currentView, setView, messageSummary } = useStore()
  const unreadCount = messageSummary?.totalUnread || 0

  const renderTab = ({ id, label, icon: Icon }: Tab) => (
    <button
      key={id}
      data-nav-tab={id}
      data-voice-nav-label={label}
      onClick={() => setView(id)}
      className={`flex-1 flex flex-col items-center py-2 transition-colors ${
        currentView === id ? 'text-sky-600' : 'text-slate-400 hover:text-slate-600'
      }`}
    >
      <span className="relative">
        <Icon className="w-5 h-5 mb-0.5" />
        {id === 'messages' && unreadCount > 0 && (
          <span className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </span>
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  )

  const CenterIcon = centerTab.icon
  const centerActive = currentView === centerTab.id || currentView === 'agent-run'

  return (
    <nav
      className="bottom-nav fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex items-end justify-around py-1 z-50 max-w-2xl mx-auto shadow-[0_-1px_3px_rgba(0,0,0,0.1)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {leftTabs.map(renderTab)}

      {/* 中间凸起主入口 */}
      <div className="flex-1 flex flex-col items-center">
        <button
          data-nav-tab={centerTab.id}
          data-voice-nav-label={centerTab.label}
          onClick={() => setView(centerTab.id)}
          aria-label={centerTab.label}
          className={`-mt-6 w-14 h-14 rounded-full flex items-center justify-center text-white
            bg-gradient-to-br from-sky-500 to-indigo-600
            shadow-[0_6px_16px_rgba(79,110,247,0.45)]
            ring-4 ring-white active:scale-90 transition-transform
            ${centerActive ? 'from-sky-600 to-indigo-700' : ''}`}
        >
          <CenterIcon className="w-7 h-7" />
        </button>
        <span
          className={`text-[11px] font-medium mt-0.5 pb-2 ${
            centerActive ? 'text-indigo-600' : 'text-slate-400'
          }`}
        >
          {centerTab.label}
        </span>
      </div>

      {rightTabs.map(renderTab)}
    </nav>
  )
}
