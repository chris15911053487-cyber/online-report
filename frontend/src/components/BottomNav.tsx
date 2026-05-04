import { useStore } from '../store'
import { Home, Star, MessageCircle, Settings } from 'lucide-react'

const tabs = [
  { id: 'catalog', label: '目录', icon: Home },
  { id: 'favorites', label: '常用', icon: Star },
  { id: 'messages', label: '消息', icon: MessageCircle },
  { id: 'settings', label: '设置', icon: Settings },
]

export default function BottomNav() {
  const { currentView, setView } = useStore()

  return (
    <nav className="bottom-nav fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 z-50 max-w-2xl mx-auto">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          data-nav-tab={id}
          onClick={() => setView(id)}
          className={`flex-1 flex flex-col items-center py-2 transition-colors ${
            currentView === id
              ? 'text-sky-600'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          <Icon className="w-6 h-6 mb-1" />
          <span className="text-xs font-medium">{label}</span>
        </button>
      ))}
    </nav>
  )
}
