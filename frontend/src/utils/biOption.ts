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
export type BiChartType = 'bar' | 'line' | 'pie'

export interface ChartModel {
  option: Record<string, unknown>
  /** 点击事件 → 对应的结果行；找不到返回 null */
  rowAt: (dataIndex: number, seriesName?: string) => BiRow | null
  /** 实际参与绘图的行数（topN 截断后） */
  plotted: number
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

export function buildChartModel(
  type: BiChartType,
  enc: BiEncoding,
  allRows: BiRow[],
  opts: { clickable?: boolean } = {},
): ChartModel {
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
  } else {
    categories = rows.map((r) => str(r[dim]))
    series = cols.map((col) => ({
      name: columnLabel(enc, col),
      type,
      data: rows.map((r) => toNumber(r[col])),
    }))
    rowAt = (i) => rows[i] ?? null
  }

  // 右轴：增长率等画成折线，有自己的格式（列语义里的 format，通常是百分比）
  const right = enc.series ? [] : rightAxisColumns(type, enc)
  const rightFormat = enc.columns?.find((c) => c.column === right[0])?.format
  const isRight = (i: number) => right.includes(cols[i])
  const leftCount = series.length - right.length

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
  const label = makeLabel(axisFormatter(enc))
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
    name: enc.unit && enc.format !== 'percent' ? enc.unit : '',
    nameTextStyle: { fontSize: 11 },
    axisLabel: { fontSize: 11, formatter: axisFormatter(enc) },
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
    const values = (onRight: boolean) =>
      series
        .filter((_, i) => isRight(i) === onRight)
        .flatMap((s) => (s.data as unknown[]).map((v) => (v != null && typeof v === 'object' ? (v as { value: number | null }).value : (v as number | null))))
    const aligned = alignedAxisRanges(values(false), values(true))
    if (aligned) {
      Object.assign(valueAxis, aligned[0])
      Object.assign(rightAxis, aligned[1])
      // 左轴本身没有负数（只是为对齐往下延伸）时，0 以下不标数字，免得出现「-2,000 万」
      if (!values(false).some((v) => v != null && v < 0)) {
        const fmt = axisFormatter(enc)
        valueAxis.axisLabel.formatter = (v: number) => (v < 0 ? '' : fmt(v))
      }
    }
  }

  return {
    plotted: rows.length,
    rowAt,
    option: {
      grid: { left: 8, right: plan !== 'none' && horizontal ? 40 : 16, top: series.length > 1 ? 32 : plan !== 'none' && !horizontal ? 24 : 20, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: type === 'bar' ? 'shadow' : 'line' }, valueFormatter: tooltipValue },
      legend: series.length > 1 ? { top: 0, type: 'scroll', textStyle: { fontSize: 11 } } : undefined,
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : right.length ? [valueAxis, rightAxis] : valueAxis,
      series,
    },
  }
}
