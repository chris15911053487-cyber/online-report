import { useStore } from '../store'
import { Home, BrainCircuit, MessageCircle, Settings, Bot } from 'lucide-react'
import type { ViewName } from '../types'
import { cn } from '../ui/classes'

type Tab = { id: ViewName; label: string; icon: typeof Home }

/** 中间凸起的主入口（Agent），单独渲染 */
const centerTab: Tab = { id: 'agent-hub', label: 'Agent', icon: Bot }

const leftTabs: Tab[] = [
  { id: 'catalog', label: '工作台', icon: Home },
  { id: 'ai', label: 'AI 助手', icon: BrainCircuit },
]

const rightTabs: Tab[] = [
  { id: 'messages', label: '消息', icon: MessageCircle },
  { id: 'settings', label: '设置', icon: Settings },
]

/** 手机底部导航（PC 用侧边栏，见 Sidebar） */
export default function BottomNav() {
  const { currentView, setView, openWorkbench, messageSummary } = useStore()
  const unreadCount = messageSummary?.totalUnread || 0

  const renderTab = ({ id, label, icon: Icon }: Tab) => (
    <button
      key={id}
      data-nav-tab={id}
      data-voice-nav-label={label}
      onClick={() => (id === 'catalog' ? openWorkbench() : setView(id))}
      className={cn('flex-1 flex flex-col items-center py-2 transition-colors', currentView === id ? 'text-chrome-active' : 'text-chrome-muted hover:text-chrome-fg')}
    >
      <span className="relative">
        <Icon className="w-5 h-5 mb-0.5" />
        {id === 'messages' && unreadCount > 0 && (
          <span className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center leading-none">
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
    <nav className="fixed bottom-0 inset-x-0 z-50 bg-chrome border-t border-chrome-line flex items-end justify-around py-1 safe-bottom lg:hidden">
      {leftTabs.map(renderTab)}

      {/* 中间凸起主入口 */}
      <div className="flex-1 flex flex-col items-center">
        <button
          data-nav-tab={centerTab.id}
          data-voice-nav-label={centerTab.label}
          onClick={() => setView(centerTab.id)}
          aria-label={centerTab.label}
          className="-mt-6 w-14 h-14 rounded-full flex items-center justify-center text-primary-fg bg-ai shadow-lg shadow-primary/30 ring-4 ring-chrome active:scale-90 transition-transform"
        >
          <CenterIcon className="w-7 h-7" />
        </button>
        <span className={cn('text-[11px] font-medium mt-0.5 pb-2', centerActive ? 'text-chrome-active' : 'text-chrome-muted')}>{centerTab.label}</span>
      </div>

      {rightTabs.map(renderTab)}
    </nav>
  )
}
