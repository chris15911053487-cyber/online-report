import { describe, expect, it } from 'vitest'
import { chartThumb, dashboardThumb, packDashboard, queryThumb } from './biLineageThumb'

describe('packDashboard', () => {
  it('与看板 12 列栅格一致：放不下换行，行高取最高的卡片，KPI 保持自身高度', () => {
    const t = packDashboard([
      { w: 3, h: 1, type: 'kpi' },
      { w: 3, h: 1, type: 'kpi' },
      { w: 6, h: 2, type: 'bar' },
      { w: 8, h: 2, type: 'line' },
      { w: 6, h: 3, type: 'pie' },
    ])
    expect(t.blocks.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, 3, 1],
      [3, 0, 3, 1],
      [6, 0, 6, 2],
      [0, 2, 8, 2],
      [0, 4, 6, 3],
    ])
    expect(t.rows).toBe(7)
  })
  it('同一行里图表撑满行高', () => {
    const t = packDashboard([
      { w: 6, h: 3, type: 'bar' },
      { w: 6, h: 1, type: 'line' },
    ])
    expect(t.blocks.map((b) => b.h)).toEqual([3, 3])
  })
})

describe('thumb 数据', () => {
  it('图表：横向 / 堆叠 / 系列数', () => {
    expect(chartThumb({ type: 'bar', encoding: { horizontal: true, stack: 'normal', values: ['a', 'b'] } })).toEqual({ kind: 'chart', type: 'bar', horizontal: true, stack: true, series: 2 })
    expect(chartThumb({ type: 'line', encoding: { series: '客户' } }).series).toBe(3)
    expect(chartThumb({ type: 'kpi' }).series).toBe(1)
  })
  it('看板：卡片尺寸优先看板覆盖，其次图表尺寸，再按类型默认；图表不存在标 missing', () => {
    const charts = new Map([
      ['k', { type: 'kpi', size: { w: 3, h: 1 } }],
      ['l', { type: 'line' }],
    ])
    const t = dashboardThumb({ cards: [{ chartKey: 'k', layout: { w: 4, h: 1 } }, { chartKey: 'l' }, { chartKey: 'gone' }] }, charts)
    expect(t.blocks.map((b) => [b.w, b.h, b.type])).toEqual([
      [4, 1, 'kpi'],
      [12, 2, 'line'],
      [6, 2, 'missing'],
    ])
  })
  it('查询：前 3 列名（优先中文名）+ 计数', () => {
    expect(queryThumb({ columns: [{ column: 'a', label: '月份' }, { column: 'b' }, { column: 'c' }, { column: 'd' }], params: [1] })).toEqual({ kind: 'query', columns: ['月份', 'b', 'c'], columnCount: 4, paramCount: 1 })
  })
})
