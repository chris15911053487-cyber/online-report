/**
 * BI 看板：类型定义 + 与界面无关的纯逻辑（筛选默认值、卡片参数解析、数值格式化、JSON 表单解析）。
 * 与后端 server/src/bi-dashboards.js 的结构保持一致。
 */

export type BiCardType = 'kpi' | 'bar' | 'line' | 'pie' | 'waterfall' | 'table'
export type BiFormat = 'number' | 'money' | 'percent' | 'integer'
export type BiScalar = string | number | boolean | null
/** 参数 / 筛选值：多选参数与多选筛选是一组值 */
export type BiValue = BiScalar | (string | number)[]

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
  /** 柱状图堆叠：normal 数值堆叠、percent 百分比堆叠（每根柱子 = 100%）；不写 = 并排 */
  stack?: BiStackMode
  /** 柱/线上是否标数值：auto（默认，按规则）/ show / hide */
  labels?: BiLabelMode
  /** 柱/线组合：数值列中画成折线、走右轴的列（如增长率与金额同图） */
  rightAxis?: string[]
  /** 表格：按正负着色并加 ▲▼ 的列（增长率、差额） */
  deltaColumns?: string[]
  /** 涨跌颜色（KPI 增长率、表格涨跌列、瀑布图增减）：up-good 上涨为好、up-bad 上涨为坏；不写 = 中性色（瀑布图默认增绿减红） */
  trend?: BiTrend
  /** 瀑布图：末尾自动加一根合计柱，值为这个名称（如「营业利润」）；不写 = 不加 */
  total?: string
  /** 瀑布图：维度列取这些值的行画成小计柱（从 0 画到当前累计，该行自身的数值不用），如「毛利」 */
  subtotals?: string[]
  /** 表格：单元格内画数据条的数值列（条长与数值成比例，负数反向着色） */
  barColumns?: string[]
  /** 表格数据条：true = 各列同一比例（同单位的金额列互相比较），不写 = 每列按本列最大值 */
  barShared?: boolean
}

export type BiLabelMode = 'auto' | 'show' | 'hide'
export type BiStackMode = 'normal' | 'percent'
export type BiTrend = 'up-good' | 'up-bad'

export interface BiDrillLevel {
  queryKey: string
  label: string
  bind: Record<string, string>
  params: Record<string, BiValue>
  type: Exclude<BiCardType, 'kpi'>
  encoding: BiEncoding
}

/**
 * 看板里的完整卡片（服务端由「看板引用 + 图表」展开得到，运行时只认它）。
 * chartKey：来源图表（管理端预览 / 定位用）。
 */
export interface BiCard {
  id: string
  chartKey?: string
  type: BiCardType
  title: string
  subtitle?: string
  queryKey: string
  params: Record<string, BiValue>
  encoding: BiEncoding
  drill: BiDrillLevel[]
  layout: { w: number; h: number }
}

/** 图表库中的图表：引用一个查询 + 展示方式；参数只写固定值，其余由看板同名筛选提供 */
export interface BiChartDef {
  chartKey: string
  label: string
  subtitle?: string
  description?: string
  type: BiCardType
  queryKey: string
  params: Record<string, BiValue>
  encoding: BiEncoding
  drill: BiDrillLevel[]
  size: { w: number; h: number }
  enabled: boolean
}

/** 看板对图表的引用：标题、参数（$filter.xxx 或固定值）、尺寸都可选覆盖 */
export interface BiCardRef {
  id: string
  chartKey: string
  title?: string
  params?: Record<string, BiValue>
  layout?: { w: number; h: number }
}

export interface BiOption {
  value: string | number | boolean
  label: string
}

/** 选项来自另一条命名查询（POST /bi/options 按取值 / 显示列去重） */
export interface BiOptionsQuery {
  queryKey: string
  valueColumn: string
  labelColumn?: string
}

export interface BiFilter {
  name: string
  label: string
  type: 'month' | 'year' | 'date' | 'string' | 'select'
  /** 多选（仅下拉）：值为数组，只能传给多选参数；不选 = 全部 */
  multiple?: boolean
  default?: BiValue
  options?: BiOption[]
  /** 下拉选项来自查询（与 options 二选一） */
  optionsQuery?: BiOptionsQuery
}

/**
 * 查询参数（与后端 bi-params.js 一致）：
 * month = 'YYYY-MM' 文本；list = 多个值（绑定为 JSON 数组文本，SQL 里 IN (SELECT value FROM OPENJSON(@x))）
 */
export type BiParamType = 'string' | 'number' | 'date' | 'bool' | 'month' | 'list'
export interface BiParamDef {
  name: string
  type: BiParamType
  label?: string
  required?: boolean
  default?: BiValue
  /** 固定可选值（文本 / 数字 / 多选）：传入其它值会被拒绝 */
  options?: BiOption[]
  /** 可选值来自查询（与 options 二选一） */
  optionsQuery?: BiOptionsQuery
  /** 数字的取值范围 */
  min?: number
  max?: number
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

export type BiFilterValues = Record<string, BiValue>

/** 卡片高度档位（layout.h 1~4）对应的图表内容高度（px） */
export const BI_CARD_HEIGHT: Record<number, number> = { 1: 170, 2: 260, 3: 360, 4: 460 }

/** 按图表类型的默认尺寸（12 栅格）：KPI 1/4 矮；折线 / 表格整行；柱状半宽；饼图 1/3；瀑布图 2/3 */
export function defaultChartSize(type: BiCardType): { w: number; h: number } {
  if (type === 'kpi') return { w: 3, h: 1 }
  if (type === 'line' || type === 'table') return { w: 12, h: 2 }
  if (type === 'pie') return { w: 4, h: 2 }
  if (type === 'waterfall') return { w: 8, h: 2 }
  return { w: 6, h: 2 }
}

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
    case '$thisYear':
      return String(now.getFullYear())
    case '$lastYear':
      return String(now.getFullYear() - 1)
    default:
      return null
  }
}

/** 全局筛选的初始值 */
export function initialFilterValues(filters: BiFilter[], now: Date = new Date()): BiFilterValues {
  const out: BiFilterValues = {}
  for (const f of filters) {
    if (Array.isArray(f.default)) {
      out[f.name] = f.multiple ? f.default : null
      continue
    }
    let v = resolveDefaultToken(f.default, now)
    // 单选下拉没写默认值时选第一项；多选不写 = 全部；来自查询的选项此时还没取到，先为空（= 全部）
    if (v == null && f.type === 'select' && !f.multiple && f.options?.length) v = f.options[0].value
    out[f.name] = v ?? null
  }
  return out
}

/** 卡片 / 下钻的参数映射：'$filter.x' 取筛选值，其余原样 */
export function resolveCardParams(
  params: Record<string, BiValue> | undefined,
  filters: BiFilterValues,
): Record<string, BiValue> {
  const out: Record<string, BiValue> = {}
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
  // 主度量取左轴第一列（右轴的增长率等不决定整张图的格式）
  const left = (enc.values?.length ? enc.values : enc.value ? [enc.value] : []).filter((c) => !enc.rightAxis?.includes(c))
  const primary = byName.get(left[0] ?? '')
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

// ─── 标题 / 列名占位符 ────────────────────────────────────────────────────────

/**
 * 筛选当前值的显示文字：select 取选项文字（如 yoy → 去年同期），多选列前 3 项，其余原样；
 * loaded：来自查询的选项（筛选条取到后传入）。
 * 供标题 / 列名里的 {筛选名} 占位符；与后端 bi-tokens.js 的 filterDisplayText 一致。
 */
export function filterDisplayText(filters: BiFilter[], values: BiFilterValues, loaded: Record<string, BiOption[]> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of filters) {
    const v = values[f.name]
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    const options = f.options ?? loaded[f.name]
    const text = (x: string | number | boolean) => (f.type === 'select' ? options?.find((o) => String(o.value) === String(x))?.label : undefined) ?? String(x)
    out[f.name] = Array.isArray(v) ? joinValues(v.map(text)) : text(v)
  }
  return out
}

/** 多选的显示：最多列 3 项，其余写「等 N 项」（与后端 bi-tokens.js 一致） */
export function joinValues(items: string[]): string {
  return items.length <= 3 ? items.join('、') : `${items.slice(0, 3).join('、')} 等 ${items.length} 项`
}

/** 把文本里的 {名称} 换成 vars 里的值（名称大小写不敏感）；没有对应值的原样保留 */
export function fillPlaceholders(text: string, vars: Record<string, unknown>): string {
  if (!text.includes('{')) return text
  const map = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]))
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
    const v = map.get(name.toLowerCase())
    return v == null || v === '' ? m : String(v)
  })
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

/**
 * 表格数据条的比例尺：每列的最大绝对值（条长 = |值| / 最大值）。
 * shared：各列取同一个最大值（同单位的金额列互相比较，如收入 / 成本 / 毛利）；全为空或 0 的列为 0（不画条）。
 */
export function dataBarScale(rows: Record<string, unknown>[], columns: string[], shared = false): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of columns) out[c] = rows.reduce<number>((m, r) => Math.max(m, Math.abs(toNumber(r[c]) ?? 0)), 0)
  if (shared) {
    const max = Math.max(0, ...Object.values(out))
    for (const c of columns) out[c] = max
  }
  return out
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
