/**
 * 日期选择器（ui/pickers.tsx 的 DatePicker）用到的纯函数。
 * 值的格式与原生控件一致：date = YYYY-MM-DD，month = YYYY-MM，datetime = YYYY-MM-DDTHH:mm；
 * 都按浏览器本地时间（用户在中国，即北京时间）计算，不经过 toISOString。
 */

export type DateMode = 'date' | 'month' | 'datetime'

export interface DateParts {
  y: number
  m: number // 1-12
  d: number
  hh: number
  mm: number
}

const pad = (n: number) => String(n).padStart(2, '0')

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

export function todayParts(now = new Date()): DateParts {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), hh: now.getHours(), mm: now.getMinutes() }
}

/**
 * 宽松解析：2026-10-29 / 2026/10/29 / 2026.10.29 / 2026年10月29日 / 2026-10-29T08:30 / 2026-10-29 8:30 / 2026-10（月份）。
 * 数字越界返回 null。
 */
export function parseDateValue(raw: unknown): DateParts | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2})\s*日?)?\s*月?(?:[T\s]+(\d{1,2})\s*[:：时]\s*(\d{1,2})\s*分?(?::\d{1,2}(?:\.\d+)?)?)?$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = m[3] != null ? Number(m[3]) : 1
  const hh = m[4] != null ? Number(m[4]) : 0
  const mm = m[5] != null ? Number(m[5]) : 0
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || hh > 23 || mm > 59) return null
  return { y, m: mo, d, hh, mm }
}

export function formatDateValue(p: Pick<DateParts, 'y' | 'm'> & Partial<DateParts>, mode: DateMode): string {
  const ym = `${p.y}-${pad(p.m)}`
  if (mode === 'month') return ym
  const ymd = `${ym}-${pad(p.d ?? 1)}`
  if (mode === 'date') return ymd
  return `${ymd}T${pad(p.hh ?? 0)}:${pad(p.mm ?? 0)}`
}

/** 触发框里显示的文字（datetime 用空格代替 T） */
export function displayDateValue(raw: unknown, mode: DateMode): string {
  const p = parseDateValue(raw)
  if (!p) return raw == null ? '' : String(raw)
  return formatDateValue(p, mode).replace('T', ' ')
}

/** 把任意可解析的输入规范成该模式的值；解析不了返回 null（语音填写等外部输入用） */
export function normalizeDateValue(raw: unknown, mode: DateMode): string | null {
  const p = parseDateValue(raw)
  return p ? formatDateValue(p, mode) : null
}

/** 月历 6 行 × 7 列（周一开头），含上下月补位 */
export function monthGrid(y: number, m: number): { y: number; m: number; d: number; inMonth: boolean }[] {
  const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7 // 周一 = 0
  const cells: { y: number; m: number; d: number; inMonth: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const dt = new Date(y, m - 1, 1 - firstDow + i)
    cells.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), inMonth: dt.getMonth() + 1 === m })
  }
  return cells
}

export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }
}

/** 按字典序比较日期/月份字符串是否在 [min, max] 内（同一格式下字典序即时间顺序） */
export function inRange(value: string, min?: string, max?: string): boolean {
  if (min && value < min.slice(0, value.length)) return false
  if (max && value > max.slice(0, value.length)) return false
  return true
}
