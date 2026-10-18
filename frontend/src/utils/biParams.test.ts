/** 参数类型与取值约束（与后端 server/src/bi-params.js、test/bi-params.test.js 同规则） */
import { describe, expect, it } from 'vitest'
import { cardProblems, filterFromParam, guessParamType, paramDefProblems, paramDefsOfCards, paramOptionsFor, paramValueProblem, splitList, textToOptions, optionsToText, type QueryRef } from './biAdmin'
import { filterDisplayText, initialFilterValues, type BiCard, type BiFilter, type BiParamDef } from './bi'

const cmp: BiParamDef = { name: 'cmp', type: 'string', label: '对比方式', options: [{ value: 'yoy', label: '同比' }, { value: 'mom', label: '环比' }] }

describe('参数取值校验', () => {
  it('可选值：不在其中的值报错', () => {
    expect(paramValueProblem(cmp, 'mom')).toBe('')
    expect(paramValueProblem(cmp, '同比')).toMatch(/「同比」不在可选值中/)
    expect(paramValueProblem({ ...cmp, type: 'list' }, ['yoy', 'x'])).toMatch(/「x」不在可选值中/)
    expect(paramValueProblem({ ...cmp, type: 'list' }, 'yoy,mom')).toBe('')
  })

  it('月份 / 日期 / 数字范围 / 多选只能传给多选；动态值记号放行', () => {
    const month: BiParamDef = { name: 'period', type: 'month' }
    for (const v of ['2026-09', '2026-9', '202609', '2026/09']) expect(paramValueProblem(month, v)).toBe('')
    expect(paramValueProblem(month, '2026-13')).toMatch(/须为月份/)
    expect(paramValueProblem(month, '$lastMonth')).toBe('')
    expect(paramValueProblem({ name: 'd', type: 'date' }, '2026/09/01')).toMatch(/须为日期/)
    const top: BiParamDef = { name: 'top', type: 'number', min: 1, max: 100 }
    expect(paramValueProblem(top, 0)).toMatch(/不能小于 1/)
    expect(paramValueProblem(top, '101')).toMatch(/不能大于 100/)
    expect(paramValueProblem(top, 'abc')).toMatch(/须为数字/)
    expect(paramValueProblem({ name: 's', type: 'string' }, ['a'])).toMatch(/不是多选参数/)
    expect(paramValueProblem(top, undefined)).toBe('')
  })

  it('参数定义问题：约束与类型不符、范围颠倒、默认值不合法', () => {
    expect(paramDefProblems({ name: 'd', type: 'date', options: [{ value: 'x', label: 'x' }] })).toContain('只有文本 / 数字 / 多选参数能设置可选值')
    expect(paramDefProblems({ name: 'n', type: 'number', min: 5, max: 1 })).toContain('最小值不能大于最大值')
    expect(paramDefProblems({ ...cmp, default: 'xx' })[0]).toMatch(/^默认值：的值「xx」不在可选值中/)
    expect(paramDefProblems({ name: 's', type: 'string', optionsQuery: { queryKey: 'q', valueColumn: '' } })).toContain('请选择选项来源的查询与取值列')
    expect(paramDefProblems(cmp)).toEqual([])
  })

  it('多选文本拆分与选项文本互转', () => {
    expect(splitList('01, 02、03；03\n04')).toEqual(['01', '02', '03', '04'])
    expect(splitList(['a', 'a', ' b '])).toEqual(['a', 'b'])
    const opts = textToOptions('yoy=同比\nmom=环比\nytd')
    expect(opts).toEqual([{ value: 'yoy', label: '同比' }, { value: 'mom', label: '环比' }, { value: 'ytd', label: 'ytd' }])
    expect(optionsToText(opts)).toBe('yoy=同比\nmom=环比\nytd')
  })

  it('新参数按名称猜类型：期间 / 月份为 month', () => {
    expect(guessParamType('period')).toBe('month')
    expect(guessParamType('ym')).toBe('month')
    expect(guessParamType('dateFrom')).toBe('date')
    expect(guessParamType('top')).toBe('number')
    expect(guessParamType('total')).toBe('string')
    for (const n of ['toDate', 'from_date', 'end', 'startTime', 'DateFrom', 'today']) expect(guessParamType(n)).toBe('date')
    expect(guessParamType('whs')).toBe('string')
  })
})

describe('筛选与参数', () => {
  it('由参数生成筛选：可选值 → 下拉并带出选项；多选参数 → 多选下拉；是/否 → 下拉；参数默认值优先', () => {
    expect(filterFromParam({ ...cmp, default: 'yoy' })).toEqual({ name: 'cmp', label: '对比方式', type: 'select', options: cmp.options, default: 'yoy' })
    const q = { queryKey: 'customers', valueColumn: 'CardCode', labelColumn: 'CardName' }
    expect(filterFromParam({ name: 'cust', type: 'list', optionsQuery: q })).toEqual({ name: 'cust', label: 'cust', type: 'select', optionsQuery: q, multiple: true })
    expect(filterFromParam({ name: 'open', type: 'bool' }).options).toEqual([{ value: true, label: '是' }, { value: false, label: '否' }])
    expect(filterFromParam({ name: 'p', type: 'month' })).toMatchObject({ type: 'month', default: '$thisMonth' })
    expect(filterFromParam({ name: 'p', type: 'month', default: '$lastMonth' }).default).toBe('$lastMonth')
    // 多选参数但没有选项：文本筛选（逗号分隔），数组默认值不带给单值筛选
    expect(filterFromParam({ name: 'whs', type: 'list', default: ['01'] })).toEqual({ name: 'whs', label: 'whs', type: 'string' })
  })

  it('同名参数的选项可一键带出；已一致时不提示', () => {
    const f: BiFilter = { name: 'cmp', label: '对比', type: 'select', options: [] }
    expect(paramOptionsFor(f, cmp)).toEqual({ options: cmp.options, optionsQuery: undefined, multiple: undefined })
    expect(paramOptionsFor({ ...f, options: cmp.options }, cmp)).toBeNull()
    expect(paramOptionsFor({ ...f, type: 'string' }, cmp)).toBeNull()
    expect(paramOptionsFor(f, { name: 'cmp', type: 'string' })).toBeNull()
  })

  it('看板卡片的参数定义：有可选值的优先', () => {
    const queries = new Map<string, QueryRef>([
      ['a', { queryKey: 'a', label: 'A', params: [{ name: 'cmp', type: 'string' }] }],
      ['b', { queryKey: 'b', label: 'B', params: [cmp] }],
    ])
    const card = (queryKey: string) => ({ id: queryKey, type: 'table', title: 't', queryKey, params: {}, encoding: {}, drill: [], layout: { w: 12, h: 2 } }) as BiCard
    expect(paramDefsOfCards([card('a'), card('b')], queries).get('cmp')).toBe(cmp)
  })

  it('多选筛选：初始值为默认数组或空（= 全部）；占位符列出前 3 项', () => {
    const filters: BiFilter[] = [
      { name: 'whs', label: '仓库', type: 'select', multiple: true, options: [{ value: '01', label: '一号仓' }, { value: '02', label: '二号仓' }] },
      { name: 'grp', label: '组', type: 'select', multiple: true, options: [{ value: 'A', label: 'A' }], default: ['A'] },
      { name: 'cust', label: '客户', type: 'select', optionsQuery: { queryKey: 'c', valueColumn: 'CardCode' } },
    ]
    expect(initialFilterValues(filters)).toEqual({ whs: null, grp: ['A'], cust: null })
    expect(filterDisplayText(filters, { whs: ['01', '02'] })).toEqual({ whs: '一号仓、二号仓' })
    expect(filterDisplayText(filters, { whs: ['01', '02', '03', '04'] }).whs).toBe('一号仓、二号仓、03 等 4 项')
    // 来自查询的选项：取到后传入
    expect(filterDisplayText(filters, { cust: 'C1' }, { cust: [{ value: 'C1', label: '甲公司' }] })).toEqual({ cust: '甲公司' })
  })

  it('卡片检查：多选筛选只能传给多选参数；固定值按约束检查', () => {
    const queries = new Map<string, QueryRef>([
      ['sales', { queryKey: 'sales', label: '销售', params: [cmp, { name: 'whs', type: 'list' }, { name: 'cust', type: 'string' }] }],
    ])
    const filters: BiFilter[] = [
      { name: 'whs', label: '仓库', type: 'select', multiple: true, options: [] },
      { name: 'cust', label: '客户', type: 'select', multiple: true, options: [] },
    ]
    const card = (params: BiCard['params']) => ({ id: 'c', type: 'table', title: 't', queryKey: 'sales', params, encoding: {}, drill: [], layout: { w: 12, h: 2 } }) as BiCard
    const names = new Set(filters.map((f) => f.name))
    expect(cardProblems(card({ whs: '$filter.whs', cmp: 'mom' }), queries, names, { filters })).toEqual([])
    const probs = cardProblems(card({ cust: '$filter.cust', cmp: '同比' }), queries, names, { filters })
    expect(probs.join('；')).toMatch(/筛选「客户」是多选，参数「cust」不是多选参数/)
    expect(probs.join('；')).toMatch(/「同比」不在可选值中/)
  })
})
