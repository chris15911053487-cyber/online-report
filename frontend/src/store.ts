import { create } from 'zustand'
import { apiFetch, getToken, setToken } from './utils/api'
import { isDingTalkEnv, dingtalkLogin } from './utils/dingtalk'
import type { User, NavMenuItem, ViewName, MessageSummary } from './types'
import { rememberRecentMenu } from './utils/recentMenus'

let toastHideTimer: ReturnType<typeof setTimeout> | undefined

interface AppState {
  // Auth
  isAuthenticated: boolean
  user: User | null

  // Navigation
  currentView: ViewName
  viewHistory: ViewName[]

  // Menu
  navMenus: NavMenuItem[]
  /** 菜单已拉取过（成功或失败）；URL 路由要等它才能按地址打开报表 */
  menusLoaded: boolean
  isLoading: boolean

  // Toast
  toastMessage: string | null
  toastDuration: number

  // Message alerts
  messageSummary: MessageSummary | null

  // Dynamic report context
  activeMenu: NavMenuItem | null
  proSignMode: boolean
  /** 语音/外部跳转时预填的筛选条件（{字段name: 值}），由 DynamicReportView 消费一次后清空 */
  prefilledFilters: Record<string, any> | null
  /** 预填后是否自动执行查询 */
  prefilledAutoQuery: boolean

  // Report row detail context
  reportDetailRouteKey: string
  reportDetailParams: Record<string, any>
  reportDetailColumnLabels: Record<string, string>
  reportDetailKey: any

  // Order detail context

  // Work registration context
  workRegBatchId: number | null
  workRegMenu: NavMenuItem | null

  // Pro-sign receive context
  proSignMergeItems: any[] | null
  proSignLineResults: any[] | null
  proSignMergeButtonLabel: string
  /** 从合并报工返回列表时触发一次自动查询（保持筛选条件） */
  shouldRefreshProSignListAfterReceive: boolean

  // Pro-sign order detail context
  proSignOrderDetailOrderNo: string | null

  /** 从 Skill 管理点击"对话"跳转 AI 对话时携带的 skill 名，AiChatView 消费一次后清空 */
  pendingChatSkill: string | null

  /** 当前进入的 Agent（agent-run 页使用） */
  currentAgentKey: string | null
  /** 当前 Agent 的显示名（运行页加载配置后写入，用于顶栏标题） */
  currentAgentLabel: string | null
  /** 正在看的使用说明书（help-doc 页使用，server/help 的 slug） */
  helpDocSlug: string | null
  /** 当前说明书标题（阅读页加载后写入，用于顶栏标题） */
  helpDocTitle: string | null

  // Actions
  initialize: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  setView: (view: ViewName) => void
  navigateTo: (view: ViewName) => void
  goBack: () => void
  fetchMenus: () => Promise<void>
  fetchMessageSummary: () => Promise<void>
  showToast: (msg: string, durationMs?: number) => void
  hideToast: () => void
  /** 点击菜单项：按 routeKey / menuKind 打开对应页面（菜单页、侧栏、URL 路由共用） */
  openMenuItem: (menu: NavMenuItem) => void
  openMenu: (menu: NavMenuItem, opts?: { prefilledFilters?: Record<string, any>; autoQuery?: boolean }) => void
  openProSign: (menu: NavMenuItem, opts?: { prefilledFilters?: Record<string, any>; autoQuery?: boolean }) => void
  consumePrefilledFilters: () => void
  openReportRowDetail: (routeKey: string, params: Record<string, any>, columnLabels: Record<string, string>, detailKey?: any) => void
  openWorkRegistration: (batchId: number, menu: NavMenuItem | null) => void
  openProSignReceive: (mergeItems: any[], lineResults: any[], buttonLabel: string) => void
  openProSignOrderDetail: (orderNo: string) => void
  clearProSignListRefreshFlag: () => void
  /** 跳转 AI 对话并指定要调用的 Skill */
  openAiChatWithSkill: (skillName: string) => void
  /** AiChatView 消费 pendingChatSkill 后清空 */
  consumePendingChatSkill: () => void
  /** 打开一篇使用说明书（/help/:slug） */
  openHelpDoc: (slug: string) => void
  setHelpDocTitle: (title: string | null) => void
  /** 进入某个 Agent 的运行页 */
  openAgent: (agentKey: string) => void
  /** 钉钉环境自动免登 */
  dingtalkAutoLogin: () => Promise<void>
}

export const useStore = create<AppState>((set, get) => ({
  isAuthenticated: false,
  user: null,
  currentView: 'catalog',
  viewHistory: [],
  navMenus: [],
  menusLoaded: false,
  isLoading: false,
  toastMessage: null,
  toastDuration: 2200,
  messageSummary: null,
  activeMenu: null,
  proSignMode: false,
  prefilledFilters: null,
  prefilledAutoQuery: false,
  reportDetailRouteKey: '',
  reportDetailParams: {},
  reportDetailColumnLabels: {},
  reportDetailKey: null,
  workRegBatchId: null,
  workRegMenu: null,
  proSignMergeItems: null,
  proSignLineResults: null,
  proSignMergeButtonLabel: '合并报工',
  shouldRefreshProSignListAfterReceive: false,
  proSignOrderDetailOrderNo: null,
  pendingChatSkill: null,
  currentAgentKey: null,
  currentAgentLabel: null,
  helpDocSlug: null,
  helpDocTitle: null,

  clearProSignListRefreshFlag: () => set({ shouldRefreshProSignListAfterReceive: false }),

  openAiChatWithSkill: (skillName: string) => {
    set((s) => ({
      pendingChatSkill: skillName,
      currentView: 'ai',
      viewHistory: [...s.viewHistory, s.currentView],
    }))
  },

  consumePendingChatSkill: () => set({ pendingChatSkill: null }),

  setHelpDocTitle: (title) => set({ helpDocTitle: title }),

  openHelpDoc: (slug: string) => {
    set((s) => ({
      helpDocSlug: slug,
      helpDocTitle: null,
      currentView: 'help-doc',
      viewHistory: s.currentView === 'help-doc' ? s.viewHistory : [...s.viewHistory, s.currentView],
    }))
  },

  openAgent: (agentKey: string) => {
    set((s) => ({
      currentAgentKey: agentKey,
      currentAgentLabel: null,
      currentView: 'agent-run',
      viewHistory: [...s.viewHistory, s.currentView],
    }))
  },

  dingtalkAutoLogin: async () => {
    set({ isLoading: true })
    try {
      const result = await dingtalkLogin()
      if (result.success && result.user) {
        set({
          isAuthenticated: true,
          user: {
            username: result.user.username || '',
            displayName: result.user.displayName || result.user.username || '',
            role: (result.user.role || 'operator') as 'admin' | 'operator',
            roles: Array.isArray(result.user.roles) ? result.user.roles : [result.user.role || 'operator'],
          },
        })
        await get().fetchMenus()
        void get().fetchMessageSummary()
      } else if (result.error) {
        // 免登失败（如未绑定），不阻塞——回退到手动登录页面
        console.warn('[dingtalk-sso]', result.error)
      }
    } catch (err) {
      console.warn('[dingtalk-sso] auto login failed:', err)
    } finally {
      set({ isLoading: false })
    }
  },

  showToast: (msg: string, durationMs = 2200) => {
    if (toastHideTimer) clearTimeout(toastHideTimer)
    set({ toastMessage: msg, toastDuration: durationMs })
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : 2200
    toastHideTimer = setTimeout(() => {
      set({ toastMessage: null })
      toastHideTimer = undefined
    }, ms)
  },

  hideToast: () => {
    if (toastHideTimer) clearTimeout(toastHideTimer)
    toastHideTimer = undefined
    set({ toastMessage: null })
  },

  initialize: async () => {
    const token = getToken()
    if (token) {
      try {
        const user = await apiFetch('/auth/me')
        set({
          isAuthenticated: true,
          user: {
            username: user.username || '',
            displayName: user.displayName || user.username || '',
            role: user.role || 'operator',
            roles: Array.isArray(user.roles) ? user.roles : [user.role || 'operator'],
          },
        })
        await get().fetchMenus()
        void get().fetchMessageSummary()
      } catch {
        setToken(null)
        set({ isAuthenticated: false })
        // token 失效后，若在钉钉环境则尝试重新免登
        if (isDingTalkEnv()) {
          await get().dingtalkAutoLogin()
        }
      }
      return
    }
    // 无 token 时，检测钉钉环境自动免登
    if (isDingTalkEnv()) {
      await get().dingtalkAutoLogin()
    }
  },

  login: async (username: string, password: string) => {
    set({ isLoading: true })
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setToken(data.token)
      const u = data.user || {}
      set({
        isAuthenticated: true,
        user: {
          username: u.username || username,
          displayName: u.displayName || u.username || username,
          role: u.role || 'operator',
          roles: Array.isArray(u.roles) ? u.roles : [u.role || 'operator'],
        },
      })
      await get().fetchMenus()
      void get().fetchMessageSummary()
    } finally {
      set({ isLoading: false })
    }
  },

  logout: () => {
    setToken(null)
    set({
      isAuthenticated: false,
      user: null,
      navMenus: [],
      menusLoaded: false,
      currentView: 'catalog',
      viewHistory: [],
      activeMenu: null,
      proSignMode: false,
      proSignOrderDetailOrderNo: null,
      workRegBatchId: null,
      proSignMergeItems: null,
      proSignLineResults: null,
      shouldRefreshProSignListAfterReceive: false,
      prefilledFilters: null,
      prefilledAutoQuery: false,
      messageSummary: null,
      currentAgentKey: null,
    })
    try {
      ;(window as any).__voiceMenus = []
    } catch {
      /* ignore */
    }
  },

  setView: (view: ViewName) => {
    set({ currentView: view })
  },

  navigateTo: (view: ViewName) => {
    const current = get().currentView
    set((s) => ({
      currentView: view,
      viewHistory: [...s.viewHistory, current],
    }))
  },

  goBack: () => {
    const { viewHistory, currentView, proSignMode, activeMenu } = get()

    if (currentView === 'pro-sign-order-detail') {
      set({ currentView: 'dynamic-report', proSignOrderDetailOrderNo: null })
      return
    }

    if (currentView === 'report-row-detail') {
      set({ currentView: 'dynamic-report' })
      return
    }
    if (currentView === 'pro-sign-receive') {
      set({
        currentView: 'dynamic-report',
        proSignMergeItems: null,
        proSignLineResults: null,
        shouldRefreshProSignListAfterReceive: true,
      })
      return
    }
    if (currentView === 'work-registration') {
      if (activeMenu) {
        set({
          currentView: 'dynamic-report',
          proSignMode: true,
          workRegBatchId: null,
        })
      } else {
        set({ currentView: 'catalog', workRegBatchId: null })
      }
      return
    }
    if (currentView === 'dynamic-report' && proSignMode) {
      set({ currentView: 'catalog', proSignMode: false, activeMenu: null })
      return
    }

    if (currentView === 'help-doc') {
      set((s) => ({
        currentView: s.viewHistory.length > 0 ? s.viewHistory[s.viewHistory.length - 1] : 'help',
        viewHistory: s.viewHistory.slice(0, -1),
        helpDocSlug: null,
      }))
      return
    }

    if (currentView === 'agent-run') {
      set((s) => ({
        currentView: s.viewHistory.length > 0 ? s.viewHistory[s.viewHistory.length - 1] : 'agent-hub',
        viewHistory: s.viewHistory.slice(0, -1),
        currentAgentKey: null,
      }))
      return
    }

    if (viewHistory.length > 0) {
      const prev = viewHistory[viewHistory.length - 1]
      set({ currentView: prev, viewHistory: viewHistory.slice(0, -1) })
    } else {
      set({ currentView: 'catalog' })
    }
  },

  fetchMenus: async () => {
    try {
      const data = await apiFetch('/menus')
      const items: NavMenuItem[] = data.items || data || []
      set({ navMenus: items, menusLoaded: true })
      // 同步给 voice.js（以及 ReactNative WebView 桥接）使用
      try {
        ;(window as any).__voiceMenus = items
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.error('Failed to fetch menus:', err)
      const msg = err instanceof Error ? err.message : '菜单加载失败'
      set({ menusLoaded: true })
      get().showToast(msg)
    }
  },

  fetchMessageSummary: async () => {
    if (!get().isAuthenticated) return
    try {
      const data = await apiFetch('/messages/summary')
      set({
        messageSummary: {
          totalUnread: Number(data?.totalUnread) || 0,
          refreshSeconds: Number(data?.refreshSeconds) || 60,
          rules: Array.isArray(data?.rules) ? data.rules : [],
          refreshedAt: data?.refreshedAt || null,
        },
      })
    } catch (err) {
      console.error('Failed to fetch message summary:', err)
    }
  },

  openMenuItem: (menu: NavMenuItem) => {
    const s = get()
    if (menu.routeKey === 'pro-sign') {
      s.openProSign(menu)
      return
    }
    if (menu.menuKind === 'report') {
      s.openMenu(menu)
      return
    }
    s.showToast('该菜单页面尚未接入')
  },

  openMenu: (menu: NavMenuItem, opts?: { prefilledFilters?: Record<string, any>; autoQuery?: boolean }) => {
    rememberRecentMenu(menu.routeKey)
    set({
      activeMenu: menu,
      proSignMode: false,
      currentView: 'dynamic-report',
      shouldRefreshProSignListAfterReceive: false,
      prefilledFilters: opts?.prefilledFilters ? { ...opts.prefilledFilters } : null,
      prefilledAutoQuery: opts?.autoQuery !== false,
    })
  },

  openProSign: (menu: NavMenuItem, opts?: { prefilledFilters?: Record<string, any>; autoQuery?: boolean }) => {
    rememberRecentMenu(menu.routeKey)
    set({
      activeMenu: menu,
      proSignMode: true,
      currentView: 'dynamic-report',
      shouldRefreshProSignListAfterReceive: false,
      prefilledFilters: opts?.prefilledFilters ? { ...opts.prefilledFilters } : null,
      prefilledAutoQuery: opts?.autoQuery !== false,
    })
  },

  consumePrefilledFilters: () => {
    set({ prefilledFilters: null, prefilledAutoQuery: false })
  },

  openReportRowDetail: (routeKey, params, columnLabels, detailKey) => {
    set({
      reportDetailRouteKey: routeKey,
      reportDetailParams: params,
      reportDetailColumnLabels: columnLabels,
      reportDetailKey: detailKey ?? null,
      currentView: 'report-row-detail',
    })
  },

  openWorkRegistration: (batchId: number, menu: NavMenuItem | null) => {
    set({
      workRegBatchId: batchId,
      workRegMenu: menu,
      currentView: 'work-registration',
    })
  },

  openProSignReceive: (mergeItems, lineResults, buttonLabel) => {
    set({
      proSignMergeItems: mergeItems,
      proSignLineResults: lineResults,
      proSignMergeButtonLabel: buttonLabel,
      currentView: 'pro-sign-receive',
      shouldRefreshProSignListAfterReceive: false,
    })
  },

  openProSignOrderDetail: (orderNo: string) => {
    set({
      proSignOrderDetailOrderNo: orderNo,
      currentView: 'pro-sign-order-detail',
    })
  },
}))

/**
 * 全局语音/外部跳转钩子：voice.js 在识别+模板匹配命中后调用。
 * 返回 true 表示已成功跳转。
 *   window.__voiceNavigate(routeKey, filters, { autoQuery: true })
 */
if (typeof window !== 'undefined') {
  ;(window as any).__voiceNavigate = function (
    routeKey: string,
    filters?: Record<string, any>,
    opts?: { autoQuery?: boolean },
  ): boolean {
    const state = useStore.getState()
    const target = (state.navMenus || []).find((m) => m.routeKey === routeKey)
    if (!target) {
      state.showToast('未找到菜单：' + routeKey)
      return false
    }
    const cleanFilters: Record<string, any> = {}
    if (filters && typeof filters === 'object') {
      for (const k of Object.keys(filters)) {
        const v = filters[k]
        if (v == null) continue
        cleanFilters[k] = v
      }
    }
    const autoQuery = opts?.autoQuery !== false
    if (target.routeKey === 'pro-sign') {
      state.openProSign(target, { prefilledFilters: cleanFilters, autoQuery })
      return true
    }
    if (target.menuKind === 'report') {
      state.openMenu(target, { prefilledFilters: cleanFilters, autoQuery })
      return true
    }
    state.showToast('该菜单不支持语音参数操作')
    return false
  }
}
