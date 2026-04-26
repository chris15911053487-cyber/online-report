export const TOKEN_KEY = 'online_report_token'

/** 开发时走 Vite 代理 /api；生产与后端同域时直接请求根路径（与旧 app.js 一致） */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return import.meta.env.DEV ? `/api${p}` : p
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

export function authHeaders() {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  return headers
}

/**
 * 与旧版 app.js 的 apiFetch 行为一致；路径与后端 Fastify 路由一致（无前缀）。
 */
export async function apiFetch(path: string, options: RequestInit = {}) {
  const config: RequestInit = {
    ...options,
    headers: {
      ...authHeaders(),
      ...options.headers,
    },
  }

  const response = await fetch(apiUrl(path), config)
  const text = await response.text()

  let data: any = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text }
    }
  }

  if (!response.ok) {
    const errorMessage =
      data.error || data.message || `${response.status} ${response.statusText}`
    const error = new Error(errorMessage) as Error & { status?: number; data?: unknown }
    error.status = response.status
    error.data = data
    throw error
  }

  return data
}

/** 报表查询：超时与旧版一致（约 90s） */
export async function apiFetchReport(path: string, options: RequestInit = {}) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 90000)

  try {
    return await apiFetch(path, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}
