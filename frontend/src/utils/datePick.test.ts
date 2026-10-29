import { describe, expect, it } from 'vitest'
import { addMonths, displayDateValue, inRange, monthGrid, normalizeDateValue, parseDateValue } from './datePick'

describe('parseDateValue / normalizeDateValue', () => {
  it('接受常见写法', () => {
    expect(normalizeDateValue('2026-10-29', 'date')).toBe('2026-10-29')
    expect(normalizeDateValue('2026/1/5', 'date')).toBe('2026-01-05')
    expect(normalizeDateValue('2026年10月29日', 'date')).toBe('2026-10-29')
    expect(normalizeDateValue('2026-10-29T08:30', 'datetime')).toBe('2026-10-29T08:30')
    expect(normalizeDateValue('2026-10-29 8:05:00', 'datetime')).toBe('2026-10-29T08:05')
    expect(normalizeDateValue('2026-10', 'month')).toBe('2026-10')
    expect(normalizeDateValue('2026年3月', 'month')).toBe('2026-03')
    // 带日期的值用在月份选择上：取年月
    expect(normalizeDateValue('2026-10-29', 'month')).toBe('2026-10')
  })
  it('越界或乱写返回 null', () => {
    expect(parseDateValue('2026-02-30')).toBeNull()
    expect(parseDateValue('2026-13-01')).toBeNull()
    expect(parseDateValue('2026-10-29T24:00')).toBeNull()
    expect(parseDateValue('明天')).toBeNull()
    expect(parseDateValue('')).toBeNull()
  })
  it('显示：datetime 用空格，解析不了原样显示', () => {
    expect(displayDateValue('2026-10-29T08:30', 'datetime')).toBe('2026-10-29 08:30')
    expect(displayDateValue('abc', 'date')).toBe('abc')
    expect(displayDateValue(null, 'date')).toBe('')
  })
})

describe('monthGrid / addMonths / inRange', () => {
  it('周一开头，42 格，含上下月补位', () => {
    const g = monthGrid(2026, 10) // 2026-10-01 是周四
    expect(g).toHaveLength(42)
    expect(g[0]).toEqual({ y: 2026, m: 9, d: 28, inMonth: false })
    expect(g[3]).toEqual({ y: 2026, m: 10, d: 1, inMonth: true })
    expect(g.filter((c) => c.inMonth)).toHaveLength(31)
  })
  it('跨年加减月', () => {
    expect(addMonths(2026, 1, -1)).toEqual({ y: 2025, m: 12 })
    expect(addMonths(2026, 12, 1)).toEqual({ y: 2027, m: 1 })
  })
  it('范围按同一精度比较', () => {
    expect(inRange('2026-10-29', '2026-10-30')).toBe(false)
    expect(inRange('2026-10', '2026-10-30')).toBe(true)
    expect(inRange('2026-11-01', undefined, '2026-10-31')).toBe(false)
  })
})
