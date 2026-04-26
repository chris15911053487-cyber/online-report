import { useStore } from '../store'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../utils/api'

export default function CatalogView() {
  const { navMenus } = useStore()

  const { data: menus = navMenus } = useQuery({
    queryKey: ['menus'],
    queryFn: () => apiFetch('/menus'),
    initialData: navMenus,
  })

  const handleMenuClick = (menu: any) => {
    console.log('Navigate to:', menu.routeKey)
    // TODO: Implement navigation to different views based on routeKey
    // e.g. if (menu.routeKey === 'pro-sign') navigate to ProSignView
    if (menu.menuKind === 'report' || menu.routeKey.includes('report')) {
      // Will be implemented in DynamicReportView
      alert(`打开报表: ${menu.label} (待实现)`)
    }
  }

  return (
    <div className="p-4">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-800 mb-1">功能目录</h2>
        <p className="text-slate-500 text-sm">请选择要操作的业务模块</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {menus.map((menu: any) => (
          <button
            key={menu.id || menu.routeKey}
            onClick={() => handleMenuClick(menu)}
            className="card group hover:border-sky-200 hover:shadow-md transition-all duration-200 flex flex-col items-center justify-center py-8 text-center active:scale-95"
          >
            <div className="text-4xl mb-4 opacity-80 group-active:scale-110 transition-transform">
              {menu.icon || '📋'}
            </div>
            <div className="font-medium text-slate-800">{menu.label}</div>
            {menu.menuKind === 'report' && (
              <div className="text-[10px] text-emerald-600 mt-1">可配置报表</div>
            )}
          </button>
        ))}

        {menus.length === 0 && (
          <div className="col-span-2 py-12 text-center text-slate-400">
            暂无可用菜单
          </div>
        )}
      </div>

      {/* Quick link to admin for demo */}
      <div className="mt-8 text-center">
        <button
          onClick={() => alert('菜单管理 - 管理员功能 (待完整实现)')}
          className="text-sm text-slate-500 hover:text-slate-700 underline"
        >
          管理员 · 菜单设置
        </button>
      </div>
    </div>
  )
}
