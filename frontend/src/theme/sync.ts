/** 主题与服务端同步：公司默认主题（免登录可读）、用户所选主题（登录后读写） */
import { apiFetch } from '../utils/api'
import { isThemeId, isThemePref, setCompanyTheme, setThemePref, type ThemeId, type ThemePref } from './index'

export async function loadCompanyTheme() {
  try {
    const r = await apiFetch('/ui/config')
    if (isThemeId(r?.defaultTheme)) setCompanyTheme(r.defaultTheme)
  } catch {
    /* 离线或未迁移：沿用本地缓存 / 内置默认 */
  }
}

/** 登录后：服务端有保存的选择就采用（换设备也能保持） */
export async function loadUserTheme() {
  try {
    const r = await apiFetch('/me/preferences')
    const t = r?.preferences?.theme
    if (isThemePref(t)) setThemePref(t)
  } catch {
    /* 忽略：用本机选择 */
  }
}

/** 用户在设置页切换主题：立即生效，并保存到服务端（null = 恢复公司默认） */
export async function saveUserTheme(pref: ThemePref | null) {
  setThemePref(pref)
  await apiFetch('/me/preferences', { method: 'PUT', body: JSON.stringify({ theme: pref }) })
}

/** 管理员设置公司默认主题 */
export async function saveCompanyTheme(id: ThemeId) {
  await apiFetch('/admin/ui-settings', { method: 'PUT', body: JSON.stringify({ defaultTheme: id }) })
  setCompanyTheme(id)
}
