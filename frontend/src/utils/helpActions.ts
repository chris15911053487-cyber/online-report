import type { NavMenuItem, ViewName } from '../types'

export interface HelpNavAction {
  type: 'navigate' | 'openCatalog' | 'openProSign' | 'followup'
  label: string
  view?: string
}

type StoreNav = {
  setView: (view: ViewName) => void
  navigateTo: (view: ViewName) => void
  navMenus: NavMenuItem[]
  openProSign: (menu: NavMenuItem) => void
  showToast: (msg: string) => void
  sendText?: (text: string) => void
}

/** 执行 AI 助手返回的界面跳转建议 */
export function runHelpNavAction(action: HelpNavAction, store: StoreNav) {
  if (action.type === 'followup') {
    if (store.sendText) store.sendText(action.label)
    return
  }

  if (action.type === 'navigate' && action.view) {
    const view = action.view as ViewName
    store.navigateTo(view)
    return
  }

  if (action.type === 'openCatalog') {
    store.navigateTo('catalog')
    return
  }

  if (action.type === 'openProSign') {
    const menu =
      store.navMenus.find((m) => m.routeKey === 'pro-sign') ||
      store.navMenus.find((m) => /报工/.test(m.label || ''))
    if (menu) {
      store.openProSign(menu)
      return
    }
    store.navigateTo('catalog')
    store.showToast('请从菜单中选择生产报工入口（未找到 pro-sign 菜单）')
  }
}
