import { create } from 'zustand'
import { apiFetch, getToken, setToken } from './utils/api'

let toastHideTimer: ReturnType<typeof setTimeout> | undefined

interface User {
  username: string
  displayName: string
  role: 'admin' | 'operator'
}

interface AppState {
  isAuthenticated: boolean
  user: User | null
  currentView: string
  navMenus: any[]
  isLoading: boolean
  toastMessage: string | null

  // Actions
  initialize: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  setView: (view: string) => void
  fetchMenus: () => Promise<void>
  showToast: (msg: string) => void
  hideToast: () => void
}

export const useStore = create<AppState>((set, get) => ({
  isAuthenticated: false,
  user: null,
  currentView: 'catalog',
  navMenus: [],
  isLoading: false,
  toastMessage: null,

  showToast: (msg: string) => {
    if (toastHideTimer) clearTimeout(toastHideTimer)
    set({ toastMessage: msg })
    toastHideTimer = setTimeout(() => {
      set({ toastMessage: null })
      toastHideTimer = undefined
    }, 2200)
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
          user,
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
      set({ 
        isAuthenticated: true, 
        user: data.user,
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
    })
  },

  setView: (view: string) => {
    set({ currentView: view })
  },

  fetchMenus: async () => {
    try {
      const menus = await apiFetch('/menus')
      set({ navMenus: menus })
    } catch (err) {
      console.error('Failed to fetch menus:', err)
      const msg = err instanceof Error ? err.message : '菜单加载失败'
      get().showToast(msg)
    }
  },
}))
