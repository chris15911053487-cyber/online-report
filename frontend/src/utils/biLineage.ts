/**
 * BI 关系图（血缘）：查询库 → 图表 → 看板 → 使用方（Agent / 首页工作台）。
 *
 * 纯函数，供 components/bi/admin/LineageGraph.tsx 画图：
 * - buildLineage：由三张表的列表拼出节点、连线和问题标记（孤立、引用断了、已停用）
 * - 每列按相邻列的位置重心排序，减少交叉线
 * - relatedIds：某节点的全部上游 + 下游（不含「兄弟」）
 * - visibleIds：搜索 / 只看问题 / 只看这条链 之后要显示的节点
 */

export type LineageKind = 'query' | 'chart' | 'dashboard' | 'consumer'
export type IssueTone = 'warning' | 'danger'

export interface LineageIssue {
  tone: IssueTone
  text: string
}

export interface LineageNode {
  id: string
  kind: LineageKind
  /** 查询 / 图表 / 看板的标识；Agent 为 agentKey；首页工作台为空 */
  key: string
  label: string
  /** 图表类型（chart）、角色说明（首页）等附加文字 */
  sub?: string
  enabled: boolean
  /** 被引用但已不存在（只出现在查询、图表列） */
  missing?: boolean
  issues: LineageIssue[]
}

export interface LineageEdge {
  from: string
  to: string
  /** main = 图表主查询，drill = 下钻查询，card = 看板卡片，use = 看板的使用方 */
  kind: 'main' | 'drill' | 'card' | 'use'
  /** 同一看板里同一图表放了几张卡片 */
  count: number
  broken: boolean
}

export interface Lineage {
  columns: Record<LineageKind, LineageNode[]>
  edges: LineageEdge[]
  nodes: Map<string, LineageNode>
}

export interface LineageInput {
  queries: { queryKey: string; label: string; enabled: boolean }[]
  charts: { chartKey: string; label: string; type: string; enabled: boolean; queryKey: string; drill?: { queryKey: string }[] }[]
  dashboards: { dashboardKey: string; label: string; enabled: boolean; cards: { chartKey: string }[]; usedByAgents?: string[]; homeRoles?: string[] }[]
  agentLabels?: Record<string, string>
  /** 角色标识 → 显示文字 */
  formatRoles?: (roles: string[]) => string
  typeLabel?: Record<string, string>
}

export const HOME_ID = 'home'
const PREFIX: Record<LineageKind, string> = { query: 'q', chart: 'c', dashboard: 'd', consumer: 'a' }
export const nodeId = (kind: LineageKind, key: string) => `${PREFIX[kind]}:${key}`

const byLabel = (a: LineageNode, b: LineageNode) => a.label.localeCompare(b.label, 'zh-CN') || a.key.localeCompare(b.key)

/**
 * 按相邻列的重心排序：nodes 里每个节点取它在 ref 列中邻居位置的平均值，
 * 没有邻居的排在最后（按名称）。
 */
function orderByBarycenter(nodes: LineageNode[], neighbors: (id: string) => string[], refIndex: Map<string, number>): LineageNode[] {
  const center = new Map<string, number>()
  for (const n of nodes) {
    const idx = neighbors(n.id)
      .map((x) => refIndex.get(x))
      .filter((x): x is number => x != null)
    if (idx.length) center.set(n.id, idx.reduce((s, x) => s + x, 0) / idx.length)
  }
  return [...nodes].sort((a, b) => {
    const ca = center.get(a.id)
    const cb = center.get(b.id)
    if (ca != null && cb != null) return ca - cb || byLabel(a, b)
    if (ca != null) return -1
    if (cb != null) return 1
    return byLabel(a, b)
  })
}

const indexOf = (nodes: LineageNode[]) => new Map(nodes.map((n, i) => [n.id, i]))

export function buildLineage(input: LineageInput): Lineage {
  const nodes = new Map<string, LineageNode>()
  const edges = new Map<string, LineageEdge>()
  const add = (n: LineageNode) => {
    nodes.set(n.id, n)
    return n
  }
  const link = (from: string, to: string, kind: LineageEdge['kind'], broken = false) => {
    const k = `${from}>${to}>${kind}`
    const e = edges.get(k)
    if (e) e.count += 1
    else edges.set(k, { from, to, kind, count: 1, broken })
  }

  for (const q of input.queries) add({ id: nodeId('query', q.queryKey), kind: 'query', key: q.queryKey, label: q.label || q.queryKey, enabled: q.enabled, issues: [] })
  for (const c of input.charts) {
    add({ id: nodeId('chart', c.chartKey), kind: 'chart', key: c.chartKey, label: c.label || c.chartKey, sub: input.typeLabel?.[c.type] || c.type, enabled: c.enabled, issues: [] })
  }
  /** 被引用的查询 / 图表不存在：补一个「缺失」占位节点，连线标红 */
  const ensure = (kind: 'query' | 'chart', key: string) => {
    const id = nodeId(kind, key)
    if (!nodes.has(id)) add({ id, kind, key, label: `${key}（已删除）`, enabled: false, missing: true, issues: [{ tone: 'danger', text: kind === 'query' ? '查询不存在' : '图表不存在' }] })
    return nodes.get(id)!
  }

  for (const c of input.charts) {
    const cid = nodeId('chart', c.chartKey)
    const main = ensure('query', c.queryKey)
    link(main.id, cid, 'main', !!main.missing)
    // 下钻引用的查询与主查询相同时不重复画线
    for (const d of c.drill || []) {
      if (!d.queryKey || d.queryKey === c.queryKey) continue
      const q = ensure('query', d.queryKey)
      link(q.id, cid, 'drill', !!q.missing)
    }
  }

  let hasHome = false
  for (const d of input.dashboards) {
    const did = nodeId('dashboard', d.dashboardKey)
    add({ id: did, kind: 'dashboard', key: d.dashboardKey, label: d.label || d.dashboardKey, enabled: d.enabled, issues: [] })
    for (const card of d.cards) {
      const c = ensure('chart', card.chartKey)
      link(c.id, did, 'card', !!c.missing)
    }
    for (const a of d.usedByAgents || []) {
      const aid = nodeId('consumer', a)
      if (!nodes.has(aid)) add({ id: aid, kind: 'consumer', key: a, label: input.agentLabels?.[a] || a, sub: 'Agent', enabled: true, issues: [] })
      link(did, aid, 'use')
    }
    if (d.homeRoles?.length) {
      hasHome = true
      link(did, HOME_ID, 'use')
    }
  }
  if (hasHome) {
    const roles = [...new Set(input.dashboards.flatMap((d) => d.homeRoles || []))]
    add({ id: HOME_ID, kind: 'consumer', key: '', label: '首页工作台', sub: input.formatRoles ? input.formatRoles(roles) : roles.join('、'), enabled: true, issues: [] })
  }

  const edgeList = [...edges.values()]
  const outs = new Map<string, string[]>()
  const ins = new Map<string, string[]>()
  for (const e of edgeList) {
    outs.set(e.from, [...(outs.get(e.from) || []), e.to])
    ins.set(e.to, [...(ins.get(e.to) || []), e.from])
  }

  // 问题标记
  for (const n of nodes.values()) {
    if (n.missing) continue
    if (!n.enabled) n.issues.push({ tone: 'warning', text: '已停用' })
    const brokenIn = edgeList.some((e) => e.to === n.id && e.broken)
    if (n.kind === 'query' && !outs.get(n.id)?.length) n.issues.push({ tone: 'warning', text: '没有图表引用' })
    if (n.kind === 'chart') {
      if (brokenIn) n.issues.push({ tone: 'danger', text: '引用的查询不存在' })
      if (!outs.get(n.id)?.length) n.issues.push({ tone: 'warning', text: '未放进看板' })
    }
    if (n.kind === 'dashboard') {
      if (brokenIn) n.issues.push({ tone: 'danger', text: '引用的图表不存在' })
      if (!ins.get(n.id)?.length) n.issues.push({ tone: 'warning', text: '没有卡片' })
      if (!outs.get(n.id)?.length) n.issues.push({ tone: 'warning', text: '未关联 Agent / 首页' })
    }
  }

  // 排序：按重心上下来回扫，保留交叉线最少的一次
  const all = [...nodes.values()]
  const pick = (k: LineageKind) => all.filter((n) => n.kind === k)
  const neighborsIn = (id: string) => ins.get(id) || []
  const neighborsOut = (id: string) => outs.get(id) || []
  const layers: LineageNode[][] = [pick('query').sort(byLabel), pick('chart').sort(byLabel), pick('dashboard').sort(byLabel), pick('consumer').sort(byLabel)]
  const crossings = (ls: LineageNode[][]) => {
    let total = 0
    for (let i = 0; i < ls.length - 1; i++) {
      const a = indexOf(ls[i])
      const b = indexOf(ls[i + 1])
      const segs = edgeList.filter((e) => a.has(e.from) && b.has(e.to)).map((e) => [a.get(e.from)!, b.get(e.to)!])
      for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) if ((segs[x][0] - segs[y][0]) * (segs[x][1] - segs[y][1]) < 0) total++
    }
    return total
  }
  let best = layers.map((l) => [...l])
  let bestCross = crossings(best)
  for (let round = 0; round < 6 && bestCross > 0; round++) {
    // 向下扫：每列按左边一列排；向上扫：按右边一列排
    for (let i = 1; i < layers.length; i++) layers[i] = orderByBarycenter(layers[i], neighborsIn, indexOf(layers[i - 1]))
    for (let i = layers.length - 2; i >= 0; i--) layers[i] = orderByBarycenter(layers[i], neighborsOut, indexOf(layers[i + 1]))
    const c = crossings(layers)
    if (c < bestCross) {
      best = layers.map((l) => [...l])
      bestCross = c
    }
  }
  const [queries, charts, dashboards, consumers] = best

  return { columns: { query: queries, chart: charts, dashboard: dashboards, consumer: consumers }, edges: edgeList, nodes }
}

/** 某节点的全部上游与下游（含自己）；兄弟节点（同一查询的其它图表等）不算 */
export function relatedIds(lineage: Lineage, id: string): Set<string> {
  const result = new Set<string>([id])
  const walk = (start: string, dir: 'up' | 'down') => {
    const stack = [start]
    while (stack.length) {
      const cur = stack.pop()!
      for (const e of lineage.edges) {
        const next = dir === 'down' ? (e.from === cur ? e.to : null) : e.to === cur ? e.from : null
        if (next && !result.has(next)) {
          result.add(next)
          stack.push(next)
        }
      }
    }
  }
  walk(id, 'up')
  walk(id, 'down')
  return result
}

export interface VisibleOptions {
  keyword: string
  onlyIssues: boolean
  /** 只看这条链：选中节点的上下游 */
  focus?: string | null
}

/** 显示哪些节点；null = 全部。搜索 / 只看问题时连带显示命中节点的上下游，方便看清来龙去脉 */
export function visibleIds(lineage: Lineage, opts: VisibleOptions): Set<string> | null {
  if (opts.focus && lineage.nodes.has(opts.focus)) return relatedIds(lineage, opts.focus)
  const kw = opts.keyword.trim().toLowerCase()
  if (!kw && !opts.onlyIssues) return null
  const hits = [...lineage.nodes.values()].filter(
    (n) => (!kw || n.label.toLowerCase().includes(kw) || n.key.toLowerCase().includes(kw)) && (!opts.onlyIssues || n.issues.length > 0),
  )
  const result = new Set<string>()
  for (const n of hits) for (const x of relatedIds(lineage, n.id)) result.add(x)
  return result
}

/** 统计：各列数量与有问题的节点数 */
export function lineageStats(lineage: Lineage) {
  const all = [...lineage.nodes.values()]
  return {
    danger: all.filter((n) => n.issues.some((i) => i.tone === 'danger')).length,
    warning: all.filter((n) => n.issues.length > 0 && !n.issues.some((i) => i.tone === 'danger')).length,
  }
}
