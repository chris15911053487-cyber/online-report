import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useStore } from '../store'
import BottomNav from './BottomNav'
import Sidebar from './Sidebar'
import { ADMIN_VIEWS } from './adminEntries'
import CatalogView from '../views/CatalogView'
import DynamicReportView from '../views/DynamicReportView'
import SettingsView from '../views/SettingsView'
import MenuSettingsView from '../views/MenuSettingsView'
import ReportRowDetailView from '../views/ReportRowDetailView'
import ProSignReceiveView from '../views/ProSignReceiveView'
import ProSignOrderDetailView from '../views/ProSignOrderDetailView'
import WorkRegistrationView from '../views/WorkRegistrationView'
import AiChatView from '../views/AiChatView'
import AiSkillsView from '../views/AiSkillsView'
import AgentHubView from '../views/AgentHubView'
import AgentsAdminView from '../views/AgentsAdminView'
import BiAdminView from '../views/BiAdminView'
import AgentRunView from '../views/AgentRunView'
import MessagesView from '../views/MessagesView'
import MessageAlertSettingsView from '../views/MessageAlertSettingsView'
import ScheduledReportsView from '../views/ScheduledReportsView'
import AlertPushView from '../views/AlertPushView'
import AdminHubView from '../views/AdminHubView'
import HelpView from '../views/HelpView'
import HelpDocView from '../views/HelpDocView'
import { useIsPc } from '../hooks/useMediaQuery'
import type { ViewName } from '../types'
import { isReturnProRoute } from '../views/ReturnProPickDetail'

/** 一级页面：手机显示底栏、不显示返回；PC 不显示返回 */
const rootTabs: ViewName[] = ['catalog', 'ai', 'agent-hub', 'messages', 'settings', 'admin']

const viewComponents: Record<string, React.ComponentType> = {
  catalog: CatalogView,
  ai: AiChatView,
  'agent-hub': AgentHubView,
  'agent-run': AgentRunView,
  'agents-admin': AgentsAdminView,
  'bi-admin': BiAdminView,
  messages: MessagesView,
  settings: SettingsView,
  'dynamic-report': DynamicReportView,
  'menu-settings': MenuSettingsView,
  'ai-skills': AiSkillsView,
  'message-alert-settings': MessageAlertSettingsView,
  'scheduled-reports': ScheduledReportsView,
  'alert-push': AlertPushView,
  admin: AdminHubView,
  help: HelpView,
  'help-doc': HelpDocView,
  'report-row-detail': ReportRowDetailView,
  'pro-sign-receive': ProSignReceiveView,
  'pro-sign-order-detail': ProSignOrderDetailView,
  'work-registration': WorkRegistrationView,
}

function getPageTitle(
  view: ViewName,
  activeMenuLabel?: string,
  proSignMergeButtonLabel?: string,
  reportDetailRouteKey?: string,
): string {
  const titles: Record<string, string> = {
    catalog: '工作台',
    admin: '管理后台',
    ai: 'AI 助手',
    'agent-hub': 'Agent',
    'agent-run': 'Agent',
    'agents-admin': 'Agent 配置',
    'bi-admin': 'BI 看板管理',
    messages: '消息',
    settings: '设置',
    help: '使用说明',
    'help-doc': '使用说明',
    'menu-settings': '菜单与角色',
    'ai-skills': 'AI Skill 管理',
    'message-alert-settings': '消息提醒',
    'scheduled-reports': '定时报告',
    'alert-push': '警报推送',
    'report-row-detail': '行详情',
    'work-registration': '报工登记',
    'pro-sign-order-detail': '订单详情',
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

/** PC 侧边栏收起：用户点过就记住（本机）；没选过时 Agent 运行页默认收起，给看板让出宽度 */
const SIDEBAR_KEY = 'online_report_sidebar_collapsed'

function readSidebarPref(): boolean | null {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

export default function MainLayout() {
  const {
    currentView,
    user,
    goBack,
    setView,
    activeMenu,
    proSignMergeButtonLabel,
    proSignMode,
    reportDetailRouteKey,
    currentAgentLabel,
    helpDocTitle,
    fetchMessageSummary,
    messageSummary,
    isAuthenticated,
  } = useStore()
  const [sidebarPref, setSidebarPref] = useState<boolean | null>(readSidebarPref)
  const sidebarCollapsed = sidebarPref ?? currentView === 'agent-run'
  const toggleSidebar = () => {
    const next = !sidebarCollapsed
    setSidebarPref(next)
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
    } catch {
      /* 不可写时只在本次生效 */
    }
  }

  // 固定定位的底栏用 lg:left-[var(--sidebar-w)] 让出侧边栏
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', sidebarCollapsed ? '4rem' : '14rem')
  }, [sidebarCollapsed])

  useEffect(() => {
    if (!isAuthenticated) return
    void fetchMessageSummary()
    const intervalSec = messageSummary?.refreshSeconds || 60
    const timer = window.setInterval(() => {
      void fetchMessageSummary()
    }, Math.max(15, intervalSec) * 1000)
    return () => window.clearInterval(timer)
  }, [isAuthenticated, fetchMessageSummary, messageSummary?.refreshSeconds])

  useEffect(() => {
    if (currentView === 'messages' && isAuthenticated) {
      void fetchMessageSummary()
    }
  }, [currentView, isAuthenticated, fetchMessageSummary])

  const isPc = useIsPc()
  // 使用说明：PC 在侧边栏里，算一级页面；手机从「设置」进入，带返回
  const isRootTab = rootTabs.includes(currentView) || (isPc && currentView === 'help')
  const showBottomNav = isRootTab && currentView !== 'admin'
  const title =
    currentView === 'agent-run' && currentAgentLabel
      ? currentAgentLabel
      : currentView === 'help-doc' && helpDocTitle
        ? helpDocTitle
        : getPageTitle(currentView, activeMenu?.label, proSignMergeButtonLabel, reportDetailRouteKey)
  // PC 面包屑的上一级（仅用于展示与快速返回）
  const crumbParent: { label: string; view: ViewName } | null =
    ADMIN_VIEWS.has(currentView) && currentView !== 'admin'
      ? { label: '管理后台', view: 'admin' }
      : currentView === 'agent-run'
        ? { label: 'Agent', view: 'agent-hub' }
        : currentView === 'help-doc'
          ? { label: '使用说明', view: 'help' }
          : !isRootTab && currentView !== 'help' && currentView !== 'ai'
          ? { label: '工作台', view: 'catalog' }
          : null

  const aiChatVisible = currentView === 'ai'
  const CurrentView = viewComponents[currentView] || CatalogView

  /** 合并报工页仍挂载列表报表（display:none），避免返回时 DynamicReportView 卸载导致筛选条件被初始化逻辑重置 */
  const dynamicReportVisible = currentView === 'dynamic-report'
  const dynamicReportShellHidden =
    activeMenu != null &&
    proSignMode &&
    (currentView === 'pro-sign-receive' || currentView === 'pro-sign-order-detail')

  return (
    <div className="min-h-screen bg-bg lg:flex">
      <Sidebar collapsed={sidebarCollapsed} />

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-40 h-14 bg-chrome text-chrome-fg border-b border-chrome-line">
          <div className="h-full flex items-center gap-2 px-4 max-w-2xl mx-auto md:max-w-none lg:px-6">
            <button
              type="button"
              onClick={toggleSidebar}
              className="hidden lg:flex -ml-2 w-8 h-8 items-center justify-center rounded-lg text-chrome-muted hover:text-chrome-fg hover:bg-chrome-active-bg transition"
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
            </button>
            {!isRootTab && (
              <button
                onClick={goBack}
                className="-ml-1.5 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-chrome-active-bg active:scale-90 transition"
                aria-label="返回"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {crumbParent && (
              <span className="hidden lg:flex items-center gap-1 text-sm text-chrome-muted">
                <button type="button" className="hover:text-chrome-fg" onClick={() => setView(crumbParent.view)}>
                  {crumbParent.label}
                </button>
                <ChevronRight className="w-3.5 h-3.5" />
              </span>
            )}
            <h1 className="font-display text-[17px] font-semibold flex-1 truncate">{title}</h1>
            {user && <div className="text-sm text-chrome-muted ml-2 truncate max-w-[120px] lg:hidden">{user.displayName || user.username}</div>}
          </div>
        </header>

        {/* main：手机 max-w-2xl 居中，平板及 PC 全宽 */}
        <main className={`w-full max-w-2xl mx-auto md:max-w-none ${showBottomNav ? 'pb-20 lg:pb-6' : 'pb-4'}`}>
          {(dynamicReportVisible || dynamicReportShellHidden) && (
            <div
              className={dynamicReportShellHidden ? 'hidden' : undefined}
              aria-hidden={dynamicReportShellHidden}
            >
              <DynamicReportView />
            </div>
          )}
          <div
            className={aiChatVisible ? undefined : 'hidden'}
            aria-hidden={!aiChatVisible}
          >
            <AiChatView />
          </div>
          {!dynamicReportVisible && !aiChatVisible && <CurrentView />}
        </main>
      </div>

      {showBottomNav && <BottomNav />}
    </div>
  )
}
