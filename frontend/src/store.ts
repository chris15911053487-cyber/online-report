import { create } from 'zustand'
import { apiFetch, getToken, setToken } from './utils/api'
import type { User, NavMenuItem, ViewName } from './types'

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
  isLoading: boolean

  // Toast
  toastMessage: string | null
  toastDuration: number

  // Dynamic report context
  activeMenu: NavMenuItem | null
  proSignMode: boolean

  // Report row detail context
  reportDetailRouteKey: string
  reportDetailParams: Record<string, any>
  reportDetailColumnLabels: Record<string, string>
  reportDetailKey: any

  // Order detail context
  currentOrderId: number | null

  // Work registration context
  workRegBatchId: number | null
  workRegMenu: NavMenuItem | null

  // Pro-sign receive context
  proSignMergeItems: any[] | null
  proSignLineResults: any[] | null
  proSignMergeButtonLabel: string

  // Actions
  initialize: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  setView: (view: ViewName) => void
  navigateTo: (view: ViewName) => void
  goBack: () => void
  fetchMenus: () => Promise<void>
  showToast: (msg: string, durationMs?: number) => void
  hideToast: () => void
  openMenu: (menu: NavMenuItem) => void
  openProSign: (menu: NavMenuItem) => void
  openReportRowDetail: (routeKey: string, params: Record<string, any>, columnLabels: Record<string, string>, detailKey?: any) => void
  openOrderDetail: (orderId: number) => void
  openWorkRegistration: (batchId: number, menu: NavMenuItem | null) => void
  openProSignReceive: (mergeItems: any[], lineResults: any[], buttonLabel: string) => void
}

export const useStore = create<AppState>((set, get) => ({
  isAuthenticated: false,
  user: null,
  currentView: 'catalog',
  viewHistory: [],
  navMenus: [],
  isLoading: false,
  toastMessage: null,
  toastDuration: 2200,
  activeMenu: null,
  proSignMode: false,
  reportDetailRouteKey: '',
  reportDetailParams: {},
  reportDetailColumnLabels: {},
  reportDetailKey: null,
  currentOrderId: null,
  workRegBatchId: null,
  workRegMenu: null,
  proSignMergeItems: null,
  proSignLineResults: null,
  proSignMergeButtonLabel: '合并报工',

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
          },
        })
        await get().fetchMenus()
      } catch {
        setToken(null)
        set({ isAuthenticated: false })
      }
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
        },
      })
      await get().fetchMenus()
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
      currentView: 'catalog',
      viewHistory: [],
      activeMenu: null,
      proSignMode: false,
      currentOrderId: null,
      workRegBatchId: null,
      proSignMergeItems: null,
      proSignLineResults: null,
    })
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

    if (currentView === 'detail') {
      set({ currentView: 'orders', currentOrderId: null })
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
      set({ navMenus: data.items || data || [] })
    } catch (err) {
      console.error('Failed to fetch menus:', err)
      const msg = err instanceof Error ? err.message : '菜单加载失败'
      get().showToast(msg)
    }
  },

  openMenu: (menu: NavMenuItem) => {
    set({
      activeMenu: menu,
      proSignMode: false,
      currentView: 'dynamic-report',
    })
  },

  openProSign: (menu: NavMenuItem) => {
    set({
      activeMenu: menu,
      proSignMode: true,
      currentView: 'dynamic-report',
    })
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

  openOrderDetail: (orderId: number) => {
    set({ currentOrderId: orderId, currentView: 'detail' })
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
    })
  },
}))
