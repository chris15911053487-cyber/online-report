/** 最近打开的菜单（PC 侧栏「常用」与菜单页「最近使用」），只存 routeKey，本机 localStorage */
const KEY = 'online_report_recent_menus'
const MAX = 6

export function getRecentMenus(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function rememberRecentMenu(routeKey: string | undefined | null) {
  if (!routeKey) return
  try {
    const next = [routeKey, ...getRecentMenus().filter((k) => k !== routeKey)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 不可写时忽略 */
  }
}
