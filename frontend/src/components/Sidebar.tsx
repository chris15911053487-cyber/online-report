/**
 * PC 侧边栏（≥1024px）：主导航 + 最近打开的菜单 + 管理后台；Agent 运行页收起为图标栏。
 * 手机端不渲染，改用 BottomNav。语音脚本依赖的 data-nav-tab 与底栏保持一致。
 */
import { useMemo } from 'react'
import { Bot, BrainCircuit, Factory, Home, MessageCircle, Settings, Shield, FileText, type LucideIcon } from 'lucide-react'
import { useStore } from '../store'
import type { ViewName } from '../types'
import { cn } from '../ui/classes'
import { isAdminUser } from '../utils/helpers'
import { getRecentMenus } from '../utils/recentMenus'
import { menuLucideIcon } from '../utils/menuIcon'
import { isPlainClick, menuPath } from '../router'
import { BRAND_NAME } from '../utils/brand'
import { ADMIN_VIEWS } from './adminEntries'

interface NavItem {
  key: string
  label: string
  icon: LucideIcon
  active: boolean
  onClick: () => void
  /** 有地址就渲染成链接：右键可「在新标签页/新窗口打开」 */
  href?: string | null
  badge?: number
  dataTab?: ViewName
}

export default function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { currentView, setView, navMenus, activeMenu, openMenuItem, messageSummary, user } = useStore()
  const unread = messageSummary?.totalUnread || 0
  const isAdmin = isAdminUser(user)
  const reportViews: ViewName[] = ['dynamic-report', 'report-row-detail', 'pro-sign-receive', 'pro-sign-order-detail', 'work-registration']
  const inReport = reportViews.includes(currentView)

  // 依赖 activeMenu：打开新菜单后刷新「最近」
  const recent = useMemo(() => {
    void activeMenu
    return getRecentMenus()
      .map((rk) => navMenus.find((m) => m.routeKey === rk))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .slice(0, 5)
  }, [navMenus, activeMenu])

  const main: NavItem[] = [
    { key: 'catalog', label: '工作台', icon: Home, active: currentView === 'catalog', onClick: () => setView('catalog'), href: '/', dataTab: 'catalog' },
    { key: 'agent', label: 'Agent', icon: Bot, active: currentView === 'agent-hub' || currentView === 'agent-run', onClick: () => setView('agent-hub'), href: '/agents', dataTab: 'agent-hub' },
    { key: 'ai', label: 'AI 助手', icon: BrainCircuit, active: currentView === 'ai', onClick: () => setView('ai'), href: '/ai', dataTab: 'ai' },
    { key: 'messages', label: '消息', icon: MessageCircle, active: currentView === 'messages', onClick: () => setView('messages'), href: '/messages', badge: unread, dataTab: 'messages' },
  ]
  const recentItems: NavItem[] = recent.map((m) => ({
    key: `menu-${m.routeKey}`,
    label: m.label,
    icon: menuLucideIcon(m) ?? FileText,
    active: inReport && activeMenu?.routeKey === m.routeKey,
    onClick: () => openMenuItem(m),
    href: menuPath(m),
  }))
  const bottom: NavItem[] = [
    ...(isAdmin ? [{ key: 'admin', label: '管理后台', icon: Shield, active: ADMIN_VIEWS.has(currentView), onClick: () => setView('admin'), href: '/admin' }] : []),
    { key: 'settings', label: '设置', icon: Settings, active: currentView === 'settings', onClick: () => setView('settings'), href: '/settings', dataTab: 'settings' as ViewName },
  ]

  const renderItem = (it: NavItem) => {
    const Icon = it.icon
    const className = cn(
      'relative w-full flex items-center gap-2.5 rounded-lg text-[13px] transition-colors',
      collapsed ? 'justify-center h-10' : 'px-3 h-9',
      it.active ? 'bg-chrome-active-bg text-chrome-active font-semibold' : 'text-chrome-fg/75 hover:text-chrome-fg hover:bg-chrome-active-bg/60',
    )
    const content = (
      <>
        <Icon className="w-[18px] h-[18px] flex-shrink-0" />
        {!collapsed && <span className="truncate">{it.label}</span>}
        {!!it.badge && it.badge > 0 && (
          <span className={cn('rounded-full bg-danger text-white text-[10px] font-bold leading-4 px-1.5', collapsed ? 'absolute top-1 right-1' : 'ml-auto')}>
            {it.badge > 99 ? '99+' : it.badge}
          </span>
        )}
      </>
    )
    const common = {
      title: collapsed ? it.label : undefined,
      'aria-current': it.active ? ('page' as const) : undefined,
      'data-sidebar-tab': it.dataTab,
      className,
    }
    if (it.href) {
      return (
        <a
          key={it.key}
          href={it.href}
          onClick={(e) => {
            if (!isPlainClick(e)) return
            e.preventDefault()
            it.onClick()
          }}
          {...common}
        >
          {content}
        </a>
      )
    }
    return (
      <button key={it.key} type="button" onClick={it.onClick} {...common}>
        {content}
      </button>
    )
  }

  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col flex-shrink-0 sticky top-0 h-screen bg-chrome-side border-r border-chrome-line transition-[width] duration-200',
        collapsed ? 'w-16 px-2' : 'w-56 px-3',
      )}
    >
      <div className={cn('flex items-center gap-2.5 h-14 flex-shrink-0', collapsed ? 'justify-center' : 'px-1')}>
        <span className="w-8 h-8 rounded-lg bg-ai text-primary-fg flex items-center justify-center flex-shrink-0">
          <Factory className="w-4 h-4" />
        </span>
        {!collapsed && <span className="font-display text-[15px] font-semibold text-chrome-fg truncate">{BRAND_NAME}</span>}
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-none flex flex-col gap-0.5 py-2">
        {main.map(renderItem)}
        {recentItems.length > 0 && (
          <>
            {!collapsed ? <div className="px-3 pt-4 pb-1 text-[11px] tracking-wider text-chrome-muted">最近使用</div> : <div className="my-2 border-t border-chrome-line" />}
            {recentItems.map(renderItem)}
          </>
        )}
      </nav>

      <div className="flex flex-col gap-0.5 py-3 border-t border-chrome-line">
        {bottom.map(renderItem)}
        {!collapsed && user && (
          <div className="flex items-center gap-2 px-2 pt-3">
            <span className="w-7 h-7 rounded-full bg-primary text-primary-fg text-xs font-semibold flex items-center justify-center flex-shrink-0">
              {(user.displayName || user.username || '?').slice(0, 1)}
            </span>
            <span className="min-w-0 text-xs leading-tight">
              <span className="block text-chrome-fg truncate">{user.displayName || user.username}</span>
              <span className="block text-chrome-muted truncate">{user.username}</span>
            </span>
          </div>
        )}
      </div>
    </aside>
  )
}
