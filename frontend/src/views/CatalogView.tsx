import { useMemo, useState } from 'react'
import { Bell, Bot, ChevronRight, Clock, Search } from 'lucide-react'
import { useStore } from '../store'
import type { NavMenuItem } from '../types'
import { Button, Card, EmptyState } from '../ui'
import { cn, inputClass } from '../ui/classes'
import { menuIcon, menuKindLabel } from '../utils/menuIcon'
import { getRecentMenus } from '../utils/recentMenus'
import { isPlainClick, menuPath } from '../router'

/** 菜单多于这个数才显示搜索框 */
const SEARCH_THRESHOLD = 8

function greeting(d = new Date()) {
  const h = d.getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function todayLabel(d = new Date()) {
  const week = '日一二三四五六'[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`
}

function MenuGlyph({ menu, className }: { menu: NavMenuItem; className?: string }) {
  const g = menuIcon(menu)
  return (
    <span className={cn('flex items-center justify-center rounded-lg bg-primary-soft text-primary flex-shrink-0 select-none', className)}>
      {'Icon' in g ? <g.Icon className="w-5 h-5" strokeWidth={1.8} /> : <span className="text-lg leading-none">{g.text}</span>}
    </span>
  )
}

/** 菜单入口渲染成链接：普通点击页内打开，右键 / Ctrl / 中键可在新标签页或新窗口打开 */
function MenuLink({ menu, onOpen, className, children, ...rest }: { menu: NavMenuItem; onOpen: (m: NavMenuItem) => void; className: string; children: React.ReactNode } & { [k: `data-${string}`]: string }) {
  const href = menuPath(menu)
  if (!href) {
    return (
      <button type="button" onClick={() => onOpen(menu)} className={className} {...rest}>
        {children}
      </button>
    )
  }
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!isPlainClick(e)) return
        e.preventDefault()
        onOpen(menu)
      }}
      className={className}
      {...rest}
    >
      {children}
    </a>
  )
}

export default function CatalogView() {
  const { navMenus, user, messageSummary, openMenuItem, setView } = useStore()
  const [keyword, setKeyword] = useState('')

  const name = user?.displayName || user?.username || ''
  const unread = messageSummary?.totalUnread || 0
  const unreadRules = (messageSummary?.rules || []).filter((r) => r.unread > 0)

  const recent = useMemo(
    () =>
      getRecentMenus()
        .map((rk) => navMenus.find((m) => m.routeKey === rk))
        .filter((m): m is NavMenuItem => !!m)
        .slice(0, 5),
    [navMenus],
  )

  const kw = keyword.trim().toLowerCase()
  const shown = kw ? navMenus.filter((m) => m.label.toLowerCase().includes(kw) || m.routeKey.toLowerCase().includes(kw)) : navMenus

  return (
    <div className="p-4 pb-8 lg:p-6 lg:max-w-6xl">
      {/* 问候 */}
      <div className="flex items-start justify-between gap-4 mb-4 lg:mb-5">
        <div className="min-w-0">
          <h2 className="font-display text-lg lg:text-xl font-semibold text-fg truncate">
            {greeting()}{name ? `，${name}` : ''}
          </h2>
          <p className="mt-0.5 text-xs lg:text-sm text-muted">{todayLabel()}</p>
        </div>
        <Button className="hidden lg:inline-flex" icon={<Bot className="w-4 h-4" />} onClick={() => setView('agent-hub')}>
          问 Agent
        </Button>
      </div>

      {/* 待处理：有未读提醒才显示 */}
      {unread > 0 && (
        <button
          type="button"
          onClick={() => setView('messages')}
          className="w-full mb-5 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-left transition-colors hover:border-warning/50"
        >
          <Bell className="w-4 h-4 text-warning flex-shrink-0" />
          <span className="flex-1 min-w-0 text-[13px] text-fg truncate">
            <b className="num font-semibold">{unread > 99 ? '99+' : unread}</b> 条未读提醒
            {unreadRules.length > 0 && (
              <span className="text-muted">
                {' · '}
                {unreadRules
                  .slice(0, 3)
                  .map((r) => `${r.name} ${r.unread}`)
                  .join('、')}
              </span>
            )}
          </span>
          <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
        </button>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-6 lg:items-start">
        {/* 业务模块 */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <h3 className="text-[13px] font-medium text-muted">业务模块</h3>
            {navMenus.length > SEARCH_THRESHOLD && (
              <label className="relative w-40 lg:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-subtle" />
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索菜单"
                  className={cn(inputClass, 'h-8 py-0 pl-8 text-[13px]')}
                />
              </label>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2.5 lg:grid-cols-2 xl:grid-cols-3 lg:gap-3" data-voice-catalog-grid>
            {shown.map((menu) => (
              <MenuLink
                key={menu.id || menu.routeKey}
                menu={menu}
                onOpen={openMenuItem}
                data-route-key={menu.routeKey}
                data-menu-label={menu.label}
                className={cn(
                  'group rounded-xl border border-line bg-surface shadow-sm transition-[box-shadow,border-color] duration-200 hover:border-primary/30 hover:shadow active:scale-[0.98]',
                  // 手机：竖排小方块；PC：横排卡片，带类型说明
                  'flex flex-col items-center justify-center gap-1.5 min-h-[5.25rem] px-2 py-3 text-center',
                  'lg:flex-row lg:justify-start lg:gap-3 lg:min-h-0 lg:px-4 lg:py-3.5 lg:text-left',
                )}
              >
                <MenuGlyph menu={menu} className="w-9 h-9 lg:w-10 lg:h-10" />
                <span className="min-w-0 w-full lg:flex-1">
                  <span className="block text-xs lg:text-sm font-medium text-fg leading-snug line-clamp-2 lg:truncate">{menu.label}</span>
                  <span className="hidden lg:block mt-0.5 text-xs text-subtle">{menuKindLabel(menu)}</span>
                </span>
                <ChevronRight className="hidden lg:block w-4 h-4 text-subtle opacity-0 transition-opacity group-hover:opacity-100 flex-shrink-0" />
              </MenuLink>
            ))}
          </div>

          {navMenus.length === 0 && <EmptyState title="暂无可用菜单" description="请联系管理员分配菜单权限" className="py-16" />}
          {navMenus.length > 0 && shown.length === 0 && <div className="py-10 text-center text-sm text-subtle">没有匹配「{keyword}」的菜单</div>}
        </section>

        {/* 最近使用 */}
        {recent.length > 0 && (
          <section className="mt-6 lg:mt-0">
            <h3 className="text-[13px] font-medium text-muted mb-2.5">最近使用</h3>
            <Card className="p-1">
              {recent.map((menu) => (
                <MenuLink
                  key={menu.routeKey}
                  menu={menu}
                  onOpen={openMenuItem}
                  className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
                >
                  <Clock className="w-3.5 h-3.5 text-subtle flex-shrink-0" />
                  <span className="flex-1 min-w-0 text-[13px] text-fg truncate">{menu.label}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-subtle flex-shrink-0" />
                </MenuLink>
              ))}
            </Card>
          </section>
        )}
      </div>
    </div>
  )
}
