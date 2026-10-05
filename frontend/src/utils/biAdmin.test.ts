import { describe, expect, it } from 'vitest'
import {
  autoBindDrill,
  chartProblems,
  effectiveSource,
  newChart,
  nextRefId,
  refProblems,
  renameFilterRefs,
  resolveCard,
  suggestFilterParams,
  autoBindParams,
  cardProblems,
  cleanEncoding,
  defaultEncoding,
  extractSqlParams,
  filterFromParam,
  guessColumnRole,
  mergeDetectedColumns,
  sessionParamsUsed,
  syncParamsWithSql,
  type QueryRef,
} from './biAdmin'
import { withColumnSemantics, type BiCard, type BiChartDef, type BiColumnSemantic } from './bi'

describe('SQL 参数', () => {
  it('提取 @参数，忽略字符串、注释、标识符与 @@系统变量', () => {
    const sql = `SELECT '@x', [@y], N'@z' -- @c\n FROM T /* @d */ WHERE A = @Period AND B = @cardCode AND C = @period AND D = @@ROWCOUNT`
    expect(extractSqlParams(sql)).toEqual(['Period', 'cardCode'])
  })

  it('@_loginUser / @_loginDisplayName 是系统变量：不进参数表，单独识别', () => {
    const sql = `SELECT @_loginDisplayName AS n FROM ORDR WHERE U_Owner = @_LoginUser AND P = @period -- @x`
    expect(extractSqlParams(sql)).toEqual(['period'])
    expect(sessionParamsUsed(sql)).toEqual(['_loginUser', '_loginDisplayName'])
    expect(sessionParamsUsed(`SELECT '@_loginUser'`)).toEqual([])
    expect(syncParamsWithSql([], sql).params.map((p) => p.name)).toEqual(['period'])
  })

  it('同步参数：保留已有定义、补新参数、标出未使用的', () => {
    const r = syncParamsWithSql(
      [
        { name: 'period', type: 'string', label: '期间', required: true },
        { name: 'old', type: 'string' },
      ],
      'SELECT 1 WHERE p = @Period AND d >= @dateFrom',
    )
    expect(r.params.map((p) => p.name)).toEqual(['period', 'dateFrom', 'old'])
    expect(r.params[0].label).toBe('期间')
    expect(r.params[1].type).toBe('date')
    expect(r.unused).toEqual(['old'])
  })
})

describe('输出列识别', () => {
  it('按数据库类型与列名猜角色', () => {
    expect(guessColumnRole('Balance', 'decimal')).toBe('measure')
    expect(guessColumnRole('DocEntry', 'int')).toBe('attr')
    expect(guessColumnRole('DocDate', 'datetime')).toBe('time')
    expect(guessColumnRole('Period', 'nvarchar')).toBe('time')
    expect(guessColumnRole('CardCode', 'nvarchar')).toBe('attr')
    expect(guessColumnRole('CardName', 'nvarchar')).toBe('dimension')
    expect(guessColumnRole('Qty', undefined, 3)).toBe('measure')
  })

  it('合并：保留已登记设置，新列猜格式，报告被移除的列', () => {
    const existing: BiColumnSemantic[] = [
      { column: 'CardName', label: '客户', role: 'dimension' },
      { column: 'Gone', role: 'measure' },
    ]
    const r = mergeDetectedColumns(existing, ['CardName', 'Balance', 'Rate'], { Balance: 'decimal', Rate: 'float' })
    expect(r.columns[0]).toBe(existing[0])
    expect(r.columns[1]).toMatchObject({ column: 'Balance', role: 'measure', format: 'money' })
    expect(r.columns[2]).toMatchObject({ column: 'Rate', format: 'percent' })
    expect(r.added).toEqual(['Balance', 'Rate'])
    expect(r.removed).toEqual(['Gone'])
  })
})

describe('筛选与绑定', () => {
  it('由参数生成筛选：期间 → month，日期 → date', () => {
    expect(filterFromParam({ name: 'period', type: 'string', label: '期间' })).toEqual({ name: 'period', label: '期间', type: 'month', default: '$thisMonth' })
    expect(filterFromParam({ name: 'dateFrom', type: 'date' }).type).toBe('date')
    expect(filterFromParam({ name: 'whs', type: 'string' }).type).toBe('string')
    expect(filterFromParam({ name: 'year', type: 'string', label: '年份' })).toEqual({ name: 'year', label: '年份', type: 'year', default: '$thisYear' })
    expect(filterFromParam({ name: 'fiscalYear', type: 'string' }).type).toBe('string')
  })

  it('卡片参数自动绑定同名筛选，已设置的不动', () => {
    const filters = [{ name: 'period', label: '期间', type: 'month' as const }]
    expect(autoBindParams([{ name: 'Period', type: 'string' }, { name: 'x', type: 'string' }], filters, {})).toEqual({ Period: '$filter.period' })
    expect(autoBindParams([{ name: 'period', type: 'string' }], filters, { period: '2026-01' })).toEqual({ period: '2026-01' })
  })

  it('下钻自动绑定：同名列优先，其次同名筛选', () => {
    const r = autoBindDrill(
      [{ name: 'cardCode', type: 'string' }, { name: 'period', type: 'string' }, { name: 'other', type: 'string' }],
      ['CardCode', 'CardName'],
      [{ name: 'period', label: '期间', type: 'month' }],
      { bind: {}, params: {} },
    )
    expect(r).toEqual({ bind: { cardCode: 'CardCode' }, params: { period: '$filter.period' } })
  })
})

describe('卡片', () => {
  const cols: BiColumnSemantic[] = [
    { column: 'Month', role: 'time' },
    { column: 'CardName', role: 'dimension' },
    { column: 'Amount', role: 'measure' },
  ]

  it('默认 encoding：折线优先时间维度，柱状优先普通维度', () => {
    expect(defaultEncoding('line', cols)).toEqual({ dimension: 'Month', value: 'Amount' })
    expect(defaultEncoding('bar', cols)).toEqual({ dimension: 'CardName', value: 'Amount' })
    expect(defaultEncoding('kpi', cols)).toEqual({ value: 'Amount' })
  })

  it('切换类型时清掉无关字段', () => {
    expect(cleanEncoding('kpi', { dimension: 'A', value: 'B', horizontal: true, topN: 5 })).toEqual({ value: 'B' })
    expect(cleanEncoding('line', { dimension: 'A', value: 'B', horizontal: true })).toEqual({ dimension: 'A', value: 'B' })
  })

  it('看板卡片 id 优先用图表标识，重复时加序号', () => {
    expect(nextRefId('sales_kpi', [])).toBe('sales_kpi')
    expect(nextRefId('sales_kpi', ['sales_kpi', 'sales_kpi_2'])).toBe('sales_kpi_3')
  })

  it('引用检查与后端规则一致', () => {
    const queries = new Map<string, QueryRef>([
      ['ar', { queryKey: 'ar', label: '应收', params: [{ name: 'period', type: 'string', required: true }], columns: [{ column: 'CardCode', role: 'attr' }, { column: 'Balance', role: 'measure' }] }],
      ['docs', { queryKey: 'docs', label: '单据', params: [{ name: 'cardCode', type: 'string', required: true }] }],
    ])
    const card: BiCard = {
      id: 'c',
      type: 'bar',
      title: '应收',
      queryKey: 'ar',
      params: {},
      encoding: { dimension: 'CardName', value: 'Balance' },
      drill: [{ queryKey: 'docs', label: '单据', bind: { cardCode: 'CardCode' }, params: {}, type: 'table', encoding: {} }],
      layout: { w: 6, h: 2 },
    }
    expect(cardProblems(card, queries)).toEqual(['必填参数「period」没有取值来源', '列「CardName」不在查询的输出列中'])
    expect(cardProblems({ ...card, params: { period: '$filter.period' }, encoding: { dimension: 'CardCode', value: 'Balance' } }, queries)).toEqual([])
  })
})

describe('列语义继承', () => {
  it('卡片没写的格式/单位从主度量列继承，列名补中文', () => {
    const sem: BiColumnSemantic[] = [
      { column: 'CardName', label: '客户', role: 'dimension' },
      { column: 'Balance', label: '余额', role: 'measure', format: 'money', unit: '万', scale: 10000 },
    ]
    const enc = withColumnSemantics({ dimension: 'CardName', value: 'Balance', unit: '元' }, sem)
    expect(enc).toMatchObject({ format: 'money', scale: 10000, unit: '元' })
    expect(enc.columns).toEqual([
      { column: 'CardName', label: '客户' },
      { column: 'Balance', label: '余额', format: 'money' },
    ])
    expect(withColumnSemantics({ value: 'X' }, undefined)).toEqual({ value: 'X' })
    expect(withColumnSemantics({}, sem, ['Balance', 'Extra']).columns).toEqual([{ column: 'Balance', label: '余额', format: 'money' }, { column: 'Extra' }])
  })
})

describe('筛选维护', () => {
  const queries = new Map<string, QueryRef>([
    ['ar', { queryKey: 'ar', label: '应收', params: [{ name: 'period', type: 'string', required: true }, { name: 'whs', type: 'string' }] }],
  ])
  const card: BiCard = { id: 'c', type: 'kpi', title: 'K', queryKey: 'ar', params: { period: '$filter.p' }, encoding: { value: 'X' }, drill: [], layout: { w: 3, h: 1 } }

  it('改名同步引用，删除时去掉映射', () => {
    expect(renameFilterRefs([card], 'p', 'period')[0].params).toEqual({ period: '$filter.period' })
    expect(renameFilterRefs([card], 'p', null)[0].params).toEqual({})
  })

  it('建议筛选：未绑定且无同名筛选的参数', () => {
    expect(suggestFilterParams([card], queries, []).map((p) => p.name)).toEqual(['whs'])
    expect(suggestFilterParams([{ ...card, params: {} }], queries, []).map((p) => p.name)).toEqual(['period', 'whs'])
    const withDefault = new Map<string, QueryRef>([['ar', { ...queries.get('ar')!, params: [...queries.get('ar')!.params, { name: 'top', type: 'number', default: 10 }] }]])
    expect(suggestFilterParams([card], withDefault, []).map((p) => p.name)).toEqual(['whs'])
  })


  it('引用不存在的筛选会被检查出来', () => {
    expect(cardProblems(card, queries, new Set(['period']))).toContain('参数「period」引用的筛选「p」不存在')
  })
})

describe('图表与看板引用（与后端 bi-charts.js 一致）', () => {
  const queries = new Map<string, QueryRef>([
    ['sales', { queryKey: 'sales', label: '销售', params: [{ name: 'period', type: 'string', required: true }, { name: 'top', type: 'number', default: 20 }], columns: [{ column: 'CardCode', role: 'attr' }, { column: 'CardName', role: 'dimension' }, { column: 'Amount', role: 'measure' }] }],
    ['docs', { queryKey: 'docs', label: '单据', params: [{ name: 'Period', type: 'string', required: true }, { name: 'cardCode', type: 'string', required: true }] }],
  ])
  const chart: BiChartDef = {
    ...newChart(),
    chartKey: 'top_cust',
    label: '客户 Top',
    queryKey: 'sales',
    params: { top: 10 },
    encoding: { dimension: 'CardName', value: 'Amount' },
    drill: [{ queryKey: 'docs', label: '单据', bind: { cardCode: 'CardCode' }, params: {}, type: 'table', encoding: {} }],
  }
  const filters = [{ name: 'period', label: '期间', type: 'month' as const }, { name: 'cardcode', label: '客户', type: 'string' as const }]

  it('图表自身不要求必填参数有来源', () => {
    expect(chartProblems(chart, queries)).toEqual([])
    expect(chartProblems({ ...chart, chartKey: 'Bad' }, queries)[0]).toMatch(/图表标识/)
  })

  it('展开：同名筛选自动绑定，图表固定值优先，下钻 bind 优先于筛选', () => {
    const card = resolveCard({ id: 'a', chartKey: 'top_cust' }, chart, filters, queries)
    expect(card.params).toEqual({ top: 10, period: '$filter.period' })
    expect(card.drill[0].params).toEqual({ Period: '$filter.period' })
    expect(card.layout).toEqual({ w: 6, h: 2 })
    const over = resolveCard({ id: 'a', chartKey: 'top_cust', title: 'T', params: { TOP: 5, period: '2026-01' } }, chart, filters, queries)
    expect(over.params).toEqual({ TOP: 5, period: '2026-01' })
    expect(over.drill[0].params).toEqual({ period: '2026-01' })
    expect(over.title).toBe('T')
  })

  it('看板卡片问题：缺图表、缺筛选来源', () => {
    expect(refProblems({ id: 'a', chartKey: '' }, undefined, filters, queries)).toEqual(['未选择图表'])
    expect(refProblems({ id: 'a', chartKey: 'x' }, undefined, filters, queries)).toEqual(['图表「x」不存在'])
    expect(refProblems({ id: 'a', chartKey: 'top_cust' }, chart, filters, queries)).toEqual([])
    expect(refProblems({ id: 'a', chartKey: 'top_cust' }, chart, [], queries).join()).toMatch(/必填参数「period」没有取值来源/)
  })

  it('参数实际来源：覆盖 > 图表固定 > 同名筛选 > 查询默认', () => {
    const [period, top] = queries.get('sales')!.params
    expect(effectiveSource(period, { id: 'a', chartKey: 'top_cust' }, chart, filters)).toEqual({ kind: 'filter', filter: 'period' })
    expect(effectiveSource(top, { id: 'a', chartKey: 'top_cust' }, chart, filters)).toEqual({ kind: 'fixed', value: 10 })
    expect(effectiveSource(top, { id: 'a', chartKey: 'top_cust' }, { ...chart, params: {} }, filters)).toEqual({ kind: 'default', value: 20 })
    expect(effectiveSource(period, { id: 'a', chartKey: 'top_cust', params: { period: 'x' } }, chart, filters)).toEqual({ kind: 'override', value: 'x' })
    expect(effectiveSource(period, { id: 'a', chartKey: 'top_cust' }, chart, [])).toEqual({ kind: 'none' })
  })
})
