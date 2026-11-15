import { describe, expect, it } from 'vitest'
import { HOME_ID, buildLineage, lineageStats, relatedIds, visibleIds, type LineageInput } from './biLineage'

const input: LineageInput = {
  queries: [
    { queryKey: 'sales', label: '销售汇总', enabled: true },
    { queryKey: 'sales_detail', label: '销售明细', enabled: true },
    { queryKey: 'stock', label: '库存', enabled: true },
    { queryKey: 'old', label: '旧查询', enabled: false },
  ],
  charts: [
    { chartKey: 'trend', label: '月度趋势', type: 'line', enabled: true, queryKey: 'sales', drill: [{ queryKey: 'sales_detail' }, { queryKey: 'sales' }] },
    { chartKey: 'yoy', label: '同比', type: 'bar', enabled: true, queryKey: 'sales' },
    { chartKey: 'turnover', label: '周转', type: 'kpi', enabled: true, queryKey: 'stock' },
    { chartKey: 'lost', label: '断链图表', type: 'bar', enabled: true, queryKey: 'gone' },
  ],
  dashboards: [
    { dashboardKey: 'boss', label: '老板首页', enabled: true, cards: [{ chartKey: 'trend' }, { chartKey: 'trend' }], homeRoles: ['manager'] },
    { dashboardKey: 'sales_board', label: '销售总览', enabled: true, cards: [{ chartKey: 'trend' }, { chartKey: 'yoy' }, { chartKey: 'deleted' }], usedByAgents: ['sales-agent'] },
  ],
  agentLabels: { 'sales-agent': '销售助手' },
  typeLabel: { line: '折线' },
}

describe('buildLineage', () => {
  const l = buildLineage(input)
  const issues = (id: string) => l.nodes.get(id)!.issues.map((i) => i.text)

  it('节点与连线：主查询、下钻（与主查询相同的不重复）、卡片（同图表多卡片合并计数）、使用方', () => {
    const e = (from: string, to: string) => l.edges.find((x) => x.from === from && x.to === to)
    expect(e('q:sales', 'c:trend')?.kind).toBe('main')
    expect(e('q:sales_detail', 'c:trend')?.kind).toBe('drill')
    expect(l.edges.filter((x) => x.from === 'q:sales' && x.to === 'c:trend')).toHaveLength(1)
    expect(e('c:trend', 'd:boss')?.count).toBe(2)
    expect(e('d:sales_board', 'a:sales-agent')?.kind).toBe('use')
    expect(e('d:boss', HOME_ID)?.kind).toBe('use')
    expect(l.nodes.get('a:sales-agent')?.label).toBe('销售助手')
    expect(l.nodes.get('c:trend')?.sub).toBe('折线')
  })

  it('引用断了：补缺失节点并标红', () => {
    expect(l.nodes.get('q:gone')?.missing).toBe(true)
    expect(l.edges.find((x) => x.from === 'q:gone')?.broken).toBe(true)
    expect(issues('c:lost')).toContain('引用的查询不存在')
    expect(l.nodes.get('c:deleted')?.missing).toBe(true)
    expect(issues('d:sales_board')).toContain('引用的图表不存在')
  })

  it('孤立与停用', () => {
    expect(issues('q:old')).toEqual(['已停用', '没有图表引用'])
    expect(issues('c:turnover')).toEqual(['未放进看板'])
    expect(issues('q:sales')).toEqual([])
    expect(lineageStats(l)).toEqual({ danger: 4, warning: 2 })
  })

  it('排序：有连线的按邻居位置排，孤立的排最后', () => {
    const qs = l.columns.query.map((n) => n.key)
    expect(qs.indexOf('old')).toBe(qs.length - 1)
    const cs = l.columns.chart.map((n) => n.key)
    expect(cs.indexOf('trend')).toBeLessThan(cs.indexOf('turnover'))
  })
})

describe('排序减少交叉', () => {
  it('按名称排会交叉时，调整成平行', () => {
    const l = buildLineage({
      queries: [
        { queryKey: 'a', label: 'A', enabled: true },
        { queryKey: 'b', label: 'B', enabled: true },
      ],
      charts: [
        { chartKey: 'x', label: 'X', type: 'bar', enabled: true, queryKey: 'b' },
        { chartKey: 'y', label: 'Y', type: 'bar', enabled: true, queryKey: 'a' },
      ],
      dashboards: [],
    })
    const q = l.columns.query.map((n) => n.key)
    const c = l.columns.chart.map((n) => n.key)
    expect(q.indexOf('a') < q.indexOf('b')).toBe(c.indexOf('y') < c.indexOf('x'))
  })
})

describe('relatedIds / visibleIds', () => {
  const l = buildLineage(input)
  it('上游 + 下游，不含兄弟', () => {
    const r = relatedIds(l, 'c:yoy')
    expect([...r].sort()).toEqual(['a:sales-agent', 'c:yoy', 'd:sales_board', 'q:sales'].sort())
    expect(r.has('c:trend')).toBe(false)
  })
  it('选中查询：带出全部下游', () => {
    const r = relatedIds(l, 'q:sales_detail')
    expect([...r].sort()).toEqual(['a:sales-agent', 'c:trend', 'd:boss', 'd:sales_board', HOME_ID, 'q:sales_detail'].sort())
  })
  it('搜索与只看问题连带上下游；无条件返回 null', () => {
    expect(visibleIds(l, { keyword: '', onlyIssues: false })).toBeNull()
    const kw = visibleIds(l, { keyword: '周转', onlyIssues: false })!
    expect([...kw].sort()).toEqual(['c:turnover', 'q:stock'])
    const iss = visibleIds(l, { keyword: '', onlyIssues: true })!
    expect(iss.has('q:old')).toBe(true)
    expect(iss.has('q:gone')).toBe(true)
    expect(visibleIds(l, { keyword: '周转', onlyIssues: false, focus: 'c:yoy' })!.has('c:turnover')).toBe(false)
  })
})
