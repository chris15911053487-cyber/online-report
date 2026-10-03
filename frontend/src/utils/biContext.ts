/**
 * 看板点击 → AI 上下文（纯逻辑）。
 *
 * BiPick：用户点中了看板上的什么（卡片、所在下钻级、那一行、当前筛选、口径）。
 * 上下文由程序根据卡片定义自动组装，不需要逐个元素配置；AI 拿到它就知道「用户在问哪个数」，
 * 并能用同一个命名查询 + 参数复查，保证与看板口径一致。
 *
 * 字段与服务端 server/src/bi-context.js 的白名单一致（网关会再规范化、限长）。
 */
import { formatValue, type BiCard, type BiDashboard, type BiFilterValues, type BiScalar } from './bi'
import { columnLabel, valueColumns, type BiRow } from './biOption'
import { rowCaption, type DrillFrame, type LevelView } from './biDrill'

export interface BiPick {
  card: BiCard
  stack: DrillFrame[]
  view: LevelView
  row: BiRow
  /** 当前级结果的列（表格行取全部列） */
  columns: string[]
  /** 屏幕坐标：点击浮层定位 */
  x: number
  y: number
  /** 还能否下钻；能的话下一级的名称 */
  drillLabel: string | null
  drill: () => void
}

export type BiIntent = 'explain' | 'ask'

export interface BiContextPayload {
  dashboardKey: string
  cardId: string
  cardTitle: string
  queryKey: string
  queryLabel?: string
  caliberNote?: string
  path: string[]
  point: Record<string, BiScalar>
  filters: Record<string, BiScalar>
  params: Record<string, BiScalar>
  intent: BiIntent
  /** 仅前端展示用（上下文胶囊文案），网关会丢弃 */
  caption: string
}

const MAX_POINT_FIELDS = 12

function toScalar(v: unknown): BiScalar {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** 点中元素的「标签 → 值」：维度、数值列、对比列；表格行取全部列（限量） */
export function pointFields(pick: BiPick, dims: { column: string; label?: string }[] = []): Record<string, BiScalar> {
  const enc = pick.view.encoding
  const label = (col: string) => dims.find((d) => d.column === col)?.label || columnLabel(enc, col)
  const cols: string[] = []
  const add = (c?: string) => {
    if (c && !cols.includes(c) && c in pick.row) cols.push(c)
  }
  if (pick.view.type === 'table') {
    for (const c of pick.columns) add(c)
  } else {
    add(enc.dimension)
    add(enc.series)
    for (const c of valueColumns(enc)) add(c)
    add(enc.compare)
    add(enc.label)
    // 维度列（编码/名称成对出现时，编码对 AI 复查有用）
    for (const d of dims) add(d.column)
  }
  const out: Record<string, BiScalar> = {}
  for (const c of cols.slice(0, MAX_POINT_FIELDS)) out[label(c)] = toScalar(pick.row[c])
  return out
}

/** 胶囊 / 气泡里显示的短文案：卡片 · 点中的维度值（或 KPI 的数值） */
export function pickCaption(pick: BiPick): string {
  const enc = pick.view.encoding
  const crumb = pick.stack.length > 1 ? pick.stack[pick.stack.length - 1].crumb : pick.card.title
  if (pick.view.type === 'kpi') {
    const v = enc.value ? formatValue(pick.row[enc.value], enc) : ''
    return v ? `${crumb} · ${v}` : crumb
  }
  const c = rowCaption(pick.row, enc)
  return c ? `${crumb} · ${c}` : crumb
}

export function buildBiContext(
  pick: BiPick,
  dashboard: BiDashboard,
  filters: BiFilterValues,
  intent: BiIntent,
): BiContextPayload {
  const meta = dashboard.queries[pick.view.queryKey]
  const filterLabels: Record<string, BiScalar> = {}
  for (const f of dashboard.filters) {
    const v = filters[f.name]
    if (v == null || v === '') continue
    const opt = f.type === 'select' ? f.options?.find((o) => o.value === v) : undefined
    filterLabels[f.label || f.name] = opt ? opt.label : v
  }
  const params: Record<string, BiScalar> = {}
  for (const [k, v] of Object.entries(pick.view.params)) if (v != null && v !== '') params[k] = v
  return {
    dashboardKey: dashboard.dashboardKey,
    cardId: pick.card.id,
    cardTitle: pick.card.title,
    queryKey: pick.view.queryKey,
    queryLabel: meta?.label,
    caliberNote: meta?.caliberNote || undefined,
    path: pick.stack.map((f) => f.crumb),
    point: pointFields(pick, meta?.dimensions),
    filters: filterLabels,
    params,
    intent,
    caption: pickCaption(pick),
  }
}

/** 「AI 解读」发送的那句话（显示在对话里；具体要求由上下文里的 intent=explain 告诉模型） */
export function explainPrompt(ctx: BiContextPayload): string {
  return `解读一下：${ctx.caption}`
}

/** 发给网关的上下文（去掉仅前端用的字段） */
export function toWireContext(ctx: BiContextPayload): Omit<BiContextPayload, 'caption'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { caption, ...wire } = ctx
  return wire
}
