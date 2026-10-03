/**
 * 卡片内下钻（纯逻辑）：层级栈 + 参数推导 + 面包屑文案。
 *
 * 第 0 级 = 卡片本身；第 i 级 = card.drill[i-1]。
 * 点中某行进入下一级时：下一级参数 = 之前各级累积的绑定值 + 该级 params（$filter 解析）+ 本次 bind 从行里取的列值。
 * 累积是为了让第 3 级仍能拿到第 1 级绑定的客户编码等；服务端只绑定查询声明过的参数，多传无害。
 */
import { resolveCardParams, type BiCard, type BiCardType, type BiEncoding, type BiFilterValues, type BiScalar } from './bi'
import type { BiRow } from './biOption'

export interface DrillFrame {
  /** 0 = 卡片本身，i = card.drill[i-1] */
  level: number
  /** 该级绑定得到的参数（不含 $filter 解析结果，便于筛选变化时重新解析） */
  bound: Record<string, BiScalar>
  /** 面包屑文案 */
  crumb: string
  /** 进入该级时点中的上一级行（用于 AI 上下文） */
  fromRow?: BiRow
}

export interface LevelView {
  queryKey: string
  type: BiCardType
  encoding: BiEncoding
  params: Record<string, BiScalar>
}

export function rootStack(card: BiCard): DrillFrame[] {
  return [{ level: 0, bound: {}, crumb: card.title }]
}

/** 当前栈顶对应的查询、展示方式与最终参数 */
export function levelView(card: BiCard, stack: DrillFrame[], filters: BiFilterValues): LevelView {
  const top = stack[stack.length - 1]
  if (!top || top.level === 0) {
    return { queryKey: card.queryKey, type: card.type, encoding: card.encoding, params: resolveCardParams(card.params, filters) }
  }
  const d = card.drill[top.level - 1]
  return {
    queryKey: d.queryKey,
    type: d.type,
    encoding: d.encoding,
    params: { ...top.bound, ...resolveCardParams(d.params, filters), ...pickBound(top.bound, d.bind) },
  }
}

/** bind 取到的值优先级最高，避免被同名的 $filter 覆盖 */
function pickBound(bound: Record<string, BiScalar>, bind: Record<string, string>): Record<string, BiScalar> {
  const out: Record<string, BiScalar> = {}
  for (const p of Object.keys(bind)) if (p in bound) out[p] = bound[p]
  return out
}

/** 是否还能往下钻 */
export function canDrillFrom(card: BiCard, stack: DrillFrame[]): boolean {
  const top = stack[stack.length - 1]
  return !!top && top.level < card.drill.length
}

/** 下一级的名称（菜单里「下钻到 xx」） */
export function nextDrillLabel(card: BiCard, stack: DrillFrame[]): string | null {
  if (!canDrillFrom(card, stack)) return null
  return card.drill[stack[stack.length - 1].level].label
}

function scalar(v: unknown): BiScalar {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** 点中的行在当前级上的显示名：维度列的值，否则第一个 bind 列的值 */
export function rowCaption(row: BiRow, enc: BiEncoding, bind?: Record<string, string>): string {
  if (enc.dimension && row[enc.dimension] != null) return String(row[enc.dimension])
  const firstCol = bind ? Object.values(bind)[0] : undefined
  if (firstCol && row[firstCol] != null) return String(row[firstCol])
  const first = Object.values(row).find((v) => v != null && typeof v !== 'object')
  return first == null ? '' : String(first)
}

/**
 * 点中 row 进入下一级；已到最深一级返回原栈。
 * currentEncoding 用于生成面包屑（点中的是哪个维度值）。
 */
export function pushDrill(card: BiCard, stack: DrillFrame[], row: BiRow, currentEncoding: BiEncoding): DrillFrame[] {
  if (!canDrillFrom(card, stack)) return stack
  const top = stack[stack.length - 1]
  const next = card.drill[top.level]
  const bound: Record<string, BiScalar> = { ...top.bound }
  for (const [param, col] of Object.entries(next.bind)) bound[param] = scalar(row[col])
  const caption = rowCaption(row, currentEncoding, next.bind)
  return [...stack, { level: top.level + 1, bound, crumb: caption ? `${caption} · ${next.label}` : next.label, fromRow: row }]
}

/** 面包屑回到第 index 级（含） */
export function popDrillTo(stack: DrillFrame[], index: number): DrillFrame[] {
  if (index < 0 || index >= stack.length - 1) return stack
  return stack.slice(0, index + 1)
}
