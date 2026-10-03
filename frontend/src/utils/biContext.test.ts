import { describe, expect, it } from 'vitest'
import { buildBiContext, explainPrompt, pickCaption, pointFields, toWireContext, type BiPick } from './biContext'
import { levelView, pushDrill, rootStack } from './biDrill'
import type { BiCard, BiDashboard } from './bi'

const card: BiCard = {
  id: 'ar',
  type: 'bar',
  title: '应收按客户',
  queryKey: 'fin_ar',
  params: { period: '$filter.period', top: 10 },
  encoding: { dimension: 'CardName', value: 'Balance', compare: 'Prev', scale: 10000, unit: '万' },
  layout: { w: 6, h: 2 },
  drill: [{ queryKey: 'fin_ar_docs', label: '单据', bind: { cardCode: 'CardCode' }, params: {}, type: 'table', encoding: {} }],
}
const kpi: BiCard = { ...card, id: 'k', type: 'kpi', title: '应收账款', encoding: { value: 'Balance', scale: 10000, unit: '万' }, drill: [] }

const dashboard: BiDashboard = {
  dashboardKey: 'finance',
  label: '财务',
  filters: [
    { name: 'period', label: '期间', type: 'month' },
    { name: 'co', label: '公司', type: 'select', options: [{ value: 'A', label: '甲公司' }] },
    { name: 'wh', label: '仓库', type: 'string' },
  ],
  cards: [card],
  queries: {
    fin_ar: { queryKey: 'fin_ar', label: '应收按客户', params: [], dimensions: [{ column: 'CardCode', label: '客户编码' }, { column: 'CardName', label: '客户' }], caliberNote: '按过账日期' },
  },
  hiddenCards: 0,
}
const filters = { period: '2026-09', co: 'A', wh: null }
const row = { CardCode: 'C1', CardName: '甲', Balance: 1200000, Prev: 1000000, Secret: 'x' }

function mkPick(c: BiCard, r: Record<string, unknown>, stack = rootStack(c), columns = Object.keys(r)): BiPick {
  return { card: c, stack, view: levelView(c, stack, filters), row: r, columns, x: 0, y: 0, drillLabel: null, drill: () => {} }
}

describe('biContext', () => {
  it('图表元素：维度 + 数值 + 对比 + 维度编码（用查询的维度标签），不带无关列', () => {
    const p = pointFields(mkPick(card, row), dashboard.queries.fin_ar.dimensions)
    expect(p).toEqual({ 客户: '甲', Balance: 1200000, Prev: 1000000, 客户编码: 'C1' })
  })

  it('表格行：取全部列（限 12 个）', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, i]))
    const s = pushDrill(card, rootStack(card), row, card.encoding)
    expect(Object.keys(pointFields(mkPick(card, wide, s)))).toHaveLength(12)
  })

  it('完整上下文：筛选用标签与选项名、空值省略；参数为该级实际参数；路径为面包屑', () => {
    const ctx = buildBiContext(mkPick(card, row), dashboard, filters, 'explain')
    expect(ctx).toMatchObject({
      dashboardKey: 'finance',
      cardId: 'ar',
      cardTitle: '应收按客户',
      queryKey: 'fin_ar',
      queryLabel: '应收按客户',
      caliberNote: '按过账日期',
      path: ['应收按客户'],
      filters: { 期间: '2026-09', 公司: '甲公司' },
      params: { period: '2026-09', top: 10 },
      intent: 'explain',
      caption: '应收按客户 · 甲',
    })
    expect(explainPrompt(ctx)).toBe('解读一下：应收按客户 · 甲')
    expect('caption' in toWireContext(ctx)).toBe(false)
  })

  it('下钻后：查询、参数、路径跟随当前级', () => {
    const s = pushDrill(card, rootStack(card), row, card.encoding)
    const ctx = buildBiContext(mkPick(card, { DocNum: 1001 }, s), dashboard, filters, 'ask')
    expect(ctx.queryKey).toBe('fin_ar_docs')
    expect(ctx.params).toEqual({ cardCode: 'C1' })
    expect(ctx.path).toEqual(['应收按客户', '甲 · 单据'])
    expect(ctx.caption).toBe('甲 · 单据 · 1001')
  })

  it('KPI 胶囊显示格式化后的数值', () => {
    expect(pickCaption(mkPick(kpi, row))).toBe('应收账款 · 120 万')
  })
})
