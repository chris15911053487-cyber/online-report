import { describe, expect, it } from 'vitest'
import { alignedAxisRanges, buildChartModel, columnLabel, labelPlan, rightAxisColumns, valueColumns } from './biOption'
import { canDrillFrom, levelView, nextDrillLabel, popDrillTo, pushDrill, rootStack, rowCaption } from './biDrill'
import type { BiCard } from './bi'

type Axis = { type: string; data?: string[]; inverse?: boolean; axisLabel?: { formatter?: (v: number) => string } }
type Series = { name: string; type: string; data: unknown[] }

const rows = [
  { CardName: '甲', Balance: '1200000.00', Prev: 1000000, CardCode: 'C1' },
  { CardName: '乙', Balance: 800000, Prev: 900000, CardCode: 'C2' },
  { CardName: '丙', Balance: 50000, Prev: null, CardCode: 'C3' },
]

describe('buildChartModel', () => {
  it('柱状图：类目、数值（decimal 字符串转数字）、rowAt', () => {
    const m = buildChartModel('bar', { dimension: 'CardName', value: 'Balance' }, rows)
    const o = m.option as { xAxis: Axis; yAxis: Axis; series: Series[]; legend?: unknown }
    expect(o.xAxis.type).toBe('category')
    expect(o.xAxis.data).toEqual(['甲', '乙', '丙'])
    expect(o.series[0].data).toEqual([1200000, 800000, 50000])
    expect(o.legend).toBeUndefined()
    expect(m.rowAt(1)?.CardCode).toBe('C2')
    expect(m.rowAt(9)).toBeNull()
  })

  it('横向条形图交换坐标轴且第一名在上；topN 截断', () => {
    const m = buildChartModel('bar', { dimension: 'CardName', value: 'Balance', horizontal: true, topN: 2 }, rows)
    const o = m.option as { xAxis: Axis; yAxis: Axis; series: Series[] }
    expect(o.yAxis.type).toBe('category')
    expect(o.yAxis.inverse).toBe(true)
    expect(o.yAxis.data).toEqual(['甲', '乙'])
    expect(m.plotted).toBe(2)
  })

  it('多数值列 → 多系列 + 图例，系列名取 columns 里的 label', () => {
    const enc = { dimension: 'CardName', values: ['Balance', 'Prev'], columns: [{ column: 'Prev', label: '上期' }] }
    const o = buildChartModel('line', enc, rows).option as { series: Series[]; legend?: unknown }
    expect(o.series.map((s) => s.name)).toEqual(['Balance', '上期'])
    expect(o.series[1].data).toEqual([1000000, 900000, null])
    expect(o.legend).toBeTruthy()
  })

  it('series 列透视：缺格为 null，rowAt 按系列名找回原行', () => {
    const long = [
      { M: '01', Co: 'A', V: 1 },
      { M: '01', Co: 'B', V: 2 },
      { M: '02', Co: 'A', V: 3 },
    ]
    const m = buildChartModel('line', { dimension: 'M', value: 'V', series: 'Co' }, long)
    const o = m.option as { xAxis: Axis; series: Series[] }
    expect(o.xAxis.data).toEqual(['01', '02'])
    expect(o.series.map((s) => [s.name, s.data])).toEqual([
      ['A', [1, 3]],
      ['B', [2, null]],
    ])
    expect(m.rowAt(1, 'A')).toEqual({ M: '02', Co: 'A', V: 3 })
    expect(m.rowAt(1, 'B')).toBeNull()
  })

  it('饼图：name/value，rowAt 按扇区序号', () => {
    const m = buildChartModel('pie', { dimension: 'CardName', value: 'Balance' }, rows)
    const s = (m.option as { series: { data: { name: string; value: number }[] }[] }).series[0]
    expect(s.data[0]).toEqual({ name: '甲', value: 1200000 })
    expect(m.rowAt(2)?.CardCode).toBe('C3')
  })

  it('坐标轴按 scale 缩放、不带单位；轴名显示单位', () => {
    const o = buildChartModel('bar', { dimension: 'CardName', value: 'Balance', scale: 10000, unit: '万' }, rows).option as {
      yAxis: Axis & { name: string }
    }
    expect(o.yAxis.name).toBe('万')
    expect(o.yAxis.axisLabel!.formatter!(1200000)).toBe('120')
  })

  it('valueColumns / columnLabel', () => {
    expect(valueColumns({ value: 'a' })).toEqual(['a'])
    expect(valueColumns({ value: 'a', values: ['b', 'c'] })).toEqual(['b', 'c'])
    expect(valueColumns({})).toEqual([])
    expect(columnLabel({ columns: [{ column: 'a', label: 'A' }] }, 'a')).toBe('A')
    expect(columnLabel({}, 'a')).toBe('a')
  })
})

const card: BiCard = {
  id: 'ar',
  type: 'bar',
  title: '应收按客户',
  queryKey: 'fin_ar',
  params: { period: '$filter.period' },
  encoding: { dimension: 'CardName', value: 'Balance' },
  layout: { w: 6, h: 2 },
  drill: [
    { queryKey: 'fin_ar_docs', label: '单据', bind: { cardCode: 'CardCode' }, params: { period: '$filter.period' }, type: 'table', encoding: { dimension: 'DocNum' } },
    { queryKey: 'fin_doc_lines', label: '明细', bind: { docEntry: 'DocEntry' }, params: {}, type: 'table', encoding: {} },
  ],
}
const filters = { period: '2026-09' }

describe('下钻栈', () => {
  it('根级：卡片自身的查询与 $filter 参数', () => {
    const s = rootStack(card)
    expect(levelView(card, s, filters)).toEqual({ queryKey: 'fin_ar', type: 'bar', encoding: card.encoding, params: { period: '2026-09' } })
    expect(canDrillFrom(card, s)).toBe(true)
    expect(nextDrillLabel(card, s)).toBe('单据')
  })

  it('逐级下钻：bind 取列值并累积；面包屑；最深一级不再下钻', () => {
    const s1 = pushDrill(card, rootStack(card), rows[0], card.encoding)
    expect(s1).toHaveLength(2)
    expect(s1[1].crumb).toBe('甲 · 单据')
    expect(s1[1].fromRow).toBe(rows[0])
    expect(levelView(card, s1, filters)).toMatchObject({ queryKey: 'fin_ar_docs', type: 'table', params: { cardCode: 'C1', period: '2026-09' } })

    const s2 = pushDrill(card, s1, { DocNum: 1001, DocEntry: 77 }, card.drill[0].encoding)
    expect(s2[2].crumb).toBe('1001 · 明细')
    expect(levelView(card, s2, filters).params).toEqual({ cardCode: 'C1', docEntry: 77 })
    expect(canDrillFrom(card, s2)).toBe(false)
    expect(nextDrillLabel(card, s2)).toBeNull()
    expect(pushDrill(card, s2, {}, {})).toBe(s2)

    expect(popDrillTo(s2, 0)).toHaveLength(1)
    expect(popDrillTo(s2, 1)).toHaveLength(2)
    expect(popDrillTo(s2, 2)).toBe(s2)
  })

  it('bind 值优先于同名 $filter；筛选变化后重新解析', () => {
    const c2: BiCard = { ...card, drill: [{ ...card.drill[0], bind: { period: 'Month' }, params: { period: '$filter.period' } }] }
    const s = pushDrill(c2, rootStack(c2), { Month: '2026-07', CardName: 'x' }, c2.encoding)
    expect(levelView(c2, s, { period: '2026-09' }).params.period).toBe('2026-07')
    expect(levelView(card, pushDrill(card, rootStack(card), rows[1], card.encoding), { period: '2026-10' }).params.period).toBe('2026-10')
  })

  it('rowCaption：维度值 → bind 列 → 第一个简单值', () => {
    expect(rowCaption({ CardName: '甲' }, { dimension: 'CardName' })).toBe('甲')
    expect(rowCaption({ CardCode: 'C1', X: 1 }, {}, { cardCode: 'CardCode' })).toBe('C1')
    expect(rowCaption({ A: null, B: 5 }, {})).toBe('5')
  })
})

describe('柱/线数值标签', () => {
  type LSeries = { label?: { show: boolean; position: string; formatter: (p: { value: unknown }) => string }; data: unknown[] }
  const many = Array.from({ length: 15 }, (_, i) => ({ D: `d${i}`, V: i * 1000 }))

  it('自动：单系列柱子不多时标；多系列、柱子多时不标；横向条形上限更高', () => {
    expect(labelPlan('bar', {}, 1, 12)).toBe('all')
    expect(labelPlan('bar', {}, 1, 13)).toBe('none')
    expect(labelPlan('bar', { horizontal: true }, 1, 20)).toBe('all')
    expect(labelPlan('bar', {}, 2, 3)).toBe('none')
    expect(labelPlan('line', {}, 1, 30)).toBe('last')
    expect(labelPlan('line', {}, 2, 30)).toBe('none')
  })

  it('显示 / 不显示 覆盖自动规则', () => {
    expect(labelPlan('bar', { labels: 'show' }, 3, 50)).toBe('all')
    expect(labelPlan('bar', { labels: 'hide' }, 1, 3)).toBe('none')
    expect(labelPlan('line', { labels: 'show' }, 1, 5)).toBe('all')
  })

  it('柱上标签用紧凑格式（按缩放、不带单位）；横向标在右侧', () => {
    const o = buildChartModel('bar', { dimension: 'CardName', value: 'Balance', scale: 10000, unit: '万', horizontal: true }, rows).option as { series: LSeries[] }
    expect(o.series[0].label?.position).toBe('right')
    expect(o.series[0].label?.formatter({ value: 1200000 })).toBe('120')
    const many15 = buildChartModel('bar', { dimension: 'D', value: 'V' }, many).option as { series: LSeries[] }
    expect(many15.series[0].label).toBeUndefined()
  })

  it('折线自动只标最后一个点，rowAt 不受影响', () => {
    const m = buildChartModel('line', { dimension: 'CardName', value: 'Balance' }, rows)
    const s = (m.option as { series: LSeries[] }).series[0]
    expect(s.label).toBeUndefined()
    expect(s.data.slice(0, 2)).toEqual([1200000, 800000])
    expect(s.data[2]).toMatchObject({ value: 50000, label: { show: true } })
    expect(m.rowAt(2)?.CardCode).toBe('C3')
  })
})

describe('柱线组合（右轴）', () => {
  const yoy = [
    { 月份: '2026-01', 本期: 120, 对比期: 100, 增长率: 0.2 },
    { 月份: '2026-02', 本期: 90, 对比期: 100, 增长率: -0.1 },
  ]
  const enc = {
    dimension: '月份',
    values: ['本期', '对比期', '增长率'],
    rightAxis: ['增长率'],
    columns: [{ column: '对比期', label: '去年同期' }, { column: '增长率', label: '增长率', format: 'percent' as const }],
  }
  type S = Series & { yAxisIndex?: number; label?: unknown; tooltip?: { valueFormatter: (v: unknown) => string } }

  it('右轴列画成折线走第二根轴，按自己的格式显示；其余仍是柱', () => {
    const o = buildChartModel('bar', enc, yoy).option as { yAxis: Axis[]; series: S[] }
    expect(Array.isArray(o.yAxis)).toBe(true)
    expect(o.yAxis[1].axisLabel?.formatter?.(0.2)).toBe('20%')
    expect(o.series.map((s) => [s.name, s.type, s.yAxisIndex])).toEqual([
      ['本期', 'bar', undefined],
      ['去年同期', 'bar', undefined],
      ['增长率', 'line', 1],
    ])
    expect(o.series[2].tooltip?.valueFormatter(-0.1)).toBe('-10%')
  })

  it('自动标数值：两组柱不标，右轴折线只标最新值', () => {
    const o = buildChartModel('bar', enc, yoy).option as { series: S[] }
    expect(o.series[0].label).toBeUndefined()
    expect(o.series[2].data[0]).toBe(0.2)
    expect(o.series[2].data[1]).toMatchObject({ value: -0.1 })
  })

  it('不合法的右轴配置退回单轴：全部放右轴 / 按系列拆分 / 横向 / 饼图', () => {
    expect(rightAxisColumns('bar', { ...enc, rightAxis: ['本期', '对比期', '增长率'] })).toEqual([])
    expect(rightAxisColumns('bar', { ...enc, series: '月份' })).toEqual([])
    expect(rightAxisColumns('bar', { ...enc, horizontal: true })).toEqual([])
    expect(rightAxisColumns('pie', enc)).toEqual([])
    expect(rightAxisColumns('line', { ...enc, rightAxis: ['增长率', '不存在'] })).toEqual(['增长率'])
    const o = buildChartModel('bar', { ...enc, rightAxis: ['本期', '对比期', '增长率'] }, yoy).option as { yAxis: Axis }
    expect(Array.isArray(o.yAxis)).toBe(false)
  })

  // 0 在第几格（从下往上数）
  const zeroAt = (r: { min: number; interval: number }) => Math.round(-r.min / r.interval)

  it('两轴的 0 对齐：增长率有负数时，左轴也往下延伸，0% 与柱子底边同一条线', () => {
    const o = buildChartModel('bar', enc, yoy).option as { yAxis: { min: number; max: number; interval: number }[] }
    const [l, r] = o.yAxis
    expect(r.min).toBeLessThanOrEqual(-0.1)
    expect(r.max).toBeGreaterThanOrEqual(0.2)
    expect(l.max).toBeGreaterThanOrEqual(120)
    expect(zeroAt(l)).toBeGreaterThan(0)
    expect(zeroAt(l)).toBe(zeroAt(r))
    expect((l.max - l.min) / l.interval).toBeCloseTo((r.max - r.min) / r.interval)
    // 金额本身没有负数：左轴 0 以下不标数字
    const lf = (o.yAxis[0] as unknown as Axis).axisLabel?.formatter
    expect(lf?.(l.min)).toBe('')
    expect(lf?.(100)).toBe('100')
  })

  it('对齐时刻度取整、留白不过多', () => {
    // 全是正数：两轴都从 0 开始
    const [l, r] = alignedAxisRanges([29180000, 25960000], [0.124, 0.03])!
    expect(l).toEqual({ min: 0, max: 30000000, interval: 5000000 })
    expect(r.min).toBe(0)
    expect(r.max).toBeGreaterThanOrEqual(0.124)
    // 有负数：步长是 1 / 2 / 2.5 / 5 × 10^n，没有浮点尾巴
    const [l2, r2] = alignedAxisRanges([3000, 2800, 3500], [-0.35, 0.08, 0.6])!
    expect(r2).toMatchObject({ min: -0.4, interval: 0.2 })
    expect(r2.max).toBeGreaterThanOrEqual(0.6)
    expect(String(r2.max)).toMatch(/^0\.\d$/)
    expect(zeroAt(l2)).toBe(zeroAt(r2))
    // 某根轴没有数值时交给 ECharts
    expect(alignedAxisRanges([1, 2], [null, null])).toBeNull()
  })
})

describe('堆叠柱形图', () => {
  const data = [
    { 月份: '01', A: 30, B: 10, 增长率: 0.1 },
    { 月份: '02', A: 20, B: 20, 增长率: -0.2 },
  ]
  type S = Series & { stack?: string; yAxisIndex?: number; label?: { position?: string } }
  type Tip = { formatter?: (ps: unknown[]) => string }

  it('堆叠：左轴柱子共用一个 stack，数值标签放在柱内', () => {
    const o = buildChartModel('bar', { dimension: '月份', values: ['A', 'B'], stack: 'normal', labels: 'show' }, data).option as { series: S[]; tooltip: Tip }
    expect(o.series.map((s) => s.stack)).toEqual(['total', 'total'])
    expect(o.series[0].data).toEqual([30, 20])
    expect(o.series[0].label?.position).toBe('inside')
    expect(o.tooltip.formatter).toBeUndefined()
  })

  it('百分比堆叠：换算成占比，坐标轴 0~100%，tooltip 显示占比和原值', () => {
    const o = buildChartModel('bar', { dimension: '月份', values: ['A', 'B'], stack: 'percent' }, data).option as { series: S[]; yAxis: Axis & { max?: number }; tooltip: Tip }
    expect(o.series[0].data).toEqual([0.75, 0.5])
    expect(o.series[1].data).toEqual([0.25, 0.5])
    expect(o.yAxis.max).toBe(1)
    expect(o.yAxis.axisLabel?.formatter?.(0.5)).toBe('50%')
    const tip = o.tooltip.formatter!([
      { axisValueLabel: '01', marker: '', seriesName: 'A', seriesIndex: 0, dataIndex: 0, value: 0.75 },
      { axisValueLabel: '01', marker: '', seriesName: 'B', seriesIndex: 1, dataIndex: 0, value: 0.25 },
    ])
    expect(tip).toContain('75%（30）')
    expect(tip).toContain('25%（10）')
  })

  it('右轴折线不参与堆叠；只有一根柱时不堆叠；折线忽略 stack', () => {
    const enc = { dimension: '月份', values: ['A', 'B', '增长率'], rightAxis: ['增长率'], stack: 'normal' as const, columns: [{ column: '增长率', format: 'percent' as const }] }
    const o = buildChartModel('bar', enc, data).option as { series: S[] }
    expect(o.series.map((s) => [s.type, s.stack])).toEqual([['bar', 'total'], ['bar', 'total'], ['line', undefined]])
    const one = buildChartModel('bar', { dimension: '月份', value: 'A', stack: 'normal' }, data).option as { series: S[] }
    expect(one.series[0].stack).toBeUndefined()
    const line = buildChartModel('line', { dimension: '月份', values: ['A', 'B'], stack: 'normal' }, data).option as { series: S[] }
    expect(line.series[0].stack).toBeUndefined()
  })

  it('系列列透视也能堆叠，rowAt 不受影响', () => {
    const long = [
      { M: '01', Co: '甲', V: 1 },
      { M: '01', Co: '乙', V: 3 },
    ]
    const m = buildChartModel('bar', { dimension: 'M', value: 'V', series: 'Co', stack: 'percent' }, long)
    const o = m.option as { series: S[] }
    expect(o.series.map((s) => [s.name, s.stack, s.data])).toEqual([['甲', 'total', [0.25]], ['乙', 'total', [0.75]]])
    expect(m.rowAt(0, '乙')).toEqual({ M: '01', Co: '乙', V: 3 })
  })
})
