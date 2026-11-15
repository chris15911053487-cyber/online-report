/**
 * BI 关系图：查询库 → 图表 → 看板 → 使用方，四列 + 贝塞尔连线。
 *
 * 悬停预览某个对象的上下游，点击锁定（其余变淡），「只看这条链」隐藏无关节点；
 * 搜索 / 只看问题时连带显示命中项的上下游。双击或「打开编辑」进入对应编辑器。
 * 关系计算在 utils/biLineage.ts；连线按节点实际位置画（ResizeObserver 重算）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Bot, Database, Home, LayoutDashboard, Pencil, Search, X } from 'lucide-react'
import { Button, Card, EmptyState, Input, Segmented } from '../../../ui'
import { cn } from '../../../ui/classes'
import { HOME_ID, buildLineage, lineageStats, relatedIds, visibleIds, type LineageInput, type LineageKind, type LineageNode } from '../../../utils/biLineage'

const COLUMNS: { kind: LineageKind; title: string; icon: typeof Database; empty: string }[] = [
  { kind: 'query', title: '① 查询库', icon: Database, empty: '暂无查询' },
  { kind: 'chart', title: '② 图表', icon: BarChart3, empty: '暂无图表' },
  { kind: 'dashboard', title: '③ 看板', icon: LayoutDashboard, empty: '暂无看板' },
  { kind: 'consumer', title: '使用方', icon: Bot, empty: '还没有看板关联 Agent 或首页' },
]
const KIND_LABEL: Record<LineageKind, string> = { query: '查询', chart: '图表', dashboard: '看板', consumer: '使用方' }

type Pos = { l: number; r: number; y: number }

interface Props extends LineageInput {
  onOpen: (kind: 'query' | 'chart' | 'dashboard', key: string) => void
}

function NodeCard({ node, selected, dim, onEnter, onLeave, onClick, onOpen, refFn }: { node: LineageNode; selected: boolean; dim: boolean; onEnter: () => void; onLeave: () => void; onClick: () => void; onOpen?: () => void; refFn: (el: HTMLElement | null) => void }) {
  const danger = node.issues.some((i) => i.tone === 'danger')
  const issue = node.issues[0]
  const Icon = node.id === HOME_ID ? Home : node.kind === 'consumer' ? Bot : null
  return (
    <div
      ref={refFn}
      role="button"
      tabIndex={0}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpen?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'group relative z-10 rounded-lg border bg-surface px-3 py-2 text-left cursor-pointer select-none',
        'transition-[opacity,border-color,box-shadow,background-color] duration-200 ease-out',
        node.missing ? 'border-dashed border-danger' : danger ? 'border-danger/60' : 'border-line hover:border-primary/60',
        selected && 'border-primary ring-2 ring-primary/30 bg-primary-soft',
        dim && 'opacity-25',
        !node.enabled && !node.missing && 'bg-surface-2',
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {Icon && <Icon className="w-3.5 h-3.5 text-muted shrink-0" />}
        <span className={cn('text-[13px] font-medium truncate', node.missing ? 'text-danger' : node.enabled ? 'text-fg' : 'text-muted')} title={node.label}>
          {node.label}
        </span>
        {node.sub && node.kind === 'chart' && <span className="ml-auto shrink-0 text-[11px] text-muted">{node.sub}</span>}
        {onOpen && (
          <button
            type="button"
            aria-label="打开编辑"
            title="打开编辑"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            className={cn('shrink-0 rounded p-0.5 text-muted hover:text-primary transition-opacity', node.sub && node.kind === 'chart' ? '' : 'ml-auto', selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[11px]">
        {node.key && !node.missing && <span className="font-mono text-subtle truncate">{node.key}</span>}
        {node.kind === 'consumer' && node.sub && node.id === HOME_ID && <span className="text-muted truncate">{node.sub}</span>}
        {issue && (
          <span className={cn('ml-auto shrink-0 flex items-center gap-1', issue.tone === 'danger' ? 'text-danger' : 'text-warning')} title={node.issues.map((i) => i.text).join('；')}>
            <span className={cn('w-1.5 h-1.5 rounded-full', issue.tone === 'danger' ? 'bg-danger' : 'bg-warning')} />
            {issue.text}
            {node.issues.length > 1 && ` +${node.issues.length - 1}`}
          </span>
        )}
      </div>
    </div>
  )
}

function Legend() {
  const line = (cls: string, dash?: string) => (
    <svg width="22" height="8" className="shrink-0" aria-hidden>
      <line x1="1" y1="4" x2="21" y2="4" className={cls} strokeWidth="2" strokeDasharray={dash} />
    </svg>
  )
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="flex items-center gap-1">{line('stroke-line-strong')}引用</span>
      <span className="flex items-center gap-1">{line('stroke-line-strong', '4 3')}下钻</span>
      <span className="flex items-center gap-1">{line('stroke-danger')}引用断了</span>
    </div>
  )
}

export default function LineageGraph({ onOpen, ...input }: Props) {
  const { queries, charts, dashboards, agentLabels, formatRoles, typeLabel } = input
  const lineage = useMemo(
    () => buildLineage({ queries, charts, dashboards, agentLabels, formatRoles, typeLabel }),
    [queries, charts, dashboards, agentLabels, formatRoles, typeLabel],
  )
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
  const visible = useMemo(() => visibleIds(lineage, { keyword, onlyIssues, focus: focusOnly && lockedNode ? lockedNode.id : null }), [lineage, keyword, onlyIssues, focusOnly, lockedNode])
  const isVisible = useCallback((id: string) => !visible || visible.has(id) || id === locked, [visible, locked])

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

  // ---- 连线位置：按节点实际位置量，容器尺寸变化时重算 ----
  const boxRef = useRef<HTMLDivElement>(null)
  const nodeEls = useRef(new Map<string, HTMLElement>())
  const [layout, setLayout] = useState<{ w: number; h: number; pos: Map<string, Pos> }>({ w: 0, h: 0, pos: new Map() })
  const measure = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    const b = box.getBoundingClientRect()
    const pos = new Map<string, Pos>()
    for (const [id, el] of nodeEls.current) {
      const r = el.getBoundingClientRect()
      pos.set(id, { l: r.left - b.left, r: r.right - b.left, y: r.top - b.top + r.height / 2 })
    }
    setLayout((prev) => {
      if (prev.w === b.width && prev.h === b.height && prev.pos.size === pos.size) {
        let same = true
        for (const [id, p] of pos) {
          const o = prev.pos.get(id)
          if (!o || o.l !== p.l || o.r !== p.r || o.y !== p.y) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return { w: b.width, h: b.height, pos }
    })
  }, [])
  useLayoutEffect(measure, [measure, lineage, visible, locked])
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(box)
    return () => ro.disconnect()
  }, [measure])
  const refFor = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) nodeEls.current.set(id, el)
      else nodeEls.current.delete(id)
    },
    [],
  )

  const total = lineage.nodes.size
  if (total === 0) {
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
    <div className="space-y-3">
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
            { value: 'issues', label: <span className="px-2">只看有问题的（{stats.danger + stats.warning}）</span> },
          ]}
        />
        {stats.danger > 0 && <span className="text-xs text-danger">{stats.danger} 处引用断了</span>}
        <div className="ml-auto">
          <Legend />
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
          <span className="text-muted text-xs">鼠标移到任一项上预览它的上下游；点击锁定，双击打开编辑，Esc 取消</span>
        )}
      </div>

      <Card className="overflow-x-auto">
        <div ref={boxRef} className="relative min-w-[56rem] p-4" onClick={clearLock}>
          <svg className="absolute inset-0 pointer-events-none" width={layout.w} height={layout.h} aria-hidden>
            {lineage.edges.map((e) => {
              const a = layout.pos.get(e.from)
              const b = layout.pos.get(e.to)
              if (!a || !b || !isVisible(e.from) || !isVisible(e.to)) return null
              const on = !!related && related.has(e.from) && related.has(e.to)
              const x1 = a.r
              const x2 = b.l
              const dx = Math.max(24, (x2 - x1) / 2)
              return (
                <path
                  key={`${e.from}>${e.to}>${e.kind}`}
                  d={`M${x1},${a.y} C${x1 + dx},${a.y} ${x2 - dx},${b.y} ${x2},${b.y}`}
                  className={cn('fill-none transition-[stroke-opacity,stroke-width] duration-200 ease-out', e.broken ? 'stroke-danger' : on ? 'stroke-primary' : 'stroke-line-strong')}
                  strokeWidth={on ? 2.25 : 1.25}
                  strokeOpacity={related ? (on ? 1 : 0.12) : e.broken ? 0.9 : 0.6}
                  strokeDasharray={e.kind === 'drill' ? '5 4' : undefined}
                  strokeLinecap="round"
                />
              )
            })}
          </svg>
          <div className="relative grid grid-cols-4 gap-x-14">
            {COLUMNS.map((col) => {
              const nodes = lineage.columns[col.kind].filter((n) => isVisible(n.id))
              const Icon = col.icon
              return (
                <div key={col.kind} className="min-w-0">
                  <div className="flex items-center gap-1.5 mb-3 text-xs font-semibold text-muted">
                    <Icon className="w-3.5 h-3.5" />
                    {col.title}
                    <span className="num font-normal text-subtle">{nodes.length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {nodes.length === 0 && <div className="text-xs text-subtle py-2">{visible ? '—' : col.empty}</div>}
                    {nodes.map((n) => (
                      <NodeCard
                        key={n.id}
                        node={n}
                        refFn={refFor(n.id)}
                        selected={n.id === locked}
                        dim={!!related && !related.has(n.id)}
                        onEnter={() => setHovered(n.id)}
                        onLeave={() => setHovered((h) => (h === n.id ? null : h))}
                        onClick={() => {
                          if (locked === n.id) clearLock()
                          else setLocked(n.id)
                        }}
                        onOpen={canOpen(n) ? () => onOpen(n.kind as 'query' | 'chart' | 'dashboard', n.key) : undefined}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </Card>
    </div>
  )
}
