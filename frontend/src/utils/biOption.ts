/**
 * BI 卡片 → ECharts option（纯函数，便于测试）。
 *
 * option 只在这里由代码生成，不接受配置里的函数字符串（ChartRenderer 的 reviveFunctions 会执行
 * "function(...)" 字符串，看板配置不能走那条路）。
 *
 * 颜色不在这里设置：渲染时由 utils/chartTheme.ts 按当前主题统一套用。
 *
 * 同时返回 rowAt(dataIndex, seriesName)：把 ECharts 点击事件映射回结果集里的那一行，
 * 供下钻（bind 取列值）和「问 AI」（组装上下文）使用。
 */
import { formatValue, toNumber, type BiEncoding } from './bi'

export type BiRow = Record<string, unknown>
export type BiChartType = 'bar' | 'line' | 'pie' | 'waterfall'

export interface ChartModel {
  option: Record<string, unknown>
  /** 点击事件 → 对应的结果行；找不到返回 null */
  rowAt: (dataIndex: number, seriesName?: string) => BiRow | null
  /** 实际参与绘图的行数（topN 截断后） */
  plotted: number
  /** 点在图形之间的空白处：坐标轴上的值 [x, y] → dataIndex（不写 = 按类目序号）；找不到返回 null */
  pickIndex?: (value: number[]) => number | null
  /** 结果行 → 图上的位置（明细面板打开时高亮来源项）；不支持的图（瀑布图）不提供 */
  indexOf?: (row: BiRow) => ChartPoint | null
}

export interface ChartPoint {
  dataIndex: number
  /** 长表透视（多系列）时是哪个系列；不写 = 该类目的所有系列 */
  seriesName?: string
}

/** 数值列：values 优先，其次 value */
export function valueColumns(enc: BiEncoding): string[] {
  if (enc.values && enc.values.length > 0) return enc.values
  return enc.value ? [enc.value] : []
}

/** 列的显示名：encoding.columns 里配置的 label，否则列名本身 */
export function columnLabel(enc: BiEncoding, col: string): string {
  return enc.columns?.find((c) => c.column === col)?.label || col
}

const str = (v: unknown) => (v == null ? '' : String(v))

/** 「自动」时标数值的上限：竖柱 ≤12 根、横向条形 ≤20 根（再多会挤） */
export const AUTO_LABEL_MAX_BARS = 12
export const AUTO_LABEL_MAX_HBARS = 20

/**
 * 柱/线上的数值标签：
 * - show：全部标；hide：不标
 * - auto：单系列柱形图且柱子不多时标；多系列、柱子很多不标；折线只标最后一个点（最新值）
 */
export function labelPlan(type: 'bar' | 'line', enc: BiEncoding, seriesCount: number, categoryCount: number): 'all' | 'last' | 'none' {
  const mode = enc.labels || 'auto'
  if (mode === 'show') return 'all'
  if (mode === 'hide') return 'none'
  if (seriesCount !== 1) return 'none'
  if (type === 'line') return categoryCount > 0 ? 'last' : 'none'
  const max = enc.horizontal ? AUTO_LABEL_MAX_HBARS : AUTO_LABEL_MAX_BARS
  return categoryCount > 0 && categoryCount <= max ? 'all' : 'none'
}

/** 坐标轴用紧凑格式（不带单位，单位放在轴名上；金额不显示小数位） */
function axisFormatter(enc: Pick<BiEncoding, 'format' | 'scale'>) {
  const format = enc.format === 'money' ? 'number' : enc.format
  return (v: number) => formatValue(v, { format, scale: enc.scale }, { withUnit: false })
}

/**
 * 实际生效的右轴列：只在柱 / 线、未按系列拆分、非横向时生效，且至少留一列在左轴
 * （与后端 bi-charts.js 的 rightAxisProblem 一致；配置不合法时退回单轴）。
 */
export function rightAxisColumns(type: BiChartType, enc: BiEncoding): string[] {
  if (type === 'pie' || enc.series || enc.horizontal || !enc.rightAxis?.length) return []
  const cols = valueColumns(enc)
  const right = enc.rightAxis.filter((c) => cols.includes(c))
  return right.length < cols.length ? right : []
}

/** 向上取「好看」的步长：1 / 2 / 2.5 / 5 × 10^n */
function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const m = [1, 2, 2.5, 5, 10].find((s) => s * p >= x * (1 - 1e-9)) ?? 10
  return Number((m * p).toPrecision(12))
}

export interface AxisRange {
  min: number
  max: number
  interval: number
}

/**
 * 双轴共用同样的格数，且 0 落在同一条格线上（左轴金额、右轴增长率有负数时，0% 与柱子底边对齐，
 * 负增长的点不会画在柱子底边上方）。逐个试总格数（4~6）和「0 以下几格」，取两根轴留白之和最小的方案。
 * 任一轴没有数值时返回 null（交给 ECharts 自动定刻度）。
 */
export function alignedAxisRanges(left: (number | null)[], right: (number | null)[]): [AxisRange, AxisRange] | null {
  const bounds = (vals: (number | null)[]) => {
    const nums = vals.filter((v): v is number => v != null && Number.isFinite(v))
    if (nums.length === 0) return null
    const lo = Math.min(0, ...nums)
    const hi = Math.max(0, ...nums)
    return lo === hi ? { lo: 0, hi: 1 } : { lo, hi }
  }
  const axes = [bounds(left), bounds(right)]
  if (!axes[0] || !axes[1]) return null
  const b = axes as { lo: number; hi: number }[]

  let best: { score: number; ranges: [AxisRange, AxisRange] } | null = null
  // 先试 5 格，留白相同时保留 5 格
  for (const splits of [5, 6, 4]) {
    for (let k = 0; k <= splits; k++) {
      if (b.some((a) => (a.lo < 0 && k === 0) || (a.hi > 0 && k === splits))) continue
      const ranges = b.map(({ lo, hi }) => {
        const step = niceStep(Math.max(hi > 0 ? hi / (splits - k) : 0, lo < 0 ? -lo / k : 0))
        return { min: k === 0 ? 0 : -Number((k * step).toPrecision(12)), max: Number(((splits - k) * step).toPrecision(12)), interval: step }
      }) as [AxisRange, AxisRange]
      const score = ranges.reduce((s, r, i) => s + 1 - (b[i].hi - b[i].lo) / (r.max - r.min), 0)
      if (!best || score < best.score - 1e-9) best = { score, ranges }
    }
  }
  return best?.ranges ?? null
}

interface TooltipParam {
  axisValueLabel?: string
  marker?: string
  seriesName?: string
  seriesIndex: number
  dataIndex: number
  value: unknown
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function percentTooltip(
  ps: TooltipParam[],
  rawData: (number | null)[][],
  isRight: (i: number) => boolean,
  enc: BiEncoding,
  rightFormat: BiEncoding['format'],
): string {
  const head = ps[0]?.axisValueLabel ?? ''
  const lines = ps.map((p) => {
    const raw = rawData[p.seriesIndex]?.[p.dataIndex]
    const text = isRight(p.seriesIndex)
      ? formatValue(raw, { format: rightFormat })
      : raw == null
        ? '—'
        : `${formatValue(toNumber(p.value), { format: 'percent' })}（${formatValue(raw, enc)}）`
    return `${p.marker ?? ''}${escapeHtml(p.seriesName ?? '')}&nbsp;&nbsp;<b>${escapeHtml(text)}</b>`
  })
  return [escapeHtml(head), ...lines].join('<br/>')
}

export function buildChartModel(
  type: BiChartType,
  enc: BiEncoding,
  allRows: BiRow[],
  opts: { clickable?: boolean } = {},
): ChartModel {
  if (type === 'waterfall') return buildWaterfallModel(enc, allRows, opts)
  const cursor = opts.clickable ? 'pointer' : 'default'
  const rows = enc.topN ? allRows.slice(0, enc.topN) : allRows
  const dim = enc.dimension || ''
  const cols = valueColumns(enc)
  const tooltipValue = (v: unknown) => formatValue(v, enc)

  if (type === 'pie') {
    const col = cols[0] || ''
    return {
      plotted: rows.length,
      rowAt: (i) => rows[i] ?? null,
      indexOf: (row) => indexIn(rows, row),
      option: {
        tooltip: { trigger: 'item', valueFormatter: tooltipValue },
        legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 11 } },
        series: [
          {
            type: 'pie',
            radius: ['42%', '70%'],
            center: ['50%', '45%'],
            avoidLabelOverlap: true,
            cursor,
            label: { formatter: '{b}\n{d}%', fontSize: 11 },
            data: rows.map((r) => ({ name: str(r[dim]), value: toNumber(r[col]) })),
          },
        ],
      },
    }
  }

  const horizontal = type === 'bar' && !!enc.horizontal
  let categories: string[]
  let series: Record<string, unknown>[]
  let rowAt: ChartModel['rowAt']
  let indexOf: ChartModel['indexOf']

  if (enc.series) {
    // 长表透视：dimension × series → value（只取第一个数值列）
    const sCol = enc.series
    const col = cols[0] || ''
    categories = []
    const seriesNames: string[] = []
    const cell = new Map<string, BiRow>()
    for (const r of rows) {
      const c = str(r[dim])
      const s = str(r[sCol])
      if (!categories.includes(c)) categories.push(c)
      if (!seriesNames.includes(s)) seriesNames.push(s)
      cell.set(`${c}\u0000${s}`, r)
    }
    series = seriesNames.map((s) => ({
      name: s,
      type,
      data: categories.map((c) => toNumber(cell.get(`${c}\u0000${s}`)?.[col])),
    }))
    rowAt = (i, s) => (categories[i] != null && s != null ? cell.get(`${categories[i]}\u0000${s}`) ?? null : null)
    indexOf = (row) => {
      const hit = indexIn(rows, row)
      if (hit == null) return null
      const r = rows[hit.dataIndex]
      return { dataIndex: categories.indexOf(str(r[dim])), seriesName: str(r[sCol]) }
    }
  } else {
    categories = rows.map((r) => str(r[dim]))
    series = cols.map((col) => ({
      name: columnLabel(enc, col),
      type,
      data: rows.map((r) => toNumber(r[col])),
    }))
    rowAt = (i) => rows[i] ?? null
    indexOf = (row) => indexIn(rows, row)
  }

  // 右轴：增长率等画成折线，有自己的格式（列语义里的 format，通常是百分比）
  const right = enc.series ? [] : rightAxisColumns(type, enc)
  const rightFormat = enc.columns?.find((c) => c.column === right[0])?.format
  const isRight = (i: number) => right.includes(cols[i])
  const leftCount = series.length - right.length

  // 堆叠（仅柱状图）：左轴的柱子叠成一根；百分比堆叠把每个类目换算成占比（0~1），原值留给 tooltip
  const stack = type === 'bar' && leftCount > 1 ? enc.stack : undefined
  const percent = stack === 'percent'
  const rawData = series.map((s) => s.data as (number | null)[])
  if (stack) {
    series.forEach((s, i) => {
      if (!isRight(i)) s.stack = 'total'
    })
  }
  if (percent) {
    const totals = categories.map((_, j) => series.reduce((sum, _s, i) => (isRight(i) ? sum : sum + Math.abs(rawData[i][j] ?? 0)), 0))
    series.forEach((s, i) => {
      if (!isRight(i)) s.data = rawData[i].map((v, j) => (v == null || !totals[j] ? v : v / totals[j]))
    })
  }
  const leftFormatter = percent ? axisFormatter({ format: 'percent' }) : axisFormatter(enc)

  const plan = labelPlan(type, enc, leftCount, categories.length)
  // 右轴折线：自动时只标最新值（如本月增长率）
  const rightPlan = enc.labels === 'show' ? 'all' : enc.labels === 'hide' || categories.length === 0 ? 'none' : 'last'
  // 标签与坐标轴同样用紧凑格式（单位在轴名上）
  const makeLabel = (fmt: (v: number) => string) => ({
    show: true,
    position: horizontal ? 'right' : 'top',
    fontSize: 11,
    formatter: (p: { value: unknown }) => {
      const n = toNumber(Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value)
      return n == null ? '' : fmt(n)
    },
  })
  const label = { ...makeLabel(leftFormatter), ...(stack ? { position: 'inside' } : {}) }
  const rightLabel = makeLabel(axisFormatter({ format: rightFormat }))

  series.forEach((s, i) => {
    const onRight = isRight(i)
    const p = onRight ? rightPlan : plan
    const l = onRight ? rightLabel : label
    s.cursor = cursor
    if (onRight) {
      Object.assign(s, {
        type: 'line',
        yAxisIndex: 1,
        // 增长率逐月跳动，平滑曲线会在两点之间画出不存在的起伏，用折线
        smooth: false,
        symbolSize: 6,
        z: 3,
        tooltip: { valueFormatter: (v: unknown) => formatValue(v, { format: rightFormat }) },
      })
    } else {
      if (type === 'line') Object.assign(s, { smooth: true, symbolSize: 6 })
      if (type === 'bar') Object.assign(s, { barMaxWidth: 28 })
    }
    if (p === 'all') s.label = l
    if (p === 'last') {
      const data = s.data as (number | null)[]
      const last = data.length - 1
      s.data = data.map((v, j) => (j === last && v != null ? { value: v, label: l } : v))
    }
  })

  const categoryAxis = {
    type: 'category',
    data: categories,
    inverse: horizontal, // 横向条形图：第一名在最上面
    axisLabel: { fontSize: 11, hideOverlap: true },
    axisTick: { alignWithLabel: true },
  }
  const valueAxis = {
    type: 'value',
    name: enc.unit && enc.format !== 'percent' && !percent ? enc.unit : '',
    nameTextStyle: { fontSize: 11 },
    axisLabel: { fontSize: 11, formatter: leftFormatter },
    ...(percent ? { max: 1 } : {}),
    splitLine: { show: true },
  }
  const rightAxis = {
    type: 'value',
    position: 'right',
    axisLabel: { fontSize: 11, formatter: axisFormatter({ format: rightFormat }) },
    splitLine: { show: false },
  }
  if (right.length) {
    // 两轴的 0 对齐：0% 正好在柱子底边那条线上，线上为正增长、线下为负增长
    // 自动标数值时最后一个点已包成 { value, label }
    const plain = (v: unknown) => (v != null && typeof v === 'object' ? (v as { value: number | null }).value : (v as number | null))
    const values = (onRight: boolean) =>
      series.filter((_, i) => isRight(i) === onRight).flatMap((s) => (s.data as unknown[]).map(plain))
    // 堆叠时左轴的范围看叠起来的高度（正数、负数分别累加）
    const stackedLeft = () =>
      categories.flatMap((_, j) => {
        const vals = series.filter((_, i) => !isRight(i)).map((s) => plain((s.data as unknown[])[j]) ?? 0)
        return [vals.filter((v) => v > 0).reduce((a, b) => a + b, 0), vals.filter((v) => v < 0).reduce((a, b) => a + b, 0)]
      })
    const aligned = alignedAxisRanges(stack ? stackedLeft() : values(false), values(true))
    if (aligned) {
      Object.assign(valueAxis, aligned[0])
      Object.assign(rightAxis, aligned[1])
      // 左轴本身没有负数（只是为对齐往下延伸）时，0 以下不标数字，免得出现「-2,000 万」
      if (!values(false).some((v) => v != null && v < 0)) {
        const fmt = leftFormatter
        valueAxis.axisLabel.formatter = (v: number) => (v < 0 ? '' : fmt(v))
      }
    }
  }

  return {
    plotted: rows.length,
    rowAt,
    indexOf,
    option: {
      grid: { left: 8, right: plan !== 'none' && horizontal ? 40 : 16, top: series.length > 1 ? 32 : plan !== 'none' && !horizontal ? 24 : 20, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: type === 'bar' ? 'shadow' : 'line' },
        valueFormatter: tooltipValue,
        // 百分比堆叠：占比 + 原值
        ...(percent ? { formatter: (ps: TooltipParam[]) => percentTooltip(ps, rawData, isRight, enc, rightFormat) } : {}),
      },
      legend: series.length > 1 ? { top: 0, type: 'scroll', textStyle: { fontSize: 11 } } : undefined,
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : right.length ? [valueAxis, rightAxis] : valueAxis,
      series,
    },
  }
}

// ─── 瀑布图 ──────────────────────────────────────────────────────────────────

export type WaterfallKind = 'up' | 'down' | 'total'

export interface WaterfallStep {
  name: string
  kind: WaterfallKind
  /** 本步的数值：增减项为增减额，合计 / 小计为累计 */
  value: number
  /** 柱子从 start 画到 end；end 即本步之后的累计（fromZero 时增减项从 0 画到本项数值，end 不是累计） */
  start: number
  end: number
  /** 对应的结果行；自动追加的合计柱为 null */
  row: BiRow | null
}

/** 瀑布图「自动」时标数值的上限 */
export const AUTO_LABEL_MAX_STEPS = 16

/**
 * 结果行 → 瀑布图的各步：第一行是起点（从 0 画起）；subtotals 里的行画成小计（从 0 画到当前累计，
 * 该行的数值不用）；其余行按正负接着上一步的累计往上 / 往下画；设了 total 时末尾追加合计柱。
 * fromZero 时增减项也从 0 画到本项数值（负数在 0 的另一侧），小计 / 合计仍取累计。
 * 数值为空的行按 0 计。
 */
export function waterfallSteps(enc: BiEncoding, rows: BiRow[]): WaterfallStep[] {
  const dim = enc.dimension || ''
  const col = valueColumns(enc)[0] || ''
  const subtotals = new Set(enc.subtotals || [])
  const steps: WaterfallStep[] = []
  let running = 0
  rows.forEach((r, i) => {
    const name = str(r[dim])
    if (i > 0 && subtotals.has(name)) {
      steps.push({ name, kind: 'total', value: running, start: 0, end: running, row: r })
      return
    }
    const v = toNumber(r[col]) ?? 0
    if (i === 0) {
      running = v
      steps.push({ name, kind: 'total', value: v, start: 0, end: v, row: r })
      return
    }
    steps.push({ name, kind: v < 0 ? 'down' : 'up', value: v, start: enc.fromZero ? 0 : running, end: enc.fromZero ? v : running + v, row: r })
    running += v
  })
  if (enc.total && steps.length > 0) steps.push({ name: enc.total, kind: 'total', value: running, start: 0, end: running, row: null })
  return steps
}

/** 各类柱子的颜色 token：默认增绿减红；up-bad（成本类）增红减绿；合计用 info（有的主题主色偏红，会和「减少」混淆） */
export function waterfallColors(trend?: BiEncoding['trend']): Record<WaterfallKind, string> {
  return trend === 'up-bad' ? { up: 'danger', down: 'success', total: 'info' } : { up: 'success', down: 'danger', total: 'info' }
}

/** 标在柱子下方的数值：往下走的（减少、负的合计） */
const labelBelow = (s: WaterfallStep) => s.kind === 'down' || (s.kind === 'total' && s.value < 0)

/**
 * 最低处的柱子要在下方标数值时，Y 轴往下多留一截（约 12% 的量程，取整到刻度），免得数字压到 X 轴文字上；
 * 不需要时返回 undefined（交给 ECharts 自动定刻度）。
 */
export function waterfallAxisMin(steps: WaterfallStep[]): number | undefined {
  if (steps.length === 0) return undefined
  const lo = Math.min(0, ...steps.map((s) => Math.min(s.start, s.end)))
  const hi = Math.max(0, ...steps.map((s) => Math.max(s.start, s.end)))
  const range = hi - lo
  if (range <= 0) return undefined
  const crowded = steps.some((s) => labelBelow(s) && Math.min(s.start, s.end) - lo < range * 0.08)
  if (!crowded) return undefined
  const step = niceStep(range / 5)
  return Math.floor((lo - range * 0.12) / step) * step
}

const KIND_LABEL: Record<WaterfallKind, string> = { up: '增加', down: '减少', total: '合计' }

/** 横向瀑布图按分栏列拆开时最多画几栏（年份再多就挤了） */
export const MAX_WATERFALL_PANELS = 6

export interface WaterfallPanel {
  /** 分栏列的值（如年份）；不分栏时为空串 */
  name: string
  steps: WaterfallStep[]
}

/**
 * 横向瀑布图的分栏：设了 series（如年份）时按它的值分组（按首次出现的顺序），每组各算一套台阶；
 * 不分栏时只有一栏。超过 MAX_WATERFALL_PANELS 栏的截掉。
 */
export function waterfallPanels(enc: BiEncoding, rows: BiRow[]): WaterfallPanel[] {
  if (!enc.horizontal || !enc.series) return [{ name: '', steps: waterfallSteps(enc, rows) }]
  const groups = new Map<string, BiRow[]>()
  for (const r of rows) {
    const k = str(r[enc.series])
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  return [...groups].slice(0, MAX_WATERFALL_PANELS).map(([name, rs]) => ({ name, steps: waterfallSteps(enc, rs) }))
}

/** ECharts 自定义系列的绘图接口（只用到的部分） */
interface CustomApi {
  value: (dim: number) => number
  coord: (v: number[]) => number[]
  size: (v: number[]) => number[]
  visual: (key: string) => string
}

/**
 * 瀑布图：每类柱子（增加 / 减少 / 合计）一个自定义系列，另有一个不响应鼠标的系列画相邻柱子之间的虚线。
 * 颜色由 colorToken 标出，渲染时 chartTheme 按当前主题换成实际颜色；数值标签与柱子同色。
 *
 * fromZero：每项都从 0 画起、不画连接虚线，数值标签不加 + 号。
 *
 * 竖向（默认）：项目从左到右。横向（horizontal）：项目从上到下，增减项的数值标在柱子右边 / 左边。
 * 横向且设了分栏列（series，如年份）：每年一栏左右并排，共用一根数值轴——第 p 栏整体平移 p 个栏宽，
 * 各栏比例尺相同，横着看就能比出同一项目各年的长短；数值轴隐藏，栏顶标年份、每栏画一条 0 线。
 *
 * 数据按「栏 × 项目」铺开：第 p 栏第 j 个项目的 dataIndex = p × 项目数 + j（不属于本类的位置留空），
 * 点击事件的 dataIndex 经 rowAt 映射回结果行。
 */
function buildWaterfallModel(enc: BiEncoding, allRows: BiRow[], opts: { clickable?: boolean }): ChartModel {
  const horizontal = !!enc.horizontal
  const panels = waterfallPanels(enc, allRows)
  const multi = horizontal && !!enc.series
  // 各栏项目取并集（按首次出现的顺序）；某年缺的项目留空
  const categories: string[] = []
  for (const p of panels) for (const s of p.steps) if (!categories.includes(s.name)) categories.push(s.name)
  const n = categories.length
  const at: (WaterfallStep | null)[] = panels.flatMap((p) => categories.map((c) => p.steps.find((s) => s.name === c) ?? null))
  const all = panels.flatMap((p) => p.steps)

  // 分栏时第 p 栏平移 offset(p)：每栏宽 = 全部栏的数值范围 + 两侧留给数值标签的空白
  const lo = Math.min(0, ...all.map((s) => Math.min(s.start, s.end)))
  const hi = Math.max(0, ...all.map((s) => Math.max(s.start, s.end)))
  const range = hi - lo || 1
  const pad = multi ? range * 0.3 : 0
  const span = range + pad * 2
  const offset = (p: number) => (multi ? p * span + pad - lo : 0)

  const fmt = axisFormatter(enc)
  const showLabels = enc.labels === 'show' || (enc.labels !== 'hide' && n <= AUTO_LABEL_MAX_STEPS)
  const fromZero = !!enc.fromZero
  const signed = (s: WaterfallStep) =>
    s.kind === 'total' || fromZero ? fmt(s.value) : `${s.value > 0 ? '+' : s.value < 0 ? '−' : ''}${fmt(Math.abs(s.value))}`
  const colors = waterfallColors(enc.trend)
  const band = (api: CustomApi) => (horizontal ? api.size([0, 1])[1] : api.size([1, 0])[0])
  const barWidth = (api: CustomApi) => Math.min(horizontal ? 28 : 48, band(api) * 0.6)
  // 数值 + 类目 → 像素坐标（横向时数值在 X 轴）
  const pt = (api: CustomApi, v: number, j: number) => api.coord(horizontal ? [v, j] : [j, v])
  const valueDims = horizontal ? { y: 0, x: [1, 2] } : { x: 0, y: [1, 2] }

  // 数据维度：[类目序号, 柱底, 柱顶, 本步数值, 累计]（柱底 / 柱顶已加上本栏的平移）
  const series: Record<string, unknown>[] = (['total', 'up', 'down'] as const)
    .filter((kind) => all.some((s) => s.kind === kind))
    .map((kind) => ({
      type: 'custom',
      name: KIND_LABEL[kind],
      colorToken: colors[kind],
      cursor: opts.clickable ? 'pointer' : 'default',
      encode: valueDims,
      data: at.map((s, i) => {
        const j = i % Math.max(1, n)
        if (!s || s.kind !== kind) return [j, null, null, null, null]
        const o = offset(Math.floor(i / n))
        return [j, Math.min(s.start, s.end) + o, Math.max(s.start, s.end) + o, s.value, s.end]
      }),
      renderItem: (params: { dataIndex?: number }, api: CustomApi) => {
        const a = api.value(1)
        const b = api.value(2)
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null
        const j = api.value(0)
        const w = barWidth(api)
        const p1 = pt(api, a, j)
        const p2 = pt(api, b, j)
        const color = api.visual('color')
        const rect = horizontal
          ? { x: p1[0], y: p1[1] - w / 2, width: Math.max(1, p2[0] - p1[0]), height: w, r: 2 }
          : { x: p2[0] - w / 2, y: p2[1], width: w, height: Math.max(1, p1[1] - p2[1]), r: 2 }
        const children: Record<string, unknown>[] = [{ type: 'rect', shape: rect, style: { fill: color } }]
        const step = at[params.dataIndex ?? j]
        if (showLabels && step) {
          // 往下走的（减少、负的合计）：竖向标在柱子下方，横向标在左边；其余标在上方 / 右边
          const below = labelBelow(step)
          const style = { text: signed(step), fill: color, fontSize: 11 }
          children.push(
            horizontal
              ? { type: 'text', silent: true, x: below ? p1[0] - 4 : p2[0] + 4, y: p1[1], style: { ...style, align: below ? 'right' : 'left', verticalAlign: 'middle' } }
              : { type: 'text', silent: true, x: p2[0], y: below ? p1[1] + 4 : p2[1] - 4, style: { ...style, align: 'center', verticalAlign: below ? 'top' : 'bottom' } },
          )
        }
        return { type: 'group', children }
      },
    }))

  // 相邻柱子之间的连接虚线：画在上一步的累计处，连到同一栏的下一根柱子。数据：[本柱类目, 累计, 下一柱类目]
  // 每项从 0 画起时柱子不衔接，不画
  const links = fromZero ? [] : panels.flatMap((p, pi) =>
    p.steps.slice(0, -1).map((s, k) => [categories.indexOf(s.name), s.end + offset(pi), categories.indexOf(p.steps[k + 1].name)]),
  )
  if (links.length > 0) {
    series.push({
      type: 'custom',
      name: '连接线',
      silent: true,
      colorToken: 'line-strong',
      encode: horizontal ? { y: 0, x: 1 } : { x: 0, y: 1 },
      tooltip: { show: false },
      data: links,
      renderItem: (_params: unknown, api: CustomApi) => {
        const v = api.value(1)
        const a = pt(api, v, api.value(0))
        const b = pt(api, v, api.value(2))
        const w = barWidth(api)
        const shape = horizontal ? { x1: a[0], y1: a[1] + w / 2, x2: b[0], y2: b[1] - w / 2 } : { x1: a[0] + w / 2, y1: a[1], x2: b[0] - w / 2, y2: b[1] }
        return { type: 'line', shape, style: { stroke: api.visual('color'), lineDash: [4, 3], lineWidth: 1 } }
      },
    })
  }

  // 分栏：每栏一条 0 线、栏顶标分栏名（年份）。数据：[栏序号, 本栏 0 点]
  if (multi && n > 0) {
    const panelData = panels.map((_, p) => [p, offset(p)])
    series.push({
      type: 'custom',
      name: '零线',
      silent: true,
      colorToken: 'line-strong',
      encode: { x: 1 },
      tooltip: { show: false },
      data: panelData,
      renderItem: (_params: unknown, api: CustomApi) => {
        const top = pt(api, api.value(1), 0)
        const bottom = pt(api, api.value(1), n - 1)
        const h = band(api) / 2
        return { type: 'line', shape: { x1: top[0], y1: top[1] - h, x2: top[0], y2: bottom[1] + h }, style: { stroke: api.visual('color'), lineWidth: 1 } }
      },
    })
    series.push({
      type: 'custom',
      name: '分栏',
      silent: true,
      colorToken: 'fg-2',
      encode: { x: 1 },
      tooltip: { show: false },
      data: panelData,
      renderItem: (_params: unknown, api: CustomApi) => {
        const p = api.value(0)
        const c = pt(api, p * span + span / 2, 0)
        return {
          type: 'text',
          x: c[0],
          y: c[1] - band(api) / 2 - 6,
          style: { text: panels[p]?.name ?? '', fill: api.visual('color'), fontSize: 12, fontWeight: 600, align: 'center', verticalAlign: 'bottom' },
        }
      },
    })
  }

  const axisMin = showLabels && !multi ? waterfallAxisMin(all) : undefined
  const categoryAxis = {
    type: 'category',
    data: categories,
    inverse: horizontal, // 横向：第一项在最上面
    axisLabel: { fontSize: 11, hideOverlap: true },
    axisTick: { alignWithLabel: true },
  }
  const valueAxis = multi
    ? { type: 'value', min: 0, max: panels.length * span, show: false, splitLine: { show: false } }
    : {
        type: 'value',
        name: enc.unit && enc.format !== 'percent' ? enc.unit : '',
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 11, formatter: fmt },
        ...(axisMin != null ? { min: axisMin } : {}),
        splitLine: { show: true },
      }

  return {
    plotted: all.length,
    rowAt: (i) => at[i]?.row ?? null,
    // 点在柱子之间的空白处：按所在的栏和项目算
    pickIndex: (v) => {
      const j = Math.round(v[horizontal ? 1 : 0])
      const p = multi ? Math.floor(v[0] / span) : 0
      return j >= 0 && j < n && p >= 0 && p < panels.length ? p * n + j : null
    },
    option: {
      grid: { left: 8, right: horizontal && !multi && showLabels ? 48 : 16, top: multi ? 28 : showLabels && !horizontal ? 24 : 20, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: (p: { dataIndex: number; marker?: string }) => {
          const s = at[p.dataIndex]
          if (!s) return ''
          const panel = multi ? panels[Math.floor(p.dataIndex / n)]?.name : ''
          const name = panel ? `${panel} · ${s.name}` : s.name
          const lines = [`${p.marker ?? ''}${escapeHtml(name)}&nbsp;&nbsp;<b>${escapeHtml(s.kind === 'total' ? formatValue(s.value, enc) : signed(s) + (enc.unit && enc.format !== 'percent' ? ` ${enc.unit}` : ''))}</b>`]
          if (s.kind !== 'total' && !fromZero) lines.push(`累计&nbsp;&nbsp;${escapeHtml(formatValue(s.end, enc))}`)
          return lines.join('<br/>')
        },
      },
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : valueAxis,
      series,
    },
  }
}

/** 同一行：同一个对象，或各列值都相同（卡片刷新后结果行是新对象） */
export function sameRow(a: BiRow, b: BiRow): boolean {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k] || (a[k] instanceof Date && b[k] instanceof Date && (a[k] as Date).getTime() === (b[k] as Date).getTime()))
}

function indexIn(rows: BiRow[], row: BiRow): ChartPoint | null {
  const i = rows.findIndex((r) => sameRow(r, row))
  return i < 0 ? null : { dataIndex: i }
}

const DIM_OPACITY = 0.3

/**
 * 高亮一个点（明细面板打开时标出来源项）：柱状 / 饼图把其余项调淡，折线把该点放大。
 * 右轴折线、自定义系列（瀑布图）不动。返回新的 option，不改原对象。
 */
export function highlightPoint(option: Record<string, unknown>, point: ChartPoint | null): Record<string, unknown> {
  if (!point || !Array.isArray(option.series)) return option
  const series = (option.series as Record<string, unknown>[]).map((s) => {
    if (!Array.isArray(s.data) || s.yAxisIndex === 1) return s
    const hitSeries = point.seriesName == null || s.name === point.seriesName
    const data = (s.data as unknown[]).map((item, i) => {
      const obj = item != null && typeof item === 'object' ? (item as Record<string, unknown>) : { value: item }
      const style = (obj.itemStyle as Record<string, unknown> | undefined) ?? {}
      const hit = hitSeries && i === point.dataIndex
      if (s.type === 'line') return hit ? { ...obj, symbolSize: 12, itemStyle: { ...style, borderWidth: 3 } } : item
      if (s.type !== 'bar' && s.type !== 'pie') return item
      return hit ? item : { ...obj, itemStyle: { ...style, opacity: DIM_OPACITY } }
    })
    return { ...s, data }
  })
  return { ...option, series }
}
