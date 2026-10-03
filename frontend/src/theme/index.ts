/**
 * 界面主题：六套主题的元数据、应用与持久化，以及给 ECharts 用的取色函数。
 *
 * - 实际取值在 themes.css（CSS 变量）；这里只负责切换 <html data-ui-theme>。
 * - 用户选择存 localStorage（秒开，index.html 的内联脚本在渲染前就会应用），登录后再与服务端同步。
 * - 'system'：系统浅色时用公司默认主题，系统深色时用 F（dark）。
 * - themes.css 的选择器是 [data-ui-theme=x]，任意元素都可局部套用某个主题（设置页的预览卡就是这样做的）。
 */
import { useEffect, useSyncExternalStore } from 'react'

export type ThemeId = 'warm' | 'tech' | 'ent' | 'ind' | 'mono' | 'dark'
export type ThemePref = ThemeId | 'system'

export interface ThemeMeta {
  id: ThemeId
  name: string
  description: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'warm', name: 'D 暖色人文风', description: '象牙白底、陶土橙、衬线标题' },
  { id: 'ent', name: 'B 稳重企业风', description: '单一蓝色、信息密度高' },
  { id: 'tech', name: 'A 科技风', description: '青-靛-紫渐变点缀' },
  { id: 'ind', name: 'C 深色工业风', description: '深色框架、等宽数字' },
  { id: 'mono', name: 'E 极简黑白风', description: '黑白灰，颜色只留给状态' },
  { id: 'dark', name: 'F 全深色', description: '夜间、大屏' },
]

export const THEME_IDS = THEMES.map((t) => t.id)
export const FALLBACK_THEME: ThemeId = 'warm'
export const THEME_PREF_KEY = 'online_report_theme'
export const COMPANY_THEME_KEY = 'online_report_company_theme'

export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as string[]).includes(v)
export const isThemePref = (v: unknown): v is ThemePref => v === 'system' || isThemeId(v)

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等不可写时忽略，主题仍在本次会话生效 */
  }
}

/** 偏好 + 公司默认 + 系统明暗 → 实际主题（纯函数，便于测试） */
export function resolveTheme(pref: ThemePref | null | undefined, companyDefault: ThemeId | null | undefined, systemDark: boolean): ThemeId {
  const base = isThemeId(companyDefault) ? companyDefault : FALLBACK_THEME
  if (pref === 'system') return systemDark ? 'dark' : base
  return isThemeId(pref) ? pref : base
}

const darkQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

let currentPref: ThemePref | null = (() => {
  const v = readStorage(THEME_PREF_KEY)
  return isThemePref(v) ? v : null
})()
let companyDefault: ThemeId | null = (() => {
  const v = readStorage(COMPANY_THEME_KEY)
  return isThemeId(v) ? v : null
})()

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function getThemePref(): ThemePref | null {
  return currentPref
}
export function getCompanyTheme(): ThemeId {
  return companyDefault ?? FALLBACK_THEME
}
export function getActiveTheme(): ThemeId {
  return resolveTheme(currentPref, companyDefault, darkQuery()?.matches ?? false)
}

function apply() {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.uiTheme = getActiveTheme()
  emit()
}

/** 用户选择主题（null = 不设置，跟随公司默认） */
export function setThemePref(pref: ThemePref | null) {
  currentPref = pref
  writeStorage(THEME_PREF_KEY, pref)
  apply()
}

/** 服务端下发的公司默认主题 */
export function setCompanyTheme(id: ThemeId | null) {
  companyDefault = isThemeId(id) ? id : null
  writeStorage(COMPANY_THEME_KEY, companyDefault)
  apply()
}

let started = false
/** 启动时调用一次：应用主题并在「跟随系统」时监听系统明暗变化 */
export function initTheme() {
  if (started) return
  started = true
  apply()
  darkQuery()?.addEventListener?.('change', () => {
    if (currentPref === 'system') apply()
  })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 当前主题与偏好；主题切换时组件重渲染 */
export function useTheme() {
  const active = useSyncExternalStore(subscribe, getActiveTheme, () => FALLBACK_THEME)
  const pref = useSyncExternalStore(subscribe, getThemePref, () => null)
  return { active, pref, company: getCompanyTheme(), setPref: setThemePref }
}

/** 主题切换时执行回调（图表重绘等） */
export function useThemeChange(cb: (theme: ThemeId) => void) {
  useEffect(() => subscribe(() => cb(getActiveTheme())), [cb])
}

/** 读一个颜色 token，返回 CSS 可用的 rgb(...) 字符串 */
export function tokenColor(name: string, alpha = 1): string {
  if (typeof document === 'undefined') return 'currentColor'
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name.startsWith('--') ? name : `--c-${name}`).trim()
  if (!raw) return 'currentColor'
  return alpha >= 1 ? `rgb(${raw})` : `rgb(${raw} / ${alpha})`
}

/** ECharts 用的配色：系列色 + 文字/轴线色 */
export function readChartPalette() {
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => tokenColor(`chart-${i}`)),
    text: tokenColor('muted'),
    strongText: tokenColor('fg'),
    axisLine: tokenColor('line'),
    splitLine: tokenColor('line', 0.6),
    tooltipBg: tokenColor('surface'),
    tooltipBorder: tokenColor('line'),
    font: getComputedStyle(document.documentElement).getPropertyValue('--font-num').trim() || undefined,
  }
}

/** 内联样式里引用颜色 token：tv('primary') → 'rgb(var(--c-primary))'，tv('line', 0.5) 带透明度 */
export const tv = (name: string, alpha?: number) => (alpha == null ? `rgb(var(--c-${name}))` : `rgb(var(--c-${name}) / ${alpha})`)

/** 读一个颜色 token 的 #rrggbb 形式（给 <input type="color"> 等只接受十六进制的场合） */
export function tokenHex(name: string): string {
  if (typeof document === 'undefined') return '#000000'
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--c-${name}`).trim()
  const parts = raw.split(/\s+/).map(Number)
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return '#000000'
  return '#' + parts.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('')
}
