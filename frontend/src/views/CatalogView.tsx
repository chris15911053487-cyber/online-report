import { useStore } from '../store'
import type { NavMenuItem } from '../types'

export default function CatalogView() {
  const { navMenus, showToast, openMenu, openProSign, navigateTo } = useStore()

  const handleMenuClick = (menu: NavMenuItem) => {
    if (menu.routeKey === 'orders') {
      navigateTo('owor')
      return
    }
    if (menu.routeKey === 'menu-settings') {
      navigateTo('menu-settings')
      return
    }
    if (menu.routeKey === 'pro-sign') {
      openProSign(menu)
      return
    }
    if (menu.menuKind === 'report') {
      openMenu(menu)
      return
    }
    showToast('该菜单页面尚未接入')
  }

  return (
    <div className="p-4 pb-8 lg:p-6">
      <div className="mb-5">
        <h2 className="font-display text-lg font-semibold text-fg mb-0.5">菜单</h2>
        <p className="text-muted text-xs">请选择要操作的业务模块</p>
      </div>

      <div
        className="mx-auto grid max-w-lg grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:max-w-4xl lg:grid-cols-4 lg:mx-0"
        data-voice-catalog-grid
      >
        {navMenus.map((menu) => (
          <button
            key={menu.id || menu.routeKey}
            type="button"
            data-route-key={menu.routeKey}
            data-menu-label={menu.label}
            onClick={() => handleMenuClick(menu)}
            className="flex min-h-[4.25rem] flex-col items-center justify-center gap-1 rounded-xl border border-line/90 bg-surface px-2.5 py-2.5 text-center shadow-sm transition-[box-shadow,border-color] duration-200 hover:border-primary/25 hover:shadow active:scale-[0.98]"
          >
            <span className="text-lg leading-none text-fg-2 select-none">
              {menu.icon?.trim() || '◇'}
            </span>
            <span className="font-medium text-fg text-xs leading-snug line-clamp-2 w-full px-0.5">
              {menu.label}
            </span>
          </button>
        ))}
      </div>

      {navMenus.length === 0 && (
        <div className="py-16 text-center text-subtle">
          暂无可用菜单
        </div>
      )}
    </div>
  )
}
