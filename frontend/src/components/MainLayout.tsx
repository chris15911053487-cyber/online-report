import { useStore } from '../store'
import BottomNav from './BottomNav'
import CatalogView from '../views/CatalogView'
import DynamicReportView from '../views/DynamicReportView'
import SettingsView from '../views/SettingsView'
import MenuSettingsView from '../views/MenuSettingsView'
import OworView from '../views/OworView'
import OrdersView from '../views/OrdersView'
import DetailView from '../views/DetailView'
import ReportRowDetailView from '../views/ReportRowDetailView'
import ProSignReceiveView from '../views/ProSignReceiveView'
import WorkRegistrationView from '../views/WorkRegistrationView'
import AiChatView from '../views/AiChatView'
import type { ViewName } from '../types'
import { isReturnProRoute } from '../views/ReturnProPickDetail'

const rootTabs: ViewName[] = ['catalog', 'ai', 'messages', 'settings']

function MessagesView() {
  return <div className="p-4 py-16 text-center text-slate-400">消息将显示在这里</div>
}

const viewComponents: Record<string, React.ComponentType> = {
  catalog: CatalogView,
  ai: AiChatView,
  messages: MessagesView,
  settings: SettingsView,
  'dynamic-report': DynamicReportView,
  'menu-settings': MenuSettingsView,
  owor: OworView,
  orders: OrdersView,
  detail: DetailView,
  'report-row-detail': ReportRowDetailView,
  'pro-sign-receive': ProSignReceiveView,
  'work-registration': WorkRegistrationView,
}

function getPageTitle(
  view: ViewName,
  activeMenuLabel?: string,
  proSignMergeButtonLabel?: string,
  reportDetailRouteKey?: string,
): string {
  const titles: Record<string, string> = {
    catalog: '菜单',
    ai: 'AI 助手',
    messages: '消息',
    settings: '设置',
    owor: '生产订单',
    orders: '报工订单',
    'menu-settings': '菜单设置',
    detail: '订单报工',
    'report-row-detail': '行详情',
    'work-registration': '报工登记',
  }
  if (view === 'dynamic-report') {
    return activeMenuLabel || '报表'
  }
  if (view === 'pro-sign-receive') {
    return '合并报工·' + (proSignMergeButtonLabel || '接单')
  }
  if (view === 'report-row-detail' && isReturnProRoute(reportDetailRouteKey)) {
    return '领料明细'
  }
  return titles[view] || '生产报工'
}

export default function MainLayout() {
  const {
    currentView,
    user,
    goBack,
    activeMenu,
    proSignMergeButtonLabel,
    proSignMode,
    reportDetailRouteKey,
  } = useStore()

  const isRootTab = rootTabs.includes(currentView)
  const showBackButton = !isRootTab
  const showBottomNav = isRootTab
  const title = getPageTitle(
    currentView,
    activeMenu?.label,
    proSignMergeButtonLabel,
    reportDetailRouteKey,
  )

  const CurrentView = viewComponents[currentView] || CatalogView

  /** 合并报工页仍挂载列表报表（display:none），避免返回时 DynamicReportView 卸载导致筛选条件被初始化逻辑重置 */
  const dynamicReportVisible = currentView === 'dynamic-report'
  const dynamicReportShellHidden =
    activeMenu != null && proSignMode && currentView === 'pro-sign-receive'

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white sticky top-0 z-50">
        <div className="flex items-center px-4 py-3 max-w-2xl mx-auto">
          {showBackButton && (
            <button
              onClick={goBack}
              className="text-xl w-8 h-8 flex items-center justify-center mr-2 active:scale-90 transition-transform"
              aria-label="返回"
            >
              ←
            </button>
          )}
          <h1 className="text-lg font-semibold flex-1 truncate">{title}</h1>
          {user && (
            <div className="text-sm opacity-60 ml-2 truncate max-w-[100px]">
              {user.displayName || user.username}
            </div>
          )}
        </div>
      </header>

      <main className={`max-w-2xl mx-auto ${showBottomNav ? 'pb-16' : 'pb-4'}`}>
        {(dynamicReportVisible || dynamicReportShellHidden) && (
          <div
            className={dynamicReportShellHidden ? 'hidden' : undefined}
            aria-hidden={dynamicReportShellHidden}
          >
            <DynamicReportView />
          </div>
        )}
        {!dynamicReportVisible && <CurrentView />}
      </main>

      {showBottomNav && <BottomNav />}
    </div>
  )
}
