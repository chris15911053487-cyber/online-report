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
function axisFormatter(enc: BiEncoding) {
  const format = enc.format === 'money' ? 'number' : enc.format
  return (v: number) => formatValue(v, { format, scale: enc.scale }, { withUnit: false })
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

  const plan = labelPlan(type, enc, series.length, categories.length)
  // 标签与坐标轴同样用紧凑格式（单位在轴名上）
  const fmt = axisFormatter(enc)
  const label = {
    show: true,
    position: horizontal ? 'right' : 'top',
    fontSize: 11,
    formatter: (p: { value: unknown }) => {
      const n = toNumber(Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value)
      return n == null ? '' : fmt(n)
    },
  }

  for (const s of series) {
    s.cursor = cursor
    if (type === 'line') Object.assign(s, { smooth: true, symbolSize: 6 })
    if (type === 'bar') Object.assign(s, { barMaxWidth: 28 })
    if (plan === 'all') s.label = label
    if (plan === 'last') {
      const data = s.data as (number | null)[]
      const last = data.length - 1
      s.data = data.map((v, i) => (i === last && v != null ? { value: v, label } : v))
    }
  }

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

  return {
    plotted: rows.length,
    rowAt,
    option: {
      grid: { left: 8, right: plan !== 'none' && horizontal ? 40 : 16, top: series.length > 1 ? 32 : plan !== 'none' && !horizontal ? 24 : 20, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: type === 'bar' ? 'shadow' : 'line' }, valueFormatter: tooltipValue },
      legend: series.length > 1 ? { top: 0, type: 'scroll', textStyle: { fontSize: 11 } } : undefined,
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : valueAxis,
      series,
    },
  }
}
