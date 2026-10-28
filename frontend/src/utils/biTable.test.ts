import { describe, expect, it } from 'vitest'
import { filterRows, sortRows, sumColumns, summableColumns, toggleSort, toTsv } from './biTable'

const rows = [
  { No: 'A-10', Name: '客户乙', Amt: '1200.5', Rate: 0.1, Code: '007' },
  { No: 'A-2', Name: '客户甲', Amt: 300, Rate: 0.2, Code: '010' },
  { No: 'A-3', Name: null, Amt: null, Rate: null, Code: '' },
]
const cols = [{ column: 'No' }, { column: 'Name' }, { column: 'Amt', format: 'money' as const }, { column: 'Rate', format: 'percent' as const }, { column: 'Code' }]

describe('toggleSort', () => {
  it('升序 → 降序 → 取消；Shift 追加多列', () => {
    let s = toggleSort([], 'Amt', false)
    expect(s).toEqual([{ column: 'Amt', dir: 'asc' }])
    s = toggleSort(s, 'Amt', false)
    expect(s).toEqual([{ column: 'Amt', dir: 'desc' }])
    expect(toggleSort(s, 'Amt', false)).toEqual([])
    s = toggleSort(s, 'Name', true)
    expect(s).toEqual([{ column: 'Amt', dir: 'desc' }, { column: 'Name', dir: 'asc' }])
    expect(toggleSort(s, 'Name', false)).toEqual([{ column: 'Name', dir: 'desc' }])
  })
})

describe('sortRows', () => {
  it('数字按数值（含数字文本）、文本按自然顺序，空值总在最后', () => {
    expect(sortRows(rows, [{ column: 'Amt', dir: 'asc' }]).map((r) => r.No)).toEqual(['A-2', 'A-10', 'A-3'])
    expect(sortRows(rows, [{ column: 'Amt', dir: 'desc' }]).map((r) => r.No)).toEqual(['A-10', 'A-2', 'A-3'])
    expect(sortRows(rows, [{ column: 'No', dir: 'asc' }]).map((r) => r.No)).toEqual(['A-2', 'A-3', 'A-10'])
  })
  it('不排序时原样返回', () => {
    expect(sortRows(rows, [])).toBe(rows)
  })
})

describe('filterRows', () => {
  it('搜索任一列（按显示文字）+ 按列筛选，不区分大小写', () => {
    expect(filterRows(rows, cols, '甲', {}).map((r) => r.No)).toEqual(['A-2'])
    expect(filterRows(rows, cols, '1,200.50', {}).map((r) => r.No)).toEqual(['A-10']) // 金额按千分位显示
    expect(filterRows(rows, cols, 'a-', { Name: '乙' }).map((r) => r.No)).toEqual(['A-10'])
    expect(filterRows(rows, cols, '', { Name: '  ' })).toBe(rows)
  })
})

describe('合计', () => {
  it('有语义按语义（度量、非百分比）；没有语义时全是数字才合计；编码文本也算数字，所以有语义时以语义为准', () => {
    expect(summableColumns(cols, rows)).toEqual(['Amt', 'Code'])
    const sem = [
      { column: 'Amt', role: 'measure' as const },
      { column: 'Code', role: 'dimension' as const },
      { column: 'Rate', role: 'measure' as const, format: 'percent' as const },
    ]
    expect(summableColumns(cols, rows, sem)).toEqual(['Amt'])
    expect(sumColumns(rows, ['Amt'])).toEqual({ Amt: 1500.5 })
  })
})

describe('toTsv', () => {
  it('表头用显示名，数字不加千分位，制表符 / 换行替换掉', () => {
    const t = toTsv(cols.slice(0, 3), [{ No: 'A\t1', Name: '多\n行', Amt: '1200.5' }], (c) => (c.column === 'Amt' ? '金额' : c.column))
    expect(t).toBe('No\tName\t金额\nA 1\t多 行\t1200.5')
  })
})
