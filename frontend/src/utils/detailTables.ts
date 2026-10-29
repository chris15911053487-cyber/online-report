/**
 * 订单详情（多结果集）的展示整理：标题、可见列、值格式化。
 * 约定：列名以 `_` 开头的不显示；`_title` 列（取首行）作为这一段的标题。
 */
import { formatCardValue } from './reportCard'

export interface DetailTable {
  index?: number
  columns: string[]
  rows: Record<string, unknown>[]
}

const TITLE_COL = '_title'

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '')
}

/** mssql 返回的 DATETIME 序列化成 ISO（墙钟时间 + Z）：只留日期，有时分再带上时分 */
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?Z?$/

export function formatDetailValue(v: unknown): string {
  if (isEmpty(v)) return ''
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'string') {
    const m = ISO_RE.exec(v.trim())
    if (m) return m[2] === '00:00' ? m[1] : `${m[1]} ${m[2]}`
  }
  return formatCardValue(v)
}

/** 去掉 `_` 开头的列和整列为空的列 */
export function visibleColumns(t: DetailTable): string[] {
  return (t.columns || []).filter(
    (c) => !c.startsWith('_') && (t.rows || []).some((r) => !isEmpty(r?.[c])),
  )
}

/** 整列（非空值）都是数字 → 右对齐 */
export function isNumericColumn(col: string, rows: Record<string, unknown>[]): boolean {
  let seen = false
  for (const r of rows) {
    const v = r?.[col]
    if (isEmpty(v)) continue
    if (typeof v === 'number') { seen = true; continue }
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) { seen = true; continue }
    return false
  }
  return seen
}

export function detailTableTitle(t: DetailTable, i: number): string {
  const custom = t.rows?.[0]?.[TITLE_COL]
  if (!isEmpty(custom)) return String(custom).trim()
  if ((t.rows || []).length === 1) return i === 0 ? '订单信息' : '信息'
  return '明细'
}

/**
 * 手机小卡片的列分组：开头连续的文本列（最多 3 个，如 编码 / 名称 / 规格）作卡片抬头，
 * 数字列作数量区，其余文本列按「字段：值」排在下面。
 */
export function splitCardColumns(cols: string[], rows: Record<string, unknown>[]) {
  const numeric = new Set(cols.filter((c) => isNumericColumn(c, rows)))
  const lead: string[] = []
  for (const c of cols) {
    if (numeric.has(c) || lead.length >= 3) break
    lead.push(c)
  }
  const rest = cols.slice(lead.length)
  return {
    lead,
    nums: rest.filter((c) => numeric.has(c)),
    others: rest.filter((c) => !numeric.has(c)),
  }
}
