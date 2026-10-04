/**
 * BI 管理（查询库 / 图表库 / 看板编辑器）的纯逻辑：SQL 参数识别、输出列识别、筛选与参数自动绑定、
 * 图表默认配置、看板引用展开、引用完整性检查。
 * 与后端 bi-queries.js / bi-charts.js / bi-dashboards.js 的规则保持一致。
 */
import { defaultChartSize } from './bi'
import type {
  BiCard,
  BiCardRef,
  BiCardType,
  BiChartDef,
  BiColumnRole,
  BiColumnSemantic,
  BiDrillLevel,
  BiEncoding,
  BiFilter,
  BiFormat,
  BiParamDef,
  BiScalar,
} from './bi'

// ─── SQL 参数 ────────────────────────────────────────────────────────────────

/** 去掉注释、字符串、[标识符]、"标识符"，避免把其中的 @xxx 当参数；未闭合时尽量处理到末尾 */
function stripForScan(text: string): string {
  let out = ''
  let i = 0
  const s = text
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (c === '-' && n === '-') {
      const end = s.indexOf('\n', i)
      i = end < 0 ? s.length : end
      out += ' '
      continue
    }
    if (c === '/' && n === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 2
      out += ' '
      continue
    }
    if (c === "'" || ((c === 'N' || c === 'n') && n === "'")) {
      let j = c === "'" ? i + 1 : i + 2
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j += 1
      }
      i = j + 1
      out += "''"
      continue
    }
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"'
      const end = s.indexOf(close, i + 1)
      i = end < 0 ? s.length : end + 1
      out += '[x]'
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** SQL 中引用的 @参数（排除 @@系统变量），按出现顺序去重（大小写不敏感，保留首次写法） */
export function extractSqlParams(sql: string): string[] {
  const scanned = stripForScan(sql || '')
  const names = new Map<string, string>()
  const re = /(^|[^@\w])@([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(scanned))) {
    const k = m[2].toLowerCase()
    if (!names.has(k)) names.set(k, m[2])
  }
  return [...names.values()]
}

/** 按参数名猜类型：日期类名 → date；数量类 → number；其余 string（期间 YYYY-MM 也是 string） */
export function guessParamType(name: string): BiParamDef['type'] {
  if (/(date|day|dt)$/i.test(name) || /^(date|from|to|start|end)/i.test(name)) return 'date'
  if (/(qty|count|num|top|limit|year|days)$/i.test(name)) return 'number'
  return 'string'
}

/**
 * 参数定义与 SQL 同步：保留已有定义（按名称匹配），补上 SQL 新引用的参数；
 * 返回 unused = 已定义但 SQL 里已不再引用的参数名（由用户决定删除）。
 */
export function syncParamsWithSql(defs: BiParamDef[], sql: string): { params: BiParamDef[]; unused: string[] } {
  const names = extractSqlParams(sql)
  const byLower = new Map(defs.map((d) => [d.name.toLowerCase(), d]))
  const inSql = new Set(names.map((n) => n.toLowerCase()))
  const params: BiParamDef[] = []
  for (const n of names) {
    params.push(byLower.get(n.toLowerCase()) ?? { name: n, type: guessParamType(n), label: '', required: false })
  }
  const unused: string[] = []
  for (const d of defs) {
    if (!inSql.has(d.name.toLowerCase())) {
      params.push(d)
      unused.push(d.name)
    }
  }
  return { params, unused }
}

// ─── 输出列识别 ─────────────────────────────────────────────────────────────

const NUMERIC_TYPE = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)/
const TIME_TYPE = /^(date|datetime|datetime2|smalldatetime|datetimeoffset|time)/
const CODE_NAME = /(code|id|entry|no|num|key|编码|编号|代码|单号)$/i
const TIME_NAME = /(date|period|month|year|ym|日期|期间|月份|年度|年月)/i

/** 猜列角色：数据库类型优先，其次列名与样本值 */
export function guessColumnRole(name: string, sqlType?: string, sample?: unknown): BiColumnRole {
  const t = (sqlType || '').toLowerCase()
  if (TIME_TYPE.test(t)) return 'time'
  if (t === 'bit') return 'attr'
  if (NUMERIC_TYPE.test(t) || (!t && typeof sample === 'number')) {
    return CODE_NAME.test(name) ? 'attr' : 'measure'
  }
  if (TIME_NAME.test(name)) return 'time'
  if (CODE_NAME.test(name)) return 'attr'
  return 'dimension'
}

/** 猜度量的显示格式 */
export function guessMeasureFormat(name: string): BiFormat {
  if (/(rate|ratio|pct|percent|率|占比)/i.test(name)) return 'percent'
  if (/(qty|count|cnt|quantity|数量|次数|个数|笔数)/i.test(name)) return 'integer'
  if (/(amt|amount|total|balance|price|cost|sales|revenue|金额|余额|销售额|收入|成本|单价)/i.test(name)) return 'money'
  return 'number'
}

/**
 * 试运行得到的结果列 → 列语义：已登记的列保留原设置，新列按类型/列名猜角色与格式。
 * 顺序以结果列为准；removed = 已登记但结果里没有的列（保存后引用它们的卡片会报问题）。
 */
export function mergeDetectedColumns(
  existing: BiColumnSemantic[],
  resultColumns: string[],
  columnTypes: Record<string, string> = {},
  firstRow?: Record<string, unknown>,
): { columns: BiColumnSemantic[]; added: string[]; removed: string[] } {
  const byName = new Map(existing.map((c) => [c.column, c]))
  const added: string[] = []
  const columns = resultColumns.map((name) => {
    const old = byName.get(name)
    if (old) return old
    added.push(name)
    const role = guessColumnRole(name, columnTypes[name], firstRow?.[name])
    const col: BiColumnSemantic = { column: name, label: '', role }
    if (role === 'measure') col.format = guessMeasureFormat(name)
    return col
  })
  const inResult = new Set(resultColumns)
  const removed = existing.filter((c) => !inResult.has(c.column)).map((c) => c.column)
  return { columns, added, removed }
}

export const COLUMN_ROLE_LABEL: Record<BiColumnRole, string> = {
  dimension: '维度',
  measure: '度量',
  time: '时间',
  attr: '属性',
}

export const FORMAT_LABEL: Record<BiFormat, string> = {
  number: '数值',
  money: '金额',
  percent: '百分比',
  integer: '整数',
}

/** 列在下拉里的显示：中文名（列名） */
export function columnOptionLabel(c: BiColumnSemantic): string {
  return c.label && c.label !== c.column ? `${c.label}（${c.column}）` : c.column
}

// ─── 筛选与参数绑定 ─────────────────────────────────────────────────────────

/** 由查询参数生成一个全局筛选（名称一致，后续卡片可自动绑定） */
export function filterFromParam(p: BiParamDef): BiFilter {
  let type: BiFilter['type'] = 'string'
  if (p.type === 'date') type = 'date'
  else if (/(period|month|ym)$/i.test(p.name) || /^(period|month)/i.test(p.name)) type = 'month'
  const f: BiFilter = { name: p.name, label: p.label || p.name, type }
  if (type === 'month') f.default = '$thisMonth'
  else if (type === 'date') f.default = '$today'
  return f
}

const filterRef = (name: string) => `$filter.${name}`

/** 参数取值来源的描述 */
export type ParamSource = { kind: 'filter'; filter: string } | { kind: 'fixed'; value: BiScalar } | { kind: 'none' }

export function paramSource(v: BiScalar | undefined): ParamSource {
  if (v === undefined) return { kind: 'none' }
  if (typeof v === 'string' && v.startsWith('$filter.')) return { kind: 'filter', filter: v.slice(8) }
  return { kind: 'fixed', value: v }
}

/** 未设置的参数自动绑定同名筛选（大小写不敏感）；已设置的不动 */
export function autoBindParams(
  queryParams: BiParamDef[],
  filters: BiFilter[],
  current: Record<string, BiScalar> = {},
): Record<string, BiScalar> {
  const out = { ...current }
  const setKeys = new Set(Object.keys(out).map((k) => k.toLowerCase()))
  for (const p of queryParams) {
    if (setKeys.has(p.name.toLowerCase())) continue
    const f = filters.find((x) => x.name.toLowerCase() === p.name.toLowerCase())
    if (f) out[p.name] = filterRef(f.name)
  }
  return out
}

/**
 * 下钻自动绑定：目标查询的参数优先从上一级同名列取值（bind），其次同名筛选（params）。
 * 已有设置保留。
 */
export function autoBindDrill(
  targetParams: BiParamDef[],
  sourceColumns: string[],
  filters: BiFilter[],
  current: { bind: Record<string, string>; params: Record<string, BiScalar> },
): { bind: Record<string, string>; params: Record<string, BiScalar> } {
  const bind = { ...current.bind }
  const params = { ...current.params }
  const taken = new Set([...Object.keys(bind), ...Object.keys(params)].map((k) => k.toLowerCase()))
  for (const p of targetParams) {
    const k = p.name.toLowerCase()
    if (taken.has(k)) continue
    const col = sourceColumns.find((c) => c.toLowerCase() === k)
    if (col) {
      bind[p.name] = col
      continue
    }
    const f = filters.find((x) => x.name.toLowerCase() === k)
    if (f) params[p.name] = filterRef(f.name)
  }
  return { bind, params }
}

// ─── 卡片默认配置 ───────────────────────────────────────────────────────────

const firstOf = (cols: BiColumnSemantic[], roles: BiColumnRole[]) => {
  for (const r of roles) {
    const c = cols.find((x) => x.role === r)
    if (c) return c.column
  }
  return undefined
}

/** 按卡片类型从列语义挑默认的维度 / 度量（只填空着的字段） */
export function defaultEncoding(type: BiCardType, cols: BiColumnSemantic[], current: BiEncoding = {}): BiEncoding {
  const enc: BiEncoding = { ...current }
  const measure = firstOf(cols, ['measure'])
  if (type === 'kpi') {
    if (!enc.value && measure) enc.value = measure
    delete enc.dimension
  } else if (type === 'bar' || type === 'line' || type === 'pie') {
    if (!enc.dimension) enc.dimension = firstOf(cols, type === 'line' ? ['time', 'dimension', 'attr'] : ['dimension', 'time', 'attr'])
    if (!enc.value && !enc.values?.length && measure) enc.value = measure
  }
  if (!enc.dimension) delete enc.dimension
  if (!enc.value) delete enc.value
  return enc
}

export function newDrillLevel(): BiDrillLevel {
  return { queryKey: '', label: '', bind: {}, params: {}, type: 'table', encoding: {} }
}

/** 某类型下 encoding 中无意义的字段去掉，避免切换类型后残留 */
export function cleanEncoding(type: BiCardType, enc: BiEncoding): BiEncoding {
  const out: BiEncoding = {}
  const keep: (keyof BiEncoding)[] =
    type === 'kpi'
      ? ['value', 'compare', 'label', 'format', 'unit', 'scale']
      : type === 'table'
        ? ['columns', 'dimension']
        : ['dimension', 'value', 'values', 'series', 'format', 'unit', 'scale', 'topN', 'horizontal', 'columns']
  for (const k of keep) {
    const v = enc[k]
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  if (type !== 'bar') delete out.horizontal
  return out
}

// ─── 引用完整性（与后端 checkDashboardRefs 一致） ───────────────────────────

export interface QueryRef {
  queryKey: string
  label: string
  params: BiParamDef[]
  columns?: BiColumnSemantic[]
}

function encodingColumns(enc: BiEncoding): string[] {
  const cols: string[] = []
  for (const f of ['dimension', 'value', 'compare', 'series', 'label'] as const) if (enc[f]) cols.push(enc[f] as string)
  for (const v of enc.values || []) cols.push(v)
  for (const c of enc.columns || []) cols.push(c.column)
  return cols
}

/**
 * 单张卡片（或图表）的问题列表（空 = 通过）；未选查询 / 查询不存在 / 引用了不存在的筛选也算问题。
 * requireSources = false：不要求必填参数有来源（图表自身：由看板同名筛选提供）。
 */
export function cardProblems(
  card: BiCard,
  queries: Map<string, QueryRef>,
  filterNames?: Set<string>,
  { requireSources = true }: { requireSources?: boolean } = {},
): string[] {
  const problems: string[] = []
  if (!card.title.trim()) problems.push('标题不能为空')
  const q = queries.get(card.queryKey)
  if (!q) {
    problems.push(card.queryKey ? `查询「${card.queryKey}」不存在` : '未选择查询')
    return problems
  }
  const names = (x: QueryRef) => new Set(x.params.map((p) => p.name.toLowerCase()))
  const colSet = (x: QueryRef) => (x.columns?.length ? new Set(x.columns.map((c) => c.column)) : null)
  const checkLevel = (where: string, target: QueryRef, params: Record<string, BiScalar>, enc: BiEncoding, type: BiCardType, provided: string[]) => {
    const n = names(target)
    for (const [k, v] of Object.entries(params || {})) {
      if (!n.has(k.toLowerCase())) problems.push(`${where}「${k}」不是查询的参数`)
      const src = paramSource(v)
      if (filterNames && src.kind === 'filter' && !filterNames.has(src.filter)) problems.push(`${where}参数「${k}」引用的筛选「${src.filter}」不存在`)
    }
    const have = new Set([...Object.keys(params || {}), ...provided].map((k) => k.toLowerCase()))
    for (const p of requireSources ? target.params : []) {
      if (p.required && p.default == null && !have.has(p.name.toLowerCase())) {
        problems.push(`${where}必填参数「${p.label || p.name}」没有取值来源`)
      }
    }
    const cols = colSet(target)
    if (cols) for (const c of encodingColumns(enc)) if (!cols.has(c)) problems.push(`${where}列「${c}」不在查询的输出列中`)
    if (type === 'kpi' && !enc.value) problems.push(`${where}KPI 需要选择数值列`)
    if ((type === 'bar' || type === 'line' || type === 'pie') && !enc.dimension) problems.push(`${where}图表需要选择维度列`)
    if ((type === 'bar' || type === 'line' || type === 'pie') && !enc.value && !enc.values?.length) problems.push(`${where}图表需要选择数值列`)
  }
  checkLevel('', q, card.params, card.encoding, card.type, [])
  let source = q
  const bound: string[] = []
  card.drill.forEach((d, i) => {
    const where = `第 ${i + 1} 级下钻：`
    const target = queries.get(d.queryKey)
    if (!d.label.trim()) problems.push(`${where}名称不能为空`)
    if (!target) {
      problems.push(d.queryKey ? `${where}查询「${d.queryKey}」不存在` : `${where}未选择查询`)
      return
    }
    const n = names(target)
    const srcCols = colSet(source)
    for (const [p, col] of Object.entries(d.bind)) {
      if (!n.has(p.toLowerCase())) problems.push(`${where}「${p}」不是查询的参数`)
      if (srcCols && !srcCols.has(col)) problems.push(`${where}取值列「${col}」不在上一级的输出列中`)
      bound.push(p)
    }
    checkLevel(where, target, d.params, d.encoding, d.type, bound)
    source = target
  })
  return problems
}

/** 筛选改名 / 删除（to = null）时同步看板卡片（引用）里的 $filter 覆盖；删除时去掉该参数映射 */
export function renameFilterRefs<T extends { params?: Record<string, BiScalar> }>(refs: T[], from: string, to: string | null): T[] {
  return refs.map((r) => {
    if (!r.params) return r
    const out: Record<string, BiScalar> = {}
    for (const [k, v] of Object.entries(r.params)) {
      if (v === filterRef(from)) {
        if (to) out[k] = filterRef(to)
      } else out[k] = v
    }
    return { ...r, params: out }
  })
}

/**
 * 建议建成全局筛选的参数：卡片 / 下钻所用查询里，没有取值来源、没有同名筛选、也没有默认值的参数
 * （按名称去重，必填的排前面）。cards 为展开后的完整卡片。
 */
export function suggestFilterParams(cards: BiCard[], queries: Map<string, QueryRef>, filters: BiFilter[]): BiParamDef[] {
  const have = new Set(filters.map((f) => f.name.toLowerCase()))
  const out = new Map<string, BiParamDef>()
  const consider = (q: QueryRef | undefined, provided: string[]) => {
    if (!q) return
    const given = new Set(provided.map((k) => k.toLowerCase()))
    for (const p of q.params) {
      const k = p.name.toLowerCase()
      // 有默认值的参数（如 Top N）不建议做成筛选
      if (have.has(k) || given.has(k) || out.has(k) || p.default != null) continue
      out.set(k, p)
    }
  }
  for (const c of cards) {
    consider(queries.get(c.queryKey), Object.keys(c.params))
    const bound: string[] = []
    for (const d of c.drill) {
      bound.push(...Object.keys(d.bind))
      consider(queries.get(d.queryKey), [...bound, ...Object.keys(d.params)])
    }
  }
  return [...out.values()].sort((a, b) => Number(!!b.required) - Number(!!a.required))
}

// ─── 图表与看板引用（与后端 bi-charts.js 一致） ─────────────────────────────

export function newChart(): BiChartDef {
  return { chartKey: '', label: '', type: 'bar', queryKey: '', params: {}, encoding: {}, drill: [], size: defaultChartSize('bar'), enabled: true }
}

/** 图表当作一张独立卡片（编辑器预览、问题检查用） */
export function chartAsCard(chart: BiChartDef, id = 'preview'): BiCard {
  return {
    id,
    chartKey: chart.chartKey,
    type: chart.type,
    title: chart.label,
    subtitle: chart.subtitle,
    queryKey: chart.queryKey,
    params: chart.params,
    encoding: chart.encoding,
    drill: chart.drill,
    layout: chart.size,
  }
}

/** 图表自身的问题：不要求必填参数有来源 */
export function chartProblems(chart: BiChartDef, queries: Map<string, QueryRef>): string[] {
  const problems = cardProblems(chartAsCard(chart), queries, undefined, { requireSources: false })
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(chart.chartKey)) problems.unshift('图表标识须为小写字母开头，仅含小写字母、数字、下划线、连字符')
  return problems
}

const lowerKeys = (o?: Record<string, unknown>) => new Set(Object.keys(o || {}).map((k) => k.toLowerCase()))
const withoutKeys = <V,>(o: Record<string, V> | undefined, keys: Set<string>) =>
  Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.has(k.toLowerCase()))) as Record<string, V>

function autoBindFilters(defs: BiParamDef[] | undefined, filters: BiFilter[], taken: Set<string>): Record<string, BiScalar> {
  const byLower = new Map(filters.map((f) => [f.name.toLowerCase(), f.name]))
  const out: Record<string, BiScalar> = {}
  for (const p of defs || []) {
    const k = p.name.toLowerCase()
    if (taken.has(k)) continue
    const f = byLower.get(k)
    if (f) out[p.name] = filterRef(f)
  }
  return out
}

/**
 * 看板引用 + 图表 → 完整卡片。参数优先级：看板覆盖 > 图表固定值 > 同名筛选；
 * 下钻：bind 最优先，看板覆盖作用于同名参数，其后为该级固定值、同名筛选。
 */
export function resolveCard(ref: BiCardRef, chart: BiChartDef, filters: BiFilter[], queries: Map<string, QueryRef>): BiCard {
  const overrides = ref.params || {}
  const overrideKeys = lowerKeys(overrides)
  const fixed = withoutKeys(chart.params, overrideKeys)
  const taken = new Set([...overrideKeys, ...lowerKeys(fixed)])
  const params = { ...fixed, ...autoBindFilters(queries.get(chart.queryKey)?.params, filters, taken), ...overrides }
  const bound = new Set<string>()
  const drill = chart.drill.map((d) => {
    for (const k of Object.keys(d.bind || {})) bound.add(k.toLowerCase())
    const target = queries.get(d.queryKey)
    const names = new Set((target?.params || []).map((p) => p.name.toLowerCase()))
    const over = Object.fromEntries(Object.entries(overrides).filter(([k]) => names.has(k.toLowerCase()) && !bound.has(k.toLowerCase())))
    const own = withoutKeys(d.params, new Set([...lowerKeys(over), ...bound]))
    const t = new Set([...bound, ...lowerKeys(own), ...lowerKeys(over)])
    return { ...d, params: { ...own, ...autoBindFilters(target?.params, filters, t), ...over } }
  })
  return {
    id: ref.id,
    chartKey: chart.chartKey,
    type: chart.type,
    title: ref.title || chart.label,
    subtitle: chart.subtitle,
    queryKey: chart.queryKey,
    params,
    encoding: chart.encoding,
    drill,
    layout: ref.layout || chart.size,
  }
}

/** 看板一张卡片（引用）的问题：图表缺失 / 停用，或展开后引用完整性不通过 */
export function refProblems(ref: BiCardRef, chart: BiChartDef | undefined, filters: BiFilter[], queries: Map<string, QueryRef>): string[] {
  if (!ref.chartKey) return ['未选择图表']
  if (!chart) return [`图表「${ref.chartKey}」不存在`]
  const problems = chart.enabled ? [] : ['图表已停用，看板上不会显示']
  const card = resolveCard(ref, chart, filters, queries)
  return [...problems, ...cardProblems(card, queries, new Set(filters.map((f) => f.name)))]
}

/** 新卡片 id：优先用 chartKey，重复时加序号 */
export function nextRefId(chartKey: string, existing: string[]): string {
  const used = new Set(existing)
  const base = /^[A-Za-z]/.test(chartKey) ? chartKey : `c_${chartKey}`
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

/**
 * 参数在看板里的实际来源（看板卡片编辑时展示）：
 * override = 看板覆盖；fixed = 图表固定值；filter = 同名筛选自动提供；default = 查询默认值；none = 没有来源。
 */
export type EffectiveSource =
  | { kind: 'override'; value: BiScalar }
  | { kind: 'fixed'; value: BiScalar }
  | { kind: 'filter'; filter: string }
  | { kind: 'default'; value: BiScalar }
  | { kind: 'none' }

export function effectiveSource(p: BiParamDef, ref: BiCardRef, chart: BiChartDef, filters: BiFilter[]): EffectiveSource {
  const k = p.name.toLowerCase()
  const find = (o?: Record<string, BiScalar>) => Object.entries(o || {}).find(([x]) => x.toLowerCase() === k)
  const ov = find(ref.params)
  if (ov) return { kind: 'override', value: ov[1] }
  const fx = find(chart.params)
  if (fx) return { kind: 'fixed', value: fx[1] }
  const f = filters.find((x) => x.name.toLowerCase() === k)
  if (f) return { kind: 'filter', filter: f.name }
  if (p.default != null) return { kind: 'default', value: p.default }
  return { kind: 'none' }
}
