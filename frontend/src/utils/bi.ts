/**
 * BI 看板：类型定义 + 与界面无关的纯逻辑（筛选默认值、卡片参数解析、数值格式化、JSON 表单解析）。
 * 与后端 server/src/bi-dashboards.js 的结构保持一致。
 */

export type BiCardType = 'kpi' | 'bar' | 'line' | 'pie' | 'table'
export type BiFormat = 'number' | 'money' | 'percent' | 'integer'
export type BiScalar = string | number | boolean | null

export interface BiColumnDef {
  column: string
  label?: string
  format?: BiFormat
}

export interface BiEncoding {
  dimension?: string
  value?: string
  values?: string[]
  compare?: string
  series?: string
  label?: string
  columns?: BiColumnDef[]
  format?: BiFormat
  unit?: string
  scale?: number
  topN?: number
  horizontal?: boolean
}

export interface BiDrillLevel {
  queryKey: string
  label: string
  bind: Record<string, string>
  params: Record<string, BiScalar>
  type: Exclude<BiCardType, 'kpi'>
  encoding: BiEncoding
}

export interface BiCard {
  id: string
  type: BiCardType
  title: string
  subtitle?: string
  queryKey: string
  params: Record<string, BiScalar>
  encoding: BiEncoding
  drill: BiDrillLevel[]
  layout: { w: number; h: number }
}

export interface BiFilter {
  name: string
  label: string
  type: 'month' | 'date' | 'string' | 'select'
  default?: BiScalar
  options?: { value: string | number | boolean; label: string }[]
}

export interface BiParamDef {
  name: string
  type: 'string' | 'number' | 'date' | 'bool'
  label?: string
  required?: boolean
  default?: BiScalar
}

/** 查询输出列的语义（查询库登记）：维度 / 度量 / 时间 / 属性，以及默认展示格式 */
export type BiColumnRole = 'dimension' | 'measure' | 'time' | 'attr'
export interface BiColumnSemantic {
  column: string
  label?: string
  role: BiColumnRole
  format?: BiFormat
  unit?: string
  scale?: number
}

export interface BiQueryMeta {
  queryKey: string
  label: string
  description?: string
  params: BiParamDef[]
  columns?: BiColumnSemantic[]
  dimensions: { column: string; label?: string }[]
  caliberNote?: string
  cacheSecs?: number
}

/** GET /agents/:agentKey/dashboard 返回的看板（已按角色裁剪） */
export interface BiDashboard {
  dashboardKey: string
  label: string
  description?: string
  filters: BiFilter[]
  cards: BiCard[]
  queries: Record<string, BiQueryMeta>
  hiddenCards: number
}

/** POST /bi/query 的返回 */
export interface BiQueryResult {
  queryKey: string
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  asOf: string
  cached: boolean
  stale: boolean
  params: Record<string, unknown>
}

export type BiFilterValues = Record<string, BiScalar>

// ─── 筛选默认值 ───────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

/** 解析默认值记号（$thisMonth 等）；按浏览器本地日期计算 */
export function resolveDefaultToken(value: BiScalar | undefined, now: Date = new Date()): BiScalar {
  if (typeof value !== 'string' || !value.startsWith('$')) return value ?? null
  switch (value) {
    case '$today':
      return ymd(now)
    case '$yesterday':
      return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
    case '$thisMonth':
      return ym(now)
    case '$lastMonth':
      return ym(new Date(now.getFullYear(), now.getMonth() - 1, 1))
    case '$monthStart':
      return ymd(new Date(now.getFullYear(), now.getMonth(), 1))
    case '$yearStart':
      return `${now.getFullYear()}-01-01`
    default:
      return null
  }
}

/** 全局筛选的初始值 */
export function initialFilterValues(filters: BiFilter[], now: Date = new Date()): BiFilterValues {
  const out: BiFilterValues = {}
  for (const f of filters) {
    let v = resolveDefaultToken(f.default, now)
    if (v == null && f.type === 'select' && f.options?.length) v = f.options[0].value
    out[f.name] = v ?? null
  }
  return out
}

/** 卡片 / 下钻的参数映射：'$filter.x' 取筛选值，其余原样 */
export function resolveCardParams(
  params: Record<string, BiScalar> | undefined,
  filters: BiFilterValues,
): Record<string, BiScalar> {
  const out: Record<string, BiScalar> = {}
  for (const [k, v] of Object.entries(params || {})) {
    out[k] = typeof v === 'string' && v.startsWith('$filter.') ? (filters[v.slice(8)] ?? null) : v
  }
  return out
}

/**
 * 卡片 encoding 叠加查询的列语义（卡片没写的才继承）：
 * - format / scale / unit 取主度量列（value 或 values[0]）的设置；
 * - 列显示名与格式：encoding.columns 已配置时补齐缺的 label / format；未配置时按 resultColumns
 *   （表格的实际结果列）或已登记的列生成，图表系列名、表头因此显示中文名。
 */
export function withColumnSemantics(enc: BiEncoding, semantics?: BiColumnSemantic[], resultColumns?: string[]): BiEncoding {
  if (!semantics || semantics.length === 0) return enc
  const byName = new Map(semantics.map((c) => [c.column, c]))
  const out: BiEncoding = { ...enc }
  const primary = byName.get(enc.value ?? enc.values?.[0] ?? '')
  if (primary) {
    if (out.format == null && primary.format) out.format = primary.format
    if (out.scale == null && primary.scale) out.scale = primary.scale
    if (out.unit == null && primary.unit) out.unit = primary.unit
  }
  const fill = (c: BiColumnDef): BiColumnDef => {
    const sem = byName.get(c.column)
    const def: BiColumnDef = { column: c.column }
    const label = c.label || sem?.label
    const format = c.format || (sem?.role === 'measure' ? sem.format : undefined)
    if (label) def.label = label
    if (format) def.format = format
    return def
  }
  const base: BiColumnDef[] = enc.columns?.length
    ? enc.columns
    : (resultColumns ?? semantics.map((c) => c.column)).map((column) => ({ column }))
  out.columns = base.map(fill)
  return out
}

// ─── 数值 ─────────────────────────────────────────────────────────────────────

/** 取数值；SQL Server 的 decimal 经 mssql 可能是字符串 */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 按 encoding 格式化数值：scale（如 10000 → 万）、format、unit */
export function formatValue(
  v: unknown,
  enc: Pick<BiEncoding, 'format' | 'scale' | 'unit'> = {},
  opts: { withUnit?: boolean } = {},
): string {
  const n = toNumber(v)
  if (n == null) return v == null || v === '' ? '—' : String(v)
  const scaled = enc.scale ? n / enc.scale : n
  let s: string
  switch (enc.format) {
    case 'percent':
      s = `${(scaled * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
      break
    case 'integer':
      s = Math.round(scaled).toLocaleString('zh-CN')
      break
    case 'money':
      s = scaled.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      break
    default:
      s = scaled.toLocaleString('zh-CN', { maximumFractionDigits: Math.abs(scaled) >= 100 ? 0 : 2 })
  }
  return opts.withUnit !== false && enc.unit && enc.format !== 'percent' ? `${s} ${enc.unit}` : s
}

/** 环比/同比变化：返回比例（0.12 = +12%），基数为 0 或缺失时为 null */
export function changeRatio(cur: unknown, prev: unknown): number | null {
  const c = toNumber(cur)
  const p = toNumber(prev)
  if (c == null || p == null || p === 0) return null
  return (c - p) / Math.abs(p)
}

// ─── 管理界面：JSON 文本框解析 ────────────────────────────────────────────────

export type JsonFieldResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * 解析管理表单里的 JSON 文本框。空白视为空数组/空对象；类型不符给出中文提示。
 */
export function parseJsonField<T = unknown>(
  text: string,
  label: string,
  expect: 'array' | 'object',
): JsonFieldResult<T> {
  const t = text.trim()
  if (!t) return { ok: true, value: (expect === 'array' ? [] : {}) as T }
  let v: unknown
  try {
    v = JSON.parse(t)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `「${label}」不是合法的 JSON：${msg}` }
  }
  if (expect === 'array' && !Array.isArray(v)) return { ok: false, error: `「${label}」须为 JSON 数组 [ … ]` }
  if (expect === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) {
    return { ok: false, error: `「${label}」须为 JSON 对象 { … }` }
  }
  return { ok: true, value: v as T }
}

/** 把值格式化成便于编辑的 JSON 文本（空数组/对象 → 空字符串） */
export function toJsonText(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v) && v.length === 0) return ''
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) return ''
  return JSON.stringify(v, null, 2)
}
