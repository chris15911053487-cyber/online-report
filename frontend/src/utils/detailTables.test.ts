import { describe, expect, it } from 'vitest'
import { detailTableTitle, formatDetailValue, isNumericColumn, splitCardColumns, visibleColumns } from './detailTables'

describe('detailTables', () => {
  it('formatDetailValue：日期去掉 T/Z，零点只留日期；数字去多余小数', () => {
    expect(formatDetailValue('2026-10-29T00:00:00.000Z')).toBe('2026-10-29')
    expect(formatDetailValue('2026-10-29T08:30:12.000Z')).toBe('2026-10-29 08:30')
    expect(formatDetailValue(12.5)).toBe('12.5')
    expect(formatDetailValue('100.000000')).toBe('100')
    expect(formatDetailValue(null)).toBe('')
    expect(formatDetailValue(true)).toBe('是')
  })

  it('visibleColumns：隐藏 _ 开头和整列为空的列', () => {
    const t = { columns: ['_title', 'A', 'B', 'C'], rows: [{ _title: 'x', A: 1, B: null, C: '' }, { A: 2, B: '', C: 'y' }] }
    expect(visibleColumns(t)).toEqual(['A', 'C'])
  })

  it('isNumericColumn', () => {
    const rows = [{ q: 1, s: 'a' }, { q: '2.50', s: '3' }, { q: null }]
    expect(isNumericColumn('q', rows)).toBe(true)
    expect(isNumericColumn('s', rows)).toBe(false)
  })

  it('detailTableTitle：_title 优先，否则单行=订单信息，多行=明细', () => {
    expect(detailTableTitle({ columns: [], rows: [{ _title: '工序进度' }, {}] }, 1)).toBe('工序进度')
    expect(detailTableTitle({ columns: [], rows: [{}] }, 0)).toBe('订单信息')
    expect(detailTableTitle({ columns: [], rows: [{}, {}] }, 1)).toBe('明细')
  })
})

describe('splitCardColumns', () => {
  it('开头文本列作抬头，数字列单独一组', () => {
    const rows = [{ code: 'J031-098-1', name: '雨布', spec: '20mm', plan: 430, done: 0, wh: '原料仓' }]
    expect(splitCardColumns(['code', 'name', 'spec', 'plan', 'done', 'wh'], rows)).toEqual({
      lead: ['code', 'name', 'spec'],
      nums: ['plan', 'done'],
      others: ['wh'],
    })
  })
})
