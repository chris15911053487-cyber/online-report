/**
 * URL 路由：Zustand（currentView 等）仍是唯一状态源，这里只做「状态 ⇄ 地址」同步。
 *
 * - 状态变化 → pushState（返回上一页时用 history.back，保持浏览器历史与页面一致）
 * - 浏览器后退 / 安卓返回键（popstate）→ 回到上一条时调用 store.goBack()，否则按地址打开页面
 * - 首次加载（登录且菜单拉取完成后）→ 按地址恢复页面，支持刷新、收藏、分享链接
 *
 * 依赖内存数据的页面（合并报工确认、行详情）有自己的地址，但刷新后退回所在报表页。
 * 服务端配合见 server/src/spa.js（/api 前缀与 SPA 回退）。
 */
import type { NavMenuItem, ViewName } from './types'

/** 管理页：地址段 ⇄ 视图 */
export const ADMIN_SEGMENTS: Record<string, ViewName> = {
  '': 'admin',
  menus: 'menu-settings',
  agents: 'agents-admin',
  bi: 'bi-admin',
  skills: 'ai-skills',
  alerts: 'message-alert-settings',
  'alert-push': 'alert-push',
  'scheduled-reports': 'scheduled-reports',
}
const ADMIN_VIEW_TO_SEGMENT = Object.fromEntries(Object.entries(ADMIN_SEGMENTS).map(([seg, v]) => [v, seg])) as Partial<Record<ViewName, string>>

/** 无参数的普通页面 */
const SIMPLE_VIEWS: Partial<Record<ViewName, string>> = {
  catalog: '/',
  ai: '/ai',
  'agent-hub': '/agents',
  messages: '/messages',
  settings: '/settings',
  help: '/help',
}
const SIMPLE_PATHS = Object.fromEntries(Object.entries(SIMPLE_VIEWS).map(([v, p]) => [p, v])) as Record<string, ViewName>

/** 计算地址所需的状态切片 */
export interface RouteState {
  currentView: ViewName
  activeMenu: Pick<NavMenuItem, 'routeKey'> | null
  currentAgentKey: string | null
  /** 说明书阅读页的 slug；旧调用方可不传 */
  helpDocSlug?: string | null
  proSignOrderDetailOrderNo: string | null
  workRegBatchId: number | null
}

export type Navigation =
  | { kind: 'view'; view: ViewName }
  | { kind: 'report'; routeKey: string; sub?: 'row' | 'merge' }
  | { kind: 'proSignOrder'; routeKey: string; orderNo: string }
  | { kind: 'workReg'; routeKey: string | null; batchId: number }
  | { kind: 'agent'; agentKey: string }
  | { kind: 'help'; slug: string }

const enc = encodeURIComponent

/** 状态 → 地址（pathname） */
export function pathFor(s: RouteState): string {
  const simple = SIMPLE_VIEWS[s.currentView]
  if (simple) return simple
  const adminSeg = ADMIN_VIEW_TO_SEGMENT[s.currentView]
  if (adminSeg !== undefined) return adminSeg ? `/admin/${adminSeg}` : '/admin'
  const rk = s.activeMenu?.routeKey
  switch (s.currentView) {
    case 'agent-run':
      return s.currentAgentKey ? `/agents/${enc(s.currentAgentKey)}` : '/agents'
    case 'help-doc':
      return s.helpDocSlug ? `/help/${enc(s.helpDocSlug)}` : '/help'
    case 'dynamic-report':
      return rk ? `/report/${enc(rk)}` : '/'
    case 'report-row-detail':
      return rk ? `/report/${enc(rk)}/row` : '/'
    case 'pro-sign-receive':
      return rk ? `/report/${enc(rk)}/merge` : '/'
    case 'pro-sign-order-detail':
      return rk && s.proSignOrderDetailOrderNo ? `/report/${enc(rk)}/order/${enc(s.proSignOrderDetailOrderNo)}` : rk ? `/report/${enc(rk)}` : '/'
    case 'work-registration':
      if (s.workRegBatchId == null) return '/'
      return rk ? `/report/${enc(rk)}/batch/${s.workRegBatchId}` : `/work-registration/${s.workRegBatchId}`
    default:
      return '/'
  }
}

/** 菜单的页面地址（与 store.openMenuItem 的分支一致）；未接入的菜单返回 null */
export function menuPath(menu: Pick<NavMenuItem, 'routeKey' | 'menuKind'>): string | null {
  if (menu.routeKey === 'pro-sign' || menu.menuKind === 'report') return `/report/${enc(menu.routeKey)}`
  return null
}

/** 普通左键点击（无修饰键）才在当前页内切换；Ctrl/⌘/Shift/中键交给浏览器在新标签页/新窗口打开 */
export function isPlainClick(e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey
}

/** 地址 → 导航动作；无法识别的地址回到首页 */
export function parsePath(pathname: string): Navigation {
  const clean = '/' + pathname.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '')
  if (SIMPLE_PATHS[clean]) return { kind: 'view', view: SIMPLE_PATHS[clean] }
  const parts = clean.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
  const [head, a, b, c] = parts
  const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null)
  if (head === 'admin') {
    const view = ADMIN_SEGMENTS[a ?? '']
    if (view && parts.length <= 2) return { kind: 'view', view }
  }
  if (head === 'agents' && a && parts.length === 2) return { kind: 'agent', agentKey: a }
  if (head === 'help' && a && parts.length === 2) return { kind: 'help', slug: a }
  if (head === 'report' && a) {
    if (b === 'order' && c) return { kind: 'proSignOrder', routeKey: a, orderNo: c }
    if (b === 'batch' && int(c) != null) return { kind: 'workReg', routeKey: a, batchId: int(c)! }
    if (b === 'row' || b === 'merge') return { kind: 'report', routeKey: a, sub: b }
    return { kind: 'report', routeKey: a }
  }
  if (head === 'work-registration' && int(a) != null) return { kind: 'workReg', routeKey: null, batchId: int(a)! }
  return { kind: 'view', view: 'catalog' }
}

// ─── 与 store / 浏览器历史同步 ────────────────────────────────────────────────

interface RouterStore {
  getState: () => RouteState & {
    navMenus: NavMenuItem[]
    goBack: () => void
    openMenuItem: (menu: NavMenuItem) => void
    openAgent: (key: string) => void
    openHelpDoc: (slug: string) => void
    openProSignOrderDetail: (orderNo: string) => void
    openWorkRegistration: (batchId: number, menu: NavMenuItem | null) => void
    showToast: (msg: string) => void
  }
  setState: (partial: { currentView: ViewName }) => void
  subscribe: (cb: () => void) => () => void
}

/** 按导航动作打开页面（直接打开链接、浏览器前进时使用） */
export function applyNavigation(store: RouterStore, nav: Navigation) {
  const s = store.getState()
  const findMenu = (rk: string | null) => (rk ? s.navMenus.find((m) => m.routeKey === rk) ?? null : null)
  switch (nav.kind) {
    case 'view':
      store.setState({ currentView: nav.view })
      return
    case 'agent':
      s.openAgent(nav.agentKey)
      return
    case 'help':
      s.openHelpDoc(nav.slug)
      return
    case 'report':
    case 'proSignOrder':
    case 'workReg': {
      const menu = findMenu(nav.routeKey)
      if (nav.routeKey && !menu) {
        s.showToast('没有找到该页面，或无权访问')
        store.setState({ currentView: 'catalog' })
        return
      }
      if (menu) s.openMenuItem(menu)
      if (nav.kind === 'proSignOrder') store.getState().openProSignOrderDetail(nav.orderNo)
      if (nav.kind === 'workReg') store.getState().openWorkRegistration(nav.batchId, menu)
      return
    }
  }
}

let started = false
const STACK_KEY = 'online_report_route_stack'
interface HistoryState {
  app: true
  /** 该条目在本应用历史栈中的位置，用于刷新后恢复栈、判断前进还是后退 */
  idx: number
}

function readSavedStack(): string[] | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(STACK_KEY) || 'null')
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null
  } catch {
    return null
  }
}

/** 登录且菜单加载完成后调用一次：按当前地址恢复页面，然后开始双向同步 */
export function startRouter(store: RouterStore) {
  if (started || typeof window === 'undefined') return
  started = true

  // 本应用推入的历史条目，与浏览器历史一一对应；存 sessionStorage，刷新后仍能正确「返回」
  let stack: string[] = []
  let ignorePops = 0
  // 处理 popstate 期间 store 的变化由 popstate 自己对齐地址，订阅回调不再推入历史
  let applyingPop = false
  const save = () => {
    try {
      sessionStorage.setItem(STACK_KEY, JSON.stringify(stack))
    } catch {
      /* 不可写时只是刷新后少了返回记录 */
    }
  }
  const entry = (): HistoryState => ({ app: true, idx: stack.length - 1 })

  const initialPath = window.location.pathname
  applyNavigation(store, parsePath(initialPath))
  const current = pathFor(store.getState())
  const hs = window.history.state as HistoryState | null
  const saved = readSavedStack()
  if (hs?.app && typeof hs.idx === 'number' && saved && saved[hs.idx] === initialPath) {
    stack = saved.slice(0, hs.idx + 1)
    stack[hs.idx] = current
  } else {
    stack = [current]
  }
  window.history.replaceState(entry(), '', current + window.location.search)
  save()

  store.subscribe(() => {
    if (applyingPop) return
    const path = pathFor(store.getState())
    if (path === stack[stack.length - 1]) return
    if (stack.length > 1 && path === stack[stack.length - 2]) {
      // 页面内的返回：同步后退一步，避免历史里堆出「列表 → 详情 → 列表」
      stack.pop()
      save()
      ignorePops += 1
      window.history.back()
      return
    }
    stack.push(path)
    window.history.pushState(entry(), '', path)
    save()
  })

  window.addEventListener('popstate', (e) => {
    if (ignorePops > 0) {
      ignorePops -= 1
      return
    }
    const target = window.location.pathname
    const st = e.state as HistoryState | null
    const idx = st?.app && typeof st.idx === 'number' ? st.idx : null
    const backOne = stack.length > 1 && stack[stack.length - 2] === target && (idx == null || idx === stack.length - 2)
    applyingPop = true
    try {
      if (backOne) {
        // 浏览器后退 / 安卓返回键：走页面自己的返回逻辑（含合并报工返回后刷新列表等）
        stack.pop()
        store.getState().goBack()
      } else {
        // 前进、或一次后退多步：按地址打开
        if (idx != null) stack = stack.slice(0, idx)
        stack.push(target)
        applyNavigation(store, parsePath(target))
      }
    } finally {
      applyingPop = false
    }
    const after = pathFor(store.getState())
    if (after !== target) {
      stack[stack.length - 1] = after
      window.history.replaceState(entry(), '', after)
    }
    save()
  })
}
