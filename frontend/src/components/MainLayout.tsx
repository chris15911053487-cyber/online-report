import { useStore } from '../store'
import BottomNav from './BottomNav'
import CatalogView from '../views/CatalogView'
import DynamicReportView from '../views/DynamicReportView'
import SettingsView from '../views/SettingsView'

const viewComponents: Record<string, React.ComponentType> = {
  catalog: CatalogView,
  'dynamic-report': DynamicReportView,
  settings: SettingsView,
}

export default function MainLayout() {
  const { currentView, user } = useStore()
  
  const CurrentView = viewComponents[currentView] || CatalogView

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      {/* Top Bar - matching original design */}
      <header className="bg-slate-900 text-white sticky top-0 z-50">
        <div className="flex items-center justify-between px-4 py-3 max-w-2xl mx-auto">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => {/* handle back navigation */}}
              className="text-2xl w-8 h-8 flex items-center justify-center"
            >
              ←
            </button>
            <h1 className="text-xl font-semibold">生产报工</h1>
          </div>
          {user && (
            <div className="text-sm opacity-75">
              {user.displayName || user.username}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto">
        <CurrentView />
      </main>

      <BottomNav />
    </div>
  )
}
