import { useStore } from '../store'
import { Home, Sparkles, MessageCircle, Settings } from 'lucide-react'
import type { ViewName } from '../types'

const tabs: { id: ViewName; label: string; icon: typeof Home }[] = [
  { id: 'catalog', label: '菜单', icon: Home },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'messages', label: '消息', icon: MessageCircle },
  { id: 'settings', label: '设置', icon: Settings },
]

export default function BottomNav() {
  const { currentView, setView } = useStore()

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex items-center justify-around py-1 z-50 max-w-2xl mx-auto shadow-[0_-1px_3px_rgba(0,0,0,0.1)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          data-nav-tab={id}
          onClick={() => setView(id)}
          className={`flex-1 flex flex-col items-center py-2 transition-colors ${
            currentView === id
              ? 'text-sky-600'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <Icon className="w-5 h-5 mb-0.5" />
          <span className="text-[11px] font-medium">{label}</span>
        </button>
      ))}
    </nav>
  )
}
