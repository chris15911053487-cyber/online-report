/**
 * BI 关系图：查询库 → 图表 → 看板 → 使用方，React Flow 画布（缩放 / 平移 / 小地图 / 可拖动节点）。
 *
 * 关系计算在 utils/biLineage.ts，排版在 utils/biLineageLayout.ts（elkjs 分层）。
 * 悬停预览上下游，点击锁定（其余变淡、链路上有流动光点），「只看这条链」重新排版只留相关项；
 * 搜索 / 只看问题时连带显示命中项的上下游。双击或「打开编辑」进入对应编辑器。
 * 高亮状态经 context 传给自定义节点 / 连线，不重建节点数组，拖动过的位置不丢。
 * 节点可显示示意缩略图（LineageThumbs.tsx，只按配置画），缩小到看不清细节时自动只显示大号名称；
 * 「全屏」用浏览器全屏 API，不支持时铺满窗口。
 */
import { createContext, createElement, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  getNodesBounds,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './lineage.css'
import { BarChart3, Bot, ChartColumnStacked, ChartLine, ChartPie, Database, Gauge, GitFork, House, Image as ImageIcon, LayoutDashboard, Link2Off, Maximize2, Minimize2, Pencil, Search, Table2, X, type LucideIcon } from 'lucide-react'
import { Button, Card, EmptyState, Input, Segmented } from '../../../ui'
import { cn } from '../../../ui/classes'
import { HOME_ID, buildLineage, lineageStats, relatedIds, visibleIds, type Lineage, type LineageInput, type LineageKind, type LineageNode } from '../../../utils/biLineage'
import { NODE_H, NODE_H_THUMB, NODE_W, layoutLineage } from '../../../utils/biLineageLayout'
import { chartThumb, dashboardThumb, queryThumb, type Thumb } from '../../../utils/biLineageThumb'
import { ThumbView } from './LineageThumbs'
import type { BiChartAdmin, BiDashboardAdmin, BiQueryAdmin } from './types'

const KIND_LABEL: Record<LineageKind, string> = {
  query: '查询',
  chart: '图表',
  dashboard: '看板',
  consumer: '使用方',
}

/** 每层一种颜色：图标底色 / 小地图 / 图例 */
const TONE: Record<LineageKind, { box: string; token: string }> = {
  query: { box: 'bg-info-soft text-info', token: 'info' },
  chart: { box: 'bg-primary-soft text-primary', token: 'primary' },
  dashboard: { box: 'bg-accent-soft text-accent', token: 'accent' },
  consumer: { box: 'bg-success-soft text-success', token: 'success' },
}
const CHART_ICON: Record<string, LucideIcon> = {
  bar: BarChart3,
  line: ChartLine,
  pie: ChartPie,
  kpi: Gauge,
  waterfall: ChartColumnStacked,
  sankey: GitFork,
  table: Table2,
}
const color = (token: string, alpha?: number) => (alpha == null ? `rgb(var(--c-${token}))` : `rgb(var(--c-${token}) / ${alpha})`)

function iconOf(n: LineageNode & { chartType?: string }): LucideIcon {
  if (n.missing) return Link2Off
  if (n.kind === 'query') return Database
  if (n.kind === 'chart') return CHART_ICON[n.chartType || ''] || BarChart3
  if (n.kind === 'dashboard') return LayoutDashboard
  return n.id === HOME_ID ? House : Bot
}

/** 高亮状态：节点 / 连线组件从这里读，避免为了悬停重建整个节点数组 */
interface HighlightState {
  related: Set<string> | null
  locked: string | null
  thumbs: boolean
}
const HighlightCtx = createContext<HighlightState>({
  related: null,
  locked: null,
  thumbs: false,
})

/** 缩放低于这个值时节点只显示大号名称（细节看不清了） */
const LOW_ZOOM = 0.5
const THUMBS_PREF = 'bi_lineage_thumbs'

type NodeData = { node: LineageNode & { chartType?: string }; caption: string; thumb?: Thumb }
type LineageFlowNode = Node<NodeData, 'lineage'>
type EdgeData = {
  kind: 'main' | 'drill' | 'card' | 'use'
  broken: boolean
  count: number
}
type LineageFlowEdge = Edge<EdgeData, 'flow'>

const HANDLE = '!w-1.5 !h-1.5 !min-w-0 !min-h-0 !border-0 !bg-line-strong'

const LineageNodeView = memo(function LineageNodeView({ id, data }: NodeProps<LineageFlowNode>) {
  const { related, locked, thumbs } = useContext(HighlightCtx)
  const lowZoom = useStore((st) => st.transform[2] < LOW_ZOOM)
  const n = data.node
  const danger = n.issues.some((i) => i.tone === 'danger')
  const dim = !!related && !related.has(id)
  const selected = locked === id
  const tip = [n.label, n.key ? `标识：${n.key}` : '', data.caption, ...n.issues.map((i) => `⚠ ${i.text}`)].filter(Boolean).join('\n')
  const icon = (size: string, box: string) => (
    <span className={cn('shrink-0 rounded-lg grid place-items-center', box, n.missing ? 'bg-danger-soft text-danger' : TONE[n.kind].box, !n.enabled && !n.missing && 'opacity-60')}>
      {createElement(iconOf(n), { className: size, strokeWidth: 2 })}
    </span>
  )
  const labelCls = n.missing ? 'text-danger' : n.enabled ? 'text-fg' : 'text-muted line-through'
  return (
    <div
      title={tip}
      style={{ width: NODE_W, height: thumbs ? NODE_H_THUMB : NODE_H }}
      className={cn(
        'relative flex flex-col rounded-xl border bg-surface shadow-sm cursor-pointer',
        'transition-[opacity,box-shadow,border-color,transform] duration-200 ease-out hover:-translate-y-px hover:shadow-md',
        n.missing ? 'border-dashed border-danger' : danger ? 'border-danger/60' : 'border-line',
        selected && 'border-primary ring-[3px] ring-primary/25',
        dim && 'opacity-20',
        !n.enabled && !n.missing && 'bg-surface-2',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={HANDLE} />
      {lowZoom ? (
        // 缩得很小：只留大图标 + 大号名称，远看也认得出
        <div className="flex-1 flex items-center gap-3 px-3 min-h-0">
          {icon('w-7 h-7', 'w-12 h-12')}
          <span className={cn('min-w-0 text-[22px] font-semibold leading-tight line-clamp-2 break-all', labelCls)}>{n.label}</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 px-2.5 shrink-0" style={{ height: NODE_H - 2 }}>
            {icon('w-[18px] h-[18px]', 'w-9 h-9')}
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[13px] font-medium leading-tight truncate', labelCls)}>{n.label}</span>
              <span className="block text-[11px] text-muted leading-tight mt-0.5 truncate">{data.caption}</span>
            </span>
          </div>
          {thumbs && (
            <div className="mx-2 mb-2 flex-1 min-h-0 rounded-lg bg-surface-2 overflow-hidden grid place-items-center">
              <ThumbView thumb={data.thumb} missing={n.missing} consumer={n.kind === 'consumer' ? (n.id === HOME_ID ? 'home' : 'agent') : undefined} />
            </div>
          )}
        </>
      )}
      {n.issues.length > 0 && (
        <span
          className={cn('absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full grid place-items-center text-[11px] font-bold text-white shadow-sm', danger ? 'bg-danger' : 'bg-warning')}
        >
          {n.issues.length > 1 ? n.issues.length : '!'}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className={HANDLE} />
    </div>
  )
})

function FlowEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<LineageFlowEdge>) {
  const { related } = useContext(HighlightCtx)
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  })
  const on = !!related && related.has(source) && related.has(target)
  const broken = !!data?.broken
  const stroke = broken ? color('danger') : on ? color('primary') : color('line-strong')
  const opacity = related ? (on ? 1 : 0.1) : broken ? 0.9 : 0.75
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeOpacity: opacity,
          strokeWidth: on ? 2.25 : 1.5,
          strokeDasharray: data?.kind === 'drill' || broken ? '6 4' : undefined,
        }}
      />
      {on && !broken && (
        <>
          {[0, 0.9].map((begin) => (
            <circle key={begin} r={3.2} style={{ fill: color('primary') }}>
              <animateMotion dur="1.8s" begin={`${begin}s`} repeatCount="indefinite" path={path} />
            </circle>
          ))}
        </>
      )}
      {broken && (
        <EdgeLabelRenderer>
          <span
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className="absolute pointer-events-none w-5 h-5 rounded-full bg-surface border border-danger text-danger grid place-items-center"
            title="引用断了"
          >
            <Link2Off className="w-3 h-3" />
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { lineage: LineageNodeView }
const edgeTypes = { flow: FlowEdgeView }

/** 节点第二行：查询 = 被几个图表用，图表 = 类型，看板 = 几张卡片，使用方 = Agent / 首页角色 */
function captions(lineage: Lineage) {
  const outs = new Map<string, number>()
  const cards = new Map<string, number>()
  for (const e of lineage.edges) {
    outs.set(e.from, (outs.get(e.from) || 0) + 1)
    if (e.kind === 'card') cards.set(e.to, (cards.get(e.to) || 0) + e.count)
  }
  const cap = new Map<string, string>()
  for (const n of lineage.nodes.values()) {
    if (n.missing) cap.set(n.id, `${KIND_LABEL[n.kind]}已删除`)
    else if (n.kind === 'query') cap.set(n.id, outs.get(n.id) ? `${outs.get(n.id)} 个图表使用` : '查询 · 未被使用')
    else if (n.kind === 'chart') cap.set(n.id, `${n.sub || '图表'}${outs.get(n.id) ? ` · ${outs.get(n.id)} 个看板` : ''}`)
    else if (n.kind === 'dashboard') cap.set(n.id, `看板 · ${cards.get(n.id) || 0} 张卡片`)
    else cap.set(n.id, n.id === HOME_ID ? `首页 · ${n.sub || ''}` : 'Agent')
  }
  return cap
}

interface Props extends Omit<LineageInput, 'queries' | 'charts' | 'dashboards'> {
  queries: BiQueryAdmin[]
  charts: BiChartAdmin[]
  dashboards: BiDashboardAdmin[]
  onOpen: (kind: 'query' | 'chart' | 'dashboard', key: string) => void
}

function Legend() {
  const dot = (k: LineageKind, label: string) => (
    <span className="flex items-center gap-1">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color(TONE[k].token) }} />
      {label}
    </span>
  )
  const line = (token: string, dash?: string) => (
    <svg width="20" height="8" className="shrink-0" aria-hidden>
      <line x1="1" y1="4" x2="19" y2="4" style={{ stroke: color(token) }} strokeWidth="2" strokeDasharray={dash} />
    </svg>
  )
  return (
    <div className="flex items-center gap-3 text-xs text-muted flex-wrap">
      {dot('query', '查询')}
      {dot('chart', '图表')}
      {dot('dashboard', '看板')}
      {dot('consumer', '使用方')}
      <span className="w-px h-3 bg-line" />
      <span className="flex items-center gap-1">{line('line-strong')}引用</span>
      <span className="flex items-center gap-1">{line('line-strong', '5 3')}下钻</span>
      <span className="flex items-center gap-1">{line('danger', '5 3')}断了</span>
    </div>
  )
}

function LineageCanvas({ onOpen, ...input }: Props) {
  const { queries, charts, dashboards, agentLabels, formatRoles, typeLabel } = input
  const lineage = useMemo(
    () =>
      buildLineage({
        queries,
        charts,
        dashboards,
        agentLabels,
        formatRoles,
        typeLabel,
      }),
    [queries, charts, dashboards, agentLabels, formatRoles, typeLabel],
  )
  const chartTypes = useMemo(() => new Map(charts.map((c) => [c.chartKey, c.type])), [charts])
  const thumbOf = useMemo(() => {
    const m = new Map<string, Thumb>()
    const chartMap = new Map(charts.map((c) => [c.chartKey, c]))
    for (const q of queries) m.set(`q:${q.queryKey}`, queryThumb(q))
    for (const c of charts) m.set(`c:${c.chartKey}`, chartThumb(c))
    for (const d of dashboards) m.set(`d:${d.dashboardKey}`, dashboardThumb(d, chartMap))
    return m
  }, [queries, charts, dashboards])
  const [thumbs, setThumbs] = useState(() => {
    try {
      return localStorage.getItem(THUMBS_PREF) !== '0'
    } catch {
      return true
    }
  })
  const toggleThumbs = () =>
    setThumbs((v) => {
      try {
        localStorage.setItem(THUMBS_PREF, v ? '0' : '1')
      } catch {
        /* 无痕模式等：只在本次生效 */
      }
      return !v
    })
  const nodeH = thumbs ? NODE_H_THUMB : NODE_H
  const caps = useMemo(() => captions(lineage), [lineage])
  const stats = useMemo(() => lineageStats(lineage), [lineage])
  const [keyword, setKeyword] = useState('')
  const [onlyIssues, setOnlyIssues] = useState(false)
  const [locked, setLocked] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focusOnly, setFocusOnly] = useState(false)

  const lockedNode = locked ? lineage.nodes.get(locked) : undefined
  const active = hovered ?? (lockedNode ? locked : null)
  const related = useMemo(() => (active ? relatedIds(lineage, active) : null), [lineage, active])
  const lockedRelated = useMemo(() => (lockedNode ? relatedIds(lineage, lockedNode.id) : null), [lineage, lockedNode])
  const visible = useMemo(() => {
    const v = visibleIds(lineage, {
      keyword,
      onlyIssues,
      focus: focusOnly && lockedNode ? lockedNode.id : null,
    })
    if (v && locked) v.add(locked)
    return v
  }, [lineage, keyword, onlyIssues, focusOnly, lockedNode, locked])
  const visibleKey = visible ? [...visible].sort().join('|') : '*'

  const clearLock = useCallback(() => {
    setLocked(null)
    setFocusOnly(false)
  }, [])
  useEffect(() => {
    if (!locked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearLock()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, clearLock])

  // ---- 排版：可见集合变化时 elk 重新排，节点平滑移动后 fitView ----
  const [nodes, setNodes, onNodesChange] = useNodesState<LineageFlowNode>([])
  const [relayout, setRelayout] = useState(false)
  const { setViewport } = useReactFlow()
  const boxRef = useRef<HTMLDivElement>(null)
  const firstLayout = useRef(true)
  /** 放得下就整体居中；放不下时缩放不低于可读的 0.7，横向居中、从顶部开始看 */
  const frame = useCallback(
    (ns: LineageFlowNode[], duration: number) => {
      const box = boxRef.current
      if (!box || ns.length === 0) return
      const b = getNodesBounds(ns.map((n) => ({ ...n, width: NODE_W, height: nodeH })))
      const W = box.clientWidth
      const H = box.clientHeight
      const pad = 32
      const zoom = Math.min(1.05, Math.max(0.7, Math.min((W - pad * 2) / b.width, (H - pad * 2) / b.height)))
      const x = (W - b.width * zoom) / 2 - b.x * zoom
      const y = b.height * zoom <= H - pad * 2 ? (H - b.height * zoom) / 2 - b.y * zoom : pad - b.y * zoom
      void setViewport({ x, y, zoom }, { duration })
    },
    [setViewport, nodeH],
  )
  useEffect(() => {
    let alive = true
    const shown = visibleKey === '*' ? null : new Set(visibleKey.split('|').filter(Boolean))
    layoutLineage(lineage, shown, { height: nodeH }).then((pos) => {
      if (!alive) return
      const animate = !firstLayout.current
      firstLayout.current = false
      setRelayout(animate)
      const next: LineageFlowNode[] = [...pos].map(([id, p]) => ({
        id,
        type: 'lineage',
        position: p,
        data: {
          node: {
            ...lineage.nodes.get(id)!,
            chartType: chartTypes.get(lineage.nodes.get(id)!.key),
          },
          caption: caps.get(id) || '',
          thumb: thumbOf.get(id),
        },
      }))
      setNodes(next)
      requestAnimationFrame(() => frame(next, animate ? 420 : 0))
      if (animate) setTimeout(() => alive && setRelayout(false), 460)
    })
    return () => {
      alive = false
    }
  }, [lineage, visibleKey, caps, chartTypes, thumbOf, nodeH, setNodes, frame])

  const edges = useMemo<LineageFlowEdge[]>(() => {
    const shown = new Set(nodes.map((n) => n.id))
    return lineage.edges
      .filter((e) => shown.has(e.from) && shown.has(e.to))
      .map((e) => ({
        id: `${e.from}>${e.to}>${e.kind}`,
        source: e.from,
        target: e.to,
        type: 'flow',
        data: { kind: e.kind, broken: e.broken, count: e.count },
        focusable: false,
        selectable: false,
      }))
  }, [lineage, nodes])

  const highlight = useMemo(() => ({ related, locked, thumbs }), [related, locked, thumbs])

  // ---- 全屏：优先浏览器全屏（Esc 由浏览器退出），不支持时铺满窗口 ----
  const rootRef = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  const toggleFull = () => {
    if (full) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      setFull(false)
      return
    }
    setFull(true)
    const el = rootRef.current
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {})
  }
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  useEffect(() => {
    if (!full) return
    // 铺满窗口模式下 Esc 退出（有锁定时先取消锁定）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement && !locked) setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full, locked])
  // 画布尺寸变了，重新取景
  useEffect(() => {
    const t = setTimeout(() => frame(nodesRef.current, 300), 150)
    return () => clearTimeout(t)
  }, [full, frame])

  if (lineage.nodes.size === 0) {
    return (
      <Card>
        <EmptyState title="还没有可显示的关系" description="先在「查询库」登记查询、做图表、建看板，这里会自动画出它们之间的引用关系" />
      </Card>
    )
  }

  const summary = (() => {
    if (!lockedNode || !lockedRelated) return null
    const count = (k: LineageKind) => [...lockedRelated].filter((id) => id !== lockedNode.id && lineage.nodes.get(id)?.kind === k).length
    const parts = (['query', 'chart', 'dashboard', 'consumer'] as LineageKind[])
      .filter((k) => k !== lockedNode.kind)
      .map((k) => (count(k) ? `${count(k)} 个${KIND_LABEL[k]}` : ''))
      .filter(Boolean)
    return parts.length ? `关联 ${parts.join('、')}` : '没有关联的对象'
  })()
  const canOpen = (n: LineageNode) => n.kind !== 'consumer' && !n.missing

  return (
    <div ref={rootRef} className={cn(full ? 'fixed inset-0 z-50 bg-bg p-4 flex flex-col gap-3' : 'space-y-3')}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[14rem] max-w-sm">
          <Search className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input className="pl-8" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索名称 / 标识，连带显示上下游" aria-label="搜索" />
        </div>
        <Segmented
          size="sm"
          className="!w-auto"
          value={onlyIssues ? 'issues' : 'all'}
          onChange={(v) => setOnlyIssues(v === 'issues')}
          options={[
            { value: 'all', label: <span className="px-2">全部</span> },
            {
              value: 'issues',
              label: <span className="px-2">只看有问题的（{stats.danger + stats.warning}）</span>,
            },
          ]}
        />
        {stats.danger > 0 && <span className="text-xs text-danger">{stats.danger} 处引用断了</span>}
        <div className="ml-auto flex items-center gap-3">
          <Legend />
          <Button size="sm" variant={thumbs ? 'soft' : 'ghost'} icon={<ImageIcon className="w-3.5 h-3.5" />} onClick={toggleThumbs} aria-pressed={thumbs}>
            缩略图
          </Button>
          <Button size="sm" variant="ghost" icon={full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />} onClick={toggleFull}>
            {full ? '退出全屏' : '全屏'}
          </Button>
        </div>
      </div>

      <div className="min-h-[2.25rem] flex items-center gap-2 flex-wrap rounded-lg px-3 py-1.5 bg-surface-2 text-sm">
        {lockedNode ? (
          <>
            <span className="text-muted">{KIND_LABEL[lockedNode.kind]}</span>
            <span className="font-medium text-fg">{lockedNode.label}</span>
            <span className="text-muted">· {summary}</span>
            {lockedNode.issues.length > 0 && <span className="text-xs text-warning">（{lockedNode.issues.map((i) => i.text).join('；')}）</span>}
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant={focusOnly ? 'soft' : 'ghost'} onClick={() => setFocusOnly((v) => !v)}>
                {focusOnly ? '显示全部' : '只看这条链'}
              </Button>
              {canOpen(lockedNode) && (
                <Button size="sm" variant="ghost" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => onOpen(lockedNode.kind as 'query' | 'chart' | 'dashboard', lockedNode.key)}>
                  打开编辑
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<X className="w-3.5 h-3.5" />} onClick={clearLock}>
                取消选择
              </Button>
            </div>
          </>
        ) : (
          <span className="text-muted text-xs">鼠标移到任一项上预览它的上下游；点击锁定，双击打开编辑，Esc 取消；滚轮缩放，拖动空白处平移，节点可拖动</span>
        )}
      </div>

      <div ref={boxRef} className={cn('lineage-flow rounded-xl border border-line bg-surface overflow-hidden', full ? 'flex-1 min-h-0' : 'h-[calc(100vh-20rem)] min-h-[32rem]', relayout && 'is-relayout')}>
        <HighlightCtx.Provider value={highlight}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeMouseEnter={(_, n) => setHovered(n.id)}
            onNodeMouseLeave={(_, n) => setHovered((h) => (h === n.id ? null : h))}
            onNodeClick={(_, n) => (locked === n.id ? clearLock() : setLocked(n.id))}
            onNodeDoubleClick={(_, n) => {
              const ln = lineage.nodes.get(n.id)
              if (ln && canOpen(ln)) onOpen(ln.kind as 'query' | 'chart' | 'dashboard', ln.key)
            }}
            onPaneClick={clearLock}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            minZoom={0.15}
            maxZoom={1.6}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              pannable
              style={{ width: 150, height: 96 }}
              zoomable
              position="bottom-right"
              nodeBorderRadius={6}
              nodeColor={(n) => {
                const ln = lineage.nodes.get(n.id)
                if (!ln) return color('line-strong')
                if (ln.missing) return color('danger')
                return color(TONE[ln.kind].token, related && !related.has(n.id) ? 0.25 : 0.85)
              }}
            />
          </ReactFlow>
        </HighlightCtx.Provider>
      </div>
    </div>
  )
}

export default function LineageGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <LineageCanvas {...props} />
    </ReactFlowProvider>
  )
}
