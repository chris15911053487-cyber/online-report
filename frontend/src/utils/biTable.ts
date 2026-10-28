/**
 * 明细表（下钻明细面板）的纯逻辑：搜索、按列筛选、多列排序、合计、复制为 TSV。
 * 只处理已取回的结果行（≤ BI_MAX_ROWS），不再查库。
 */
import { formatValue, toNumber, type BiColumnDef, type BiColumnSemantic } from './bi'
import type { BiRow } from './biOption'

export interface SortKey {
  column: string
  dir: 'asc' | 'desc'
}

/** 单元格的显示文字（搜索、复制都按它，和用户看到的一致） */
export function cellText(v: unknown, col: Pick<BiColumnDef, 'format'>): string {
  if (v == null) return ''
  if (col.format) return formatValue(v, { format: col.format })
  return String(v)
}

/**
 * 点表头：没排 → 升序 → 降序 → 取消。
 * additive（Shift + 点击）：在已有排序后追加 / 切换这一列；否则只按这一列排。
 */
export function toggleSort(sorts: SortKey[], column: string, additive: boolean): SortKey[] {
  const cur = sorts.find((s) => s.column === column)
  const next: SortKey | null = !cur ? { column, dir: 'asc' } : cur.dir === 'asc' ? { column, dir: 'desc' } : null
  if (!additive) return next ? [next] : []
  const rest = sorts.filter((s) => s.column !== column)
  if (!next) return rest
  return cur ? sorts.map((s) => (s.column === column ? next : s)) : [...rest, next]
}

function compare(a: unknown, b: unknown): number {
  // 空值总在最后（不论升降序，由调用方处理）
  const na = toNumber(a)
  const nb = toNumber(b)
  if (na != null && nb != null) return na - nb
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true })
}

/** 多列排序（稳定）；空值始终排在最后 */
export function sortRows(rows: BiRow[], sorts: SortKey[]): BiRow[] {
  if (sorts.length === 0) return rows
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      for (const s of sorts) {
        const a = x.r[s.column]
        const b = y.r[s.column]
        const ea = a == null || a === ''
        const eb = b == null || b === ''
        if (ea || eb) {
          if (ea && eb) continue
          return ea ? 1 : -1
        }
        const c = compare(a, b)
        if (c !== 0) return s.dir === 'asc' ? c : -c
      }
      return x.i - y.i
    })
    .map((x) => x.r)
}

/**
 * 搜索（任一列包含）+ 按列筛选（每列包含，全部满足）；不区分大小写，按显示文字匹配。
 */
export function filterRows(rows: BiRow[], cols: BiColumnDef[], search: string, colFilters: Record<string, string>): BiRow[] {
  const q = search.trim().toLowerCase()
  const per = Object.entries(colFilters)
    .map(([c, v]) => [c, v.trim().toLowerCase()] as const)
    .filter(([, v]) => v)
  if (!q && per.length === 0) return rows
  const byName = new Map(cols.map((c) => [c.column, c]))
  return rows.filter((r) => {
    for (const [c, v] of per) {
      if (!cellText(r[c], byName.get(c) ?? {}).toLowerCase().includes(v)) return false
    }
    if (!q) return true
    return cols.some((c) => cellText(r[c.column], c).toLowerCase().includes(q))
  })
}

/**
 * 可合计的列：列语义为度量（measure）且不是百分比；没登记语义的列，全部非空值都是数字才算。
 * 维度 / 时间 / 属性列（编码、年份、单号）不合计。
 */
export function summableColumns(cols: BiColumnDef[], rows: BiRow[], semantics: BiColumnSemantic[] = []): string[] {
  const sem = new Map(semantics.map((s) => [s.column, s]))
  return cols
    .filter((c) => {
      if (c.format === 'percent') return false
      const s = sem.get(c.column)
      if (s) return s.role === 'measure' && s.format !== 'percent'
      let seen = false
      for (const r of rows) {
        const v = r[c.column]
        if (v == null || v === '') continue
        if (typeof v === 'boolean' || toNumber(v) == null) return false
        seen = true
      }
      return seen
    })
    .map((c) => c.column)
}

export function sumColumns(rows: BiRow[], columns: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of columns) out[c] = rows.reduce((s, r) => s + (toNumber(r[c]) ?? 0), 0)
  return out
}

/** 复制为 TSV（粘到 Excel 自动分列）：表头用显示名，数值保留原值不加千分位 */
export function toTsv(cols: BiColumnDef[], rows: BiRow[], label: (c: BiColumnDef) => string): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
  const cell = (v: unknown, c: BiColumnDef) => {
    if (v == null) return ''
    const n = toNumber(v)
    if (n != null && c.format !== 'percent') return String(n)
    return clean(cellText(v, c))
  }
  return [cols.map((c) => clean(label(c))).join('\t'), ...rows.map((r) => cols.map((c) => cell(r[c.column], c)).join('\t'))].join('\n')
}
