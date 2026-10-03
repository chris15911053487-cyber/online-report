import { describe, expect, it } from 'vitest'
import { buildChartModel, columnLabel, valueColumns } from './biOption'
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
