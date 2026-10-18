import { describe, expect, it } from 'vitest'
import { DEFAULT_LIST_FILTER, NO_OPERATOR, filterAdminList, formatUpdatedAt, operatorsOf } from './biAdminList'

const items = [
  { key: 'sales_month', label: '月度销售', enabled: true, updatedAt: '2026-10-10T09:30:00.000Z', updatedBy: '张三', desc: '按月汇总' },
  { key: 'ar_balance', label: '应收余额', enabled: false, updatedAt: '2026-10-18T14:05:12.000Z', updatedBy: '李四', desc: '' },
  { key: 'stock', label: '库存', enabled: true, updatedAt: null, updatedBy: null, desc: '仓库库存' },
]
const keyOf = (x: (typeof items)[number]) => x.key

describe('formatUpdatedAt', () => {
  it('直接取墙钟字面值，不做时区换算', () => {
    expect(formatUpdatedAt('2026-10-18T14:05:12.000Z')).toBe('2026-10-18 14:05')
    expect(formatUpdatedAt(null)).toBe('')
    expect(formatUpdatedAt('bad')).toBe('')
  })
})

describe('filterAdminList', () => {
  it('默认按最近修改排序，没有时间的排最后', () => {
    expect(filterAdminList(items, DEFAULT_LIST_FILTER, keyOf).map(keyOf)).toEqual(['ar_balance', 'sales_month', 'stock'])
  })
  it('按标识排序', () => {
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, sort: 'key' }, keyOf).map(keyOf)).toEqual(['ar_balance', 'sales_month', 'stock'].sort())
  })
  it('关键字匹配名称、标识与附加文字，不区分大小写', () => {
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, keyword: 'SALES' }, keyOf).map(keyOf)).toEqual(['sales_month'])
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, keyword: '仓库' }, keyOf, (x) => x.desc).map(keyOf)).toEqual(['stock'])
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, keyword: '仓库' }, keyOf).map(keyOf)).toEqual([])
  })
  it('状态与操作人', () => {
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, status: 'disabled' }, keyOf).map(keyOf)).toEqual(['ar_balance'])
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, status: 'enabled', operator: '张三' }, keyOf).map(keyOf)).toEqual(['sales_month'])
    expect(filterAdminList(items, { ...DEFAULT_LIST_FILTER, operator: NO_OPERATOR }, keyOf).map(keyOf)).toEqual(['stock'])
  })
  it('operatorsOf 去重排序、忽略空值', () => {
    expect(operatorsOf([...items, items[0]])).toEqual(['李四', '张三'].sort((a, b) => a.localeCompare(b, 'zh-CN')))
  })
})
