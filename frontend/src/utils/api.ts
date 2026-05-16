export const TOKEN_KEY = 'online_report_token'

/** dev uses Vite proxy /api; production is same-origin (matching legacy app.js) */
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

export interface ApiError extends Error {
  status?: number
  data?: any
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const config: RequestInit = {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers as Record<string, string>),
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
    let line = data.error || data.message || `${response.status} ${response.statusText}`
    if (data.code) line += ` [${data.code}]`
    const error: ApiError = new Error(String(line).trim() || '请求失败')
    error.status = response.status
    error.data = data
    throw error
  }

  return data
}

/**
 * Report queries with configurable timeout (default 90s, matching legacy app.js).
 */
export async function apiFetchReport(
  path: string,
  options: RequestInit = {},
  timeoutMs = 90000,
) {
  const controller = new AbortController()
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 90000
  const timeoutId = setTimeout(() => controller.abort(), ms)

  try {
    return await apiFetch(path, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}
