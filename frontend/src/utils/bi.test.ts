import { describe, expect, it } from 'vitest'
import {
  changeRatio,
  dataBarScale,
  fillPlaceholders,
  filterDisplayText,
  formatValue,
  initialFilterValues,
  parseJsonField,
  resolveCardParams,
  resolveDefaultToken,
  toJsonText,
  toNumber,
  withColumnSemantics,
} from './bi'

const NOW = new Date(2026, 0, 15) // 2026-01-15（本地时区）

describe('resolveDefaultToken', () => {
  it('解析各记号，跨年也正确', () => {
    expect(resolveDefaultToken('$today', NOW)).toBe('2026-01-15')
    expect(resolveDefaultToken('$yesterday', new Date(2026, 0, 1))).toBe('2025-12-31')
    expect(resolveDefaultToken('$thisMonth', NOW)).toBe('2026-01')
    expect(resolveDefaultToken('$thisYear', NOW)).toBe('2026')
    expect(resolveDefaultToken('$lastYear', NOW)).toBe('2025')
    expect(resolveDefaultToken('$lastMonth', NOW)).toBe('2025-12')
    expect(resolveDefaultToken('$monthStart', NOW)).toBe('2026-01-01')
    expect(resolveDefaultToken('$yearStart', NOW)).toBe('2026-01-01')
  })
  it('非记号原样返回；未知记号为 null', () => {
    expect(resolveDefaultToken('A01', NOW)).toBe('A01')
    expect(resolveDefaultToken(5, NOW)).toBe(5)
    expect(resolveDefaultToken(undefined, NOW)).toBeNull()
    expect(resolveDefaultToken('$nope', NOW)).toBeNull()
  })
})

describe('initialFilterValues / resolveCardParams', () => {
  it('select 无默认值时取第一个选项', () => {
    const v = initialFilterValues(
      [
        { name: 'period', label: '期间', type: 'month', default: '$thisMonth' },
        { name: 'co', label: '公司', type: 'select', options: [{ value: 'A', label: '甲' }] },
        { name: 'wh', label: '仓库', type: 'string' },
      ],
      NOW,
    )
    expect(v).toEqual({ period: '2026-01', co: 'A', wh: null })
  })
  it('$filter.x 取筛选值，常量原样，缺失为 null', () => {
    expect(resolveCardParams({ p: '$filter.period', top: 10, x: '$filter.none' }, { period: '2026-09' })).toEqual({
      p: '2026-09',
      top: 10,
      x: null,
    })
  })
})

describe('数值', () => {
  it('toNumber 兼容 decimal 字符串', () => {
    expect(toNumber('12.50')).toBe(12.5)
    expect(toNumber('')).toBeNull()
    expect(toNumber('abc')).toBeNull()
    expect(toNumber(Infinity)).toBeNull()
  })
  it('formatValue：scale / format / unit', () => {
    expect(formatValue(12_800_000, { scale: 10000, unit: '万' })).toBe('1,280 万')
    expect(formatValue(1234.5, { format: 'money' })).toBe('1,234.50')
    expect(formatValue(0.1234, { format: 'percent', unit: '万' })).toBe('12.3%')
    expect(formatValue(12.6, { format: 'integer' })).toBe('13')
    expect(formatValue(3.14159)).toBe('3.14')
    expect(formatValue(null)).toBe('—')
    expect(formatValue('C001')).toBe('C001')
    expect(formatValue(5, { unit: '件' }, { withUnit: false })).toBe('5')
  })
  it('changeRatio：基数为 0 或缺失返回 null', () => {
    expect(changeRatio(110, 100)).toBeCloseTo(0.1)
    expect(changeRatio(-50, -100)).toBeCloseTo(0.5)
    expect(changeRatio(1, 0)).toBeNull()
    expect(changeRatio(1, null)).toBeNull()
  })
})

describe('parseJsonField / toJsonText', () => {
  it('空白 → 空数组/对象', () => {
    expect(parseJsonField('  ', 'x', 'array')).toEqual({ ok: true, value: [] })
    expect(parseJsonField('', 'x', 'object')).toEqual({ ok: true, value: {} })
  })
  it('类型不符与语法错误给出带字段名的提示', () => {
    const a = parseJsonField('{"a":1}', '参数定义', 'array')
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toContain('参数定义')
    const b = parseJsonField('[1,', '卡片', 'array')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toMatch(/卡片.*JSON/)
    expect(parseJsonField('[1]', 'x', 'object').ok).toBe(false)
    expect(parseJsonField('null', 'x', 'object').ok).toBe(false)
  })
  it('toJsonText：空值为空串，其余缩进', () => {
    expect(toJsonText([])).toBe('')
    expect(toJsonText({})).toBe('')
    expect(toJsonText(null)).toBe('')
    expect(toJsonText([{ a: 1 }])).toBe('[\n  {\n    "a": 1\n  }\n]')
  })
})

describe('占位符', () => {
  it('filterDisplayText：select 取选项文字，其余原样，空值跳过（与后端一致）', () => {
    const filters = [
      { name: 'cmp', label: '对比', type: 'select' as const, options: [{ value: 'yoy', label: '去年同期' }, { value: 'mom', label: '上月' }] },
      { name: 'period', label: '月份', type: 'month' as const },
      { name: 'x', label: 'x', type: 'string' as const },
    ]
    expect(filterDisplayText(filters, { cmp: 'mom', period: '2026-10', x: '' })).toEqual({ cmp: '上月', period: '2026-10' })
  })
  it('fillPlaceholders：大小写不敏感，缺值原样保留', () => {
    expect(fillPlaceholders('对比{CMP}', { cmp: '去年同期' })).toBe('对比去年同期')
    expect(fillPlaceholders('{nope}{a b}', { cmp: 'x' })).toBe('{nope}{a b}')
  })
})

describe('withColumnSemantics + 右轴', () => {
  it('主格式取左轴第一列，不被右轴的百分比列带偏', () => {
    const sem = [
      { column: '增长率', role: 'measure' as const, format: 'percent' as const },
      { column: '本期', role: 'measure' as const, format: 'money' as const, unit: '万元', scale: 10000 },
    ]
    const out = withColumnSemantics({ dimension: 'm', values: ['增长率', '本期'], rightAxis: ['增长率'] }, sem)
    expect(out.format).toBe('money')
    expect(out.unit).toBe('万元')
  })
})

describe('dataBarScale', () => {
  const rows = [{ 收入: 800, 成本: '480', 毛利: -320 }, { 收入: 1200, 成本: 720, 毛利: null }]
  it('每列各自按最大绝对值', () => {
    expect(dataBarScale(rows, ['收入', '成本', '毛利'])).toEqual({ 收入: 1200, 成本: 720, 毛利: 320 })
  })
  it('shared：各列同一比例', () => {
    expect(dataBarScale(rows, ['收入', '毛利'], true)).toEqual({ 收入: 1200, 毛利: 1200 })
  })
  it('全空的列为 0', () => {
    expect(dataBarScale([{ a: null }], ['a'])).toEqual({ a: 0 })
  })
})
