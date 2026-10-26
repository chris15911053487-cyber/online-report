/**
 * BI 管理（查询库 / 图表库 / 看板编辑器）的纯逻辑：SQL 参数识别、输出列识别、筛选与参数自动绑定、
 * 图表默认配置、看板引用展开、引用完整性检查。
 * 与后端 bi-queries.js / bi-charts.js / bi-dashboards.js 的规则保持一致。
 */
import { defaultChartSize } from './bi'
import type {
  BiCard,
  BiCardRef,
  BiDashboard,
  BiQueryMeta,
  BiCardType,
  BiChartDef,
  BiColumnRole,
  BiColumnSemantic,
  BiDrillLevel,
  BiEncoding,
  BiFilter,
  BiFormat,
  BiParamDef,
  BiValue,
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

/** 系统变量：服务端按当前登录用户自动绑定（与 server/src/bi-queries.js SESSION_PARAMS 一致），不是参数 */
export const SESSION_PARAMS = ['_loginUser', '_loginDisplayName'] as const
const SESSION_PARAM_KEYS = new Set(SESSION_PARAMS.map((n) => n.toLowerCase()))
export const isSessionParam = (name: string) => SESSION_PARAM_KEYS.has(name.replace(/^@/, '').toLowerCase())

/** SQL 中引用的 @参数（排除 @@系统变量、@_loginUser 等会话变量、没加方括号的 @自定义表名），按出现顺序去重（大小写不敏感，保留首次写法） */
export function extractSqlParams(sql: string): string[] {
  const scanned = stripForScan(sql || '')
  const tables = new Set(bareTableRefs(sql).map((n) => n.toLowerCase()))
  const names = new Map<string, string>()
  const re = /(^|[^@\w])@([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(scanned))) {
    const k = m[2].toLowerCase()
    if (!names.has(k) && !SESSION_PARAM_KEYS.has(k) && !tables.has(k)) names.set(k, m[2])
  }
  return [...names.values()]
}

/**
 * 没加方括号的自定义表名（FROM / JOIN 后或 xxx. 后直接跟 @名称，如 FROM @U_OHEC），与服务端 bareTableRefs 同规则。
 * 写成 [@U_OHEC] 或 "@U_OHEC" 的不算。
 */
export function bareTableRefs(sql: string): string[] {
  const scanned = stripForScan(sql || '')
  const out = new Map<string, string>()
  const re = /(?:\b(?:FROM|JOIN|APPLY)\s+(?:\w+\s*\.\s*)?|\.\s*)@([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(scanned))) {
    const k = m[1].toLowerCase()
    if (!out.has(k)) out.set(k, m[1])
  }
  return [...out.values()]
}

/** SQL 用到了哪些会话变量（规范写法，如 ['_loginUser']；注释、字符串里的不算） */
export function sessionParamsUsed(sql: string): string[] {
  const scanned = stripForScan(sql || '')
  const used = new Set<string>()
  const re = /(^|[^@\w])@([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(scanned))) used.add(m[2].toLowerCase())
  return SESSION_PARAMS.filter((n) => used.has(n.toLowerCase()))
}

/** 按参数名猜类型：日期类名 → date；数量类 → number；其余 string（期间 YYYY-MM 也是 string） */
export function guessParamType(name: string): BiParamDef['type'] {
  if (isMonthName(name)) return 'month'
  // 前缀须是独立的词（toDate、from_date、end），避免把 top、total 当日期
  if (/(date|day|dt)$/i.test(name) || /^(?:[Dd]ate|[Ff]rom|[Tt]o|[Ss]tart|[Ee]nd)(?=[A-Z_\d]|$)/.test(name)) return 'date'
  if (/(qty|count|num|top|limit|year|days)$/i.test(name)) return 'number'
  return 'string'
}

/**
 * 参数定义与 SQL 同步：保留已有定义（按名称匹配），补上 SQL 新引用的参数；
 * 返回 unused = 已定义但 SQL 里已不再引用的参数名（由用户决定删除）。
 */
export function syncParamsWithSql(defs: BiParamDef[], sql: string): { params: BiParamDef[]; unused: string[] } {
  const names = extractSqlParams(sql)
  // @_loginUser 等系统变量不是参数：旧数据 / AI 结果里声明了也直接去掉
  defs = defs.filter((d) => !isSessionParam(d.name))
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
const isMonthName = (name: string) => /(period|month|ym)$/i.test(name) || /^(period|month)/i.test(name)

/**
 * 由查询参数生成看板筛选：参数有可选值 / 选项来自查询 / 是/否 → 下拉（多选参数 → 多选下拉），选项一并带出；
 * 月份 / 年份 / 日期按类型与名称识别并给动态默认值；参数自己的默认值优先。
 */
export function filterFromParam(p: BiParamDef): BiFilter {
  const f: BiFilter = { name: p.name, label: p.label || p.name, type: 'string' }
  if (p.options?.length || p.optionsQuery || p.type === 'bool') {
    f.type = 'select'
    if (p.options?.length) f.options = p.options.map((o) => ({ ...o }))
    else if (p.optionsQuery) f.optionsQuery = { ...p.optionsQuery }
    else f.options = [{ value: true, label: '是' }, { value: false, label: '否' }]
    if (p.type === 'list') f.multiple = true
  } else if (p.type === 'date') f.type = 'date'
  else if (p.type === 'month' || isMonthName(p.name)) f.type = 'month'
  else if (/(^|_)(year|yr)$/i.test(p.name) || /^year/i.test(p.name)) f.type = 'year'
  if (p.default != null && (!Array.isArray(p.default) || f.multiple)) f.default = p.default
  else if (f.type === 'month') f.default = '$thisMonth'
  else if (f.type === 'year') f.default = '$thisYear'
  else if (f.type === 'date') f.default = '$today'
  return f
}

/** 看板卡片（含下钻）所用查询的参数，按名称（小写）取第一个；有可选值的优先 */
export function paramDefsOfCards(cards: BiCard[], queries: Map<string, QueryRef>): Map<string, BiParamDef> {
  const out = new Map<string, BiParamDef>()
  const add = (q?: QueryRef) => {
    for (const p of q?.params || []) {
      const k = p.name.toLowerCase()
      const cur = out.get(k)
      if (!cur || (!cur.options?.length && !cur.optionsQuery && (p.options?.length || p.optionsQuery))) out.set(k, p)
    }
  }
  for (const c of cards) {
    add(queries.get(c.queryKey))
    for (const d of c.drill) add(queries.get(d.queryKey))
  }
  return out
}

/** 筛选的下拉选项能否从同名参数带出（参数有选项、筛选还没配或与参数不同） */
export function paramOptionsFor(f: BiFilter, p: BiParamDef | undefined): Pick<BiFilter, 'options' | 'optionsQuery' | 'multiple'> | null {
  if (!p || f.type !== 'select' || (!p.options?.length && !p.optionsQuery)) return null
  const next = p.options?.length ? { options: p.options.map((o) => ({ ...o })), optionsQuery: undefined } : { options: undefined, optionsQuery: { ...p.optionsQuery! } }
  const same = JSON.stringify(f.options ?? null) === JSON.stringify(next.options ?? null) && JSON.stringify(f.optionsQuery ?? null) === JSON.stringify(next.optionsQuery ?? null)
  return same ? null : { ...next, multiple: p.type === 'list' ? true : f.multiple }
}

// ─── 参数取值（与后端 bi-params.js 一致） ───────────────────────────────────

export const PARAM_TOKENS: Partial<Record<BiParamDef['type'], { value: string; label: string }[]>> = {
  date: [
    { value: '$today', label: '今天' },
    { value: '$yesterday', label: '昨天' },
    { value: '$monthStart', label: '本月 1 日' },
    { value: '$yearStart', label: '今年 1 月 1 日' },
  ],
  month: [
    { value: '$thisMonth', label: '本月' },
    { value: '$lastMonth', label: '上月' },
  ],
  number: [
    { value: '$thisYear', label: '今年' },
    { value: '$lastYear', label: '去年' },
  ],
}

const MONTH_RE = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.]\d{1,2})?|(\d{2}))$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/
const LIST_SPLIT_RE = /[,，、;；\n]+/

/** 多选的文本写法拆成数组（逗号、顿号、分号、换行） */
export function splitList(v: BiValue): string[] {
  if (v == null || v === '') return []
  const items = Array.isArray(v) ? v.map(String) : String(v).split(LIST_SPLIT_RE)
  return [...new Set(items.map((x) => x.trim()).filter(Boolean))]
}

/** 固定值是否合法（类型 / 可选值 / 范围）；合法返回 '' */
export function paramValueProblem(p: BiParamDef, v: BiValue | undefined): string {
  if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return ''
  const name = p.label || p.name
  if (typeof v === 'string' && PARAM_TOKENS[p.type]?.some((t) => t.value === v)) return ''
  const notIn = (x: string | number | boolean) =>
    p.options?.length && !p.options.some((o) => String(o.value) === String(x)) ? `参数「${name}」的值「${x}」不在可选值中` : ''
  if (p.type === 'list') {
    for (const x of splitList(v)) {
      const bad = notIn(x)
      if (bad) return bad
    }
    return ''
  }
  if (Array.isArray(v)) return `参数「${name}」不是多选参数，只能是一个值`
  switch (p.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim())
      if (!Number.isFinite(n)) return `参数「${name}」须为数字`
      if (p.min != null && n < p.min) return `参数「${name}」不能小于 ${p.min}`
      if (p.max != null && n > p.max) return `参数「${name}」不能大于 ${p.max}`
      return notIn(n)
    }
    case 'month': {
      const m = String(v).trim().match(MONTH_RE)
      const mo = m ? Number(m[2] ?? m[3]) : 0
      return m && mo >= 1 && mo <= 12 ? '' : `参数「${name}」须为月份（YYYY-MM，如 2026-09）`
    }
    case 'date':
      return DATE_RE.test(String(v).trim()) ? '' : `参数「${name}」须为日期（YYYY-MM-DD）`
    case 'bool':
      return [true, false, 1, 0, '1', '0', 'true', 'false'].includes(v as never) ? '' : `参数「${name}」须为 true / false`
    default:
      return notIn(v)
  }
}

/** 参数定义的问题（编辑器即时提示；与后端 normalizeConstraints / normalizeDefault 一致） */
export function paramDefProblems(p: BiParamDef): string[] {
  const out: string[] = []
  const hasOptions = !!p.options?.length
  if ((hasOptions || p.optionsQuery) && !['string', 'number', 'list'].includes(p.type)) out.push('只有文本 / 数字 / 多选参数能设置可选值')
  if (hasOptions && p.optionsQuery) out.push('固定可选值与「来自查询」只能选一种')
  if (p.optionsQuery && (!p.optionsQuery.queryKey || !p.optionsQuery.valueColumn)) out.push('请选择选项来源的查询与取值列')
  if (hasOptions) {
    const vals = p.options!.map((o) => String(o.value))
    if (new Set(vals).size !== vals.length) out.push('可选值有重复')
    if (p.type === 'number' && vals.some((x) => !Number.isFinite(Number(x)))) out.push('数字参数的可选值须为数字')
  }
  if ((p.min != null || p.max != null) && p.type !== 'number') out.push('只有数字参数能设置范围')
  if (p.min != null && p.max != null && p.min > p.max) out.push('最小值不能大于最大值')
  const dv = paramValueProblem(p, p.default)
  if (dv) out.push(`默认值：${dv.replace(/^参数「[^」]*」/, '')}`)
  return out
}

/** 下拉选项 ⇄ 文本（每行「值=显示名」，值与显示名相同时只写一个） */
export const optionsToText = (options?: BiFilter['options']) =>
  (options || []).map((o) => (String(o.value) === o.label ? o.label : `${o.value}=${o.label}`)).join('\n')
export function textToOptions(text: string): NonNullable<BiFilter['options']> {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('=')
      return i > 0 ? { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() } : { value: l, label: l }
    })
}

const filterRef = (name: string) => `$filter.${name}`

/** 参数取值来源的描述 */
export type ParamSource = { kind: 'filter'; filter: string } | { kind: 'fixed'; value: BiValue } | { kind: 'none' }

export function paramSource(v: BiValue | undefined): ParamSource {
  if (v === undefined) return { kind: 'none' }
  if (typeof v === 'string' && v.startsWith('$filter.')) return { kind: 'filter', filter: v.slice(8) }
  return { kind: 'fixed', value: v }
}

/** 未设置的参数自动绑定同名筛选（大小写不敏感）；已设置的不动 */
export function autoBindParams(
  queryParams: BiParamDef[],
  filters: BiFilter[],
  current: Record<string, BiValue> = {},
): Record<string, BiValue> {
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
  current: { bind: Record<string, string>; params: Record<string, BiValue> },
): { bind: Record<string, string>; params: Record<string, BiValue> } {
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
  } else if (type === 'bar' || type === 'line' || type === 'pie' || type === 'waterfall') {
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
      ? ['value', 'compare', 'label', 'format', 'unit', 'scale', 'trend']
      : type === 'table'
        ? ['columns', 'dimension', 'deltaColumns', 'trend', 'barColumns', 'barShared']
        : type === 'waterfall'
          ? ['dimension', 'value', 'horizontal', 'series', 'total', 'subtotals', 'trend', 'format', 'unit', 'scale', 'labels', 'columns']
          : ['dimension', 'value', 'values', 'series', 'format', 'unit', 'scale', 'topN', 'horizontal', 'stack', 'labels', 'columns', 'rightAxis']
  for (const k of keep) {
    const v = enc[k]
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  if (type !== 'bar') delete out.stack
  if (type !== 'bar' && type !== 'waterfall') delete out.horizontal
  // 瀑布图只有横向才能分栏
  if (type === 'waterfall' && !out.horizontal) delete out.series
  if (type === 'pie' || out.labels === 'auto') delete out.labels
  if (type === 'pie') delete out.rightAxis
  // 瀑布图只有一个数值列：多选时取第一个
  if (type === 'waterfall' && !out.value && enc.values?.length) out.value = enc.values[0]
  if (type === 'table' && !out.barColumns?.length) delete out.barShared
  return out
}

/** 瀑布图的结构问题（与后端 bi-charts.js 的 waterfallProblem 一致）；没有问题返回 '' */
export function waterfallProblem(enc: BiEncoding, type: BiCardType): string {
  if (type !== 'waterfall') {
    if (enc.total || enc.subtotals?.length) return '只有瀑布图能设置合计 / 小计'
    return ''
  }
  if ((enc.values?.length ?? 0) > 1) return '瀑布图只能选一个数值列'
  if (enc.series && !enc.horizontal) return '瀑布图按分栏列拆开（如每年一栏）需要选横向'
  return ''
}

/** 右轴的结构问题（与后端 bi-charts.js 的 rightAxisProblem 一致）；没有问题返回 '' */
export function rightAxisProblem(enc: BiEncoding, type: BiCardType): string {
  if (!enc.rightAxis?.length) return ''
  if (type !== 'bar' && type !== 'line') return '只有柱状 / 折线图能设置右轴'
  if (enc.series) return '按系列列拆分时不能设置右轴'
  if (enc.horizontal) return '横向条形图不能设置右轴'
  const values = enc.values?.length ? enc.values : enc.value ? [enc.value] : []
  const stray = enc.rightAxis.filter((c) => !values.includes(c))
  if (stray.length) return `右轴列「${stray.join('、')}」须是数值列之一`
  if (values.every((c) => enc.rightAxis!.includes(c))) return '至少留一个数值列在左轴'
  return ''
}

/** 堆叠的结构问题（与后端 bi-charts.js 的 stackProblem 一致）；没有问题返回 '' */
export function stackProblem(enc: BiEncoding, type: BiCardType): string {
  if (!enc.stack) return ''
  if (type !== 'bar') return '只有柱状图能堆叠'
  if (enc.series) return ''
  const values = enc.values?.length ? enc.values : enc.value ? [enc.value] : []
  const left = values.filter((c) => !enc.rightAxis?.includes(c))
  if (left.length < 2) return '堆叠需要至少两个柱状数值列，或设置系列列'
  return ''
}

/**
 * 选了数值列后的右轴建议：保留仍在数值列里的右轴列；新选中的百分比列在还有非百分比列时自动放右轴
 * （增长率和金额同图时，增长率走右轴才看得清）。
 */
export function suggestRightAxis(values: string[], prev: BiEncoding, cols: BiColumnSemantic[]): string[] | undefined {
  const before = prev.values?.length ? prev.values : prev.value ? [prev.value] : []
  const isPct = (c: string) => cols.find((x) => x.column === c)?.format === 'percent'
  const kept = (prev.rightAxis || []).filter((c) => values.includes(c))
  const added = values.filter((c) => !before.includes(c) && isPct(c) && !kept.includes(c))
  const right = [...kept, ...added]
  const left = values.filter((c) => !right.includes(c))
  if (left.length === 0 || values.length < 2) return undefined
  return right.length ? right : undefined
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
  for (const v of enc.rightAxis || []) cols.push(v)
  for (const v of enc.deltaColumns || []) cols.push(v)
  for (const v of enc.barColumns || []) cols.push(v)
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
  { requireSources = true, filters = [] }: { requireSources?: boolean; filters?: BiFilter[] } = {},
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
  const checkLevel = (where: string, target: QueryRef, params: Record<string, BiValue>, enc: BiEncoding, type: BiCardType, provided: string[]) => {
    const defs = new Map(target.params.map((p) => [p.name.toLowerCase(), p]))
    for (const [k, v] of Object.entries(params || {})) {
      const def = defs.get(k.toLowerCase())
      if (!def) {
        problems.push(`${where}「${k}」不是查询的参数`)
        continue
      }
      const src = paramSource(v)
      if (filterNames && src.kind === 'filter' && !filterNames.has(src.filter)) problems.push(`${where}参数「${k}」引用的筛选「${src.filter}」不存在`)
      // 多选筛选的值是一组，只能传给多选参数
      const f = src.kind === 'filter' ? filters.find((x) => x.name === src.filter) : undefined
      if (f?.multiple && def.type !== 'list') problems.push(`${where}筛选「${f.label || f.name}」是多选，参数「${def.label || def.name}」不是多选参数`)
      if (src.kind === 'fixed') {
        const bad = paramValueProblem(def, src.value)
        if (bad) problems.push(`${where}${bad}`)
      }
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
    const isChart = type === 'bar' || type === 'line' || type === 'pie' || type === 'waterfall'
    if (isChart && !enc.dimension) problems.push(`${where}图表需要选择维度列`)
    if (isChart && !enc.value && !enc.values?.length) problems.push(`${where}图表需要选择数值列`)
    const wf = waterfallProblem(enc, type)
    if (wf) problems.push(`${where}${wf}`)
    const ra = rightAxisProblem(enc, type)
    if (ra) problems.push(`${where}${ra}`)
    const sp = stackProblem(enc, type)
    if (sp) problems.push(`${where}${sp}`)
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
export function renameFilterRefs<T extends { params?: Record<string, BiValue> }>(refs: T[], from: string, to: string | null): T[] {
  return refs.map((r) => {
    if (!r.params) return r
    const out: Record<string, BiValue> = {}
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

function autoBindFilters(defs: BiParamDef[] | undefined, filters: BiFilter[], taken: Set<string>): Record<string, BiValue> {
  const byLower = new Map(filters.map((f) => [f.name.toLowerCase(), f.name]))
  const out: Record<string, BiValue> = {}
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
  return [...problems, ...cardProblems(card, queries, new Set(filters.map((f) => f.name)), { filters })]
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
  | { kind: 'override'; value: BiValue }
  | { kind: 'fixed'; value: BiValue }
  | { kind: 'filter'; filter: string }
  | { kind: 'default'; value: BiValue }
  | { kind: 'none' }

export function effectiveSource(p: BiParamDef, ref: BiCardRef, chart: BiChartDef, filters: BiFilter[]): EffectiveSource {
  const k = p.name.toLowerCase()
  const find = (o?: Record<string, BiValue>) => Object.entries(o || {}).find(([x]) => x.toLowerCase() === k)
  const ov = find(ref.params)
  if (ov) return { kind: 'override', value: ov[1] }
  const fx = find(chart.params)
  if (fx) return { kind: 'fixed', value: fx[1] }
  const f = filters.find((x) => x.name.toLowerCase() === k)
  if (f) return { kind: 'filter', filter: f.name }
  if (p.default != null) return { kind: 'default', value: p.default }
  return { kind: 'none' }
}

/**
 * 单张图表的预览看板：为没有固定值的参数临时生成筛选（defaults 优先作为默认值，保证有数据），
 * 展开成一张整行卡片。图表有问题时返回 null。
 */
export function chartPreviewDashboard(
  chart: BiChartDef,
  queryMap: Map<string, QueryRef>,
  queries: Record<string, BiQueryMeta>,
  defaults?: Record<string, BiValue>,
): BiDashboard | null {
  if (chartProblems(chart, queryMap).length > 0) return null
  const filters = suggestFilterParams([chartAsCard(chart)], queryMap, [])
    .map(filterFromParam)
    .map((f) => (defaults?.[f.name] != null ? { ...f, default: defaults[f.name] } : f))
  const card = resolveCard({ id: 'preview', chartKey: chart.chartKey }, chart, filters, queryMap)
  return { dashboardKey: '_preview', label: chart.label, filters, cards: [{ ...card, layout: { ...card.layout, w: 12 } }], queries, hiddenCards: 0 }
}
