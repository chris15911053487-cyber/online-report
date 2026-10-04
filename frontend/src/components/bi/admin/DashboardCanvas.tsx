/**
 * 看板画布（管理端）：按 12 栅格真实排版并显示真实数据，直接在上面调整布局。
 *
 * - 拖 ⠿ 把手换位置（拖到另一张卡片的左半 / 右半，插到它前 / 后）
 * - 拖右边缘改宽度（对齐到 12 栅格；KPI ≥ 2 格，图表 / 表格 ≥ 4 格）；拖下边缘改高度（4 档，KPI 固定矮）
 * - 点卡片选中，右侧面板编辑标题、参数来源等
 * 布局规则与运行时 DashboardView 一致（顺序 + 宽高，自动换行），所见即所得。
 */
import { useRef, useState } from 'react'
import { AlertTriangle, GripVertical, Trash2 } from 'lucide-react'
import { BI_CARD_HEIGHT, initialFilterValues, type BiCard, type BiCardRef, type BiFilter, type BiFilterValues, type BiQueryMeta, type BiScalar } from '../../../utils/bi'
import { cn } from '../../../ui/classes'
import { IconButton } from '../../../ui'
import BiCardView from '../BiCardView'
import { FilterBar } from '../DashboardPanel'

const GAP = 12 // gap-3
// 最小宽度：KPI 2 格；图表 / 表格 4 格（再窄坐标轴就挤成一团）
const minWidth = (type?: string) => (type === 'kpi' ? 2 : 4)
const ROW_STEP = 100 // 下边缘每拖这么多像素变一档高度

type Drop = { index: number; side: 'before' | 'after' } | null

export default function DashboardCanvas({
  refs,
  cards,
  problems,
  filters,
  queries,
  selected,
  onSelect,
  onMove,
  onResize,
  onRemove,
}: {
  refs: BiCardRef[]
  /** 展开后的卡片（与 refs 一一对应；图表缺失时为 null） */
  cards: (BiCard | null)[]
  problems: string[][]
  filters: BiFilter[]
  queries: Record<string, BiQueryMeta>
  selected: number
  onSelect: (i: number) => void
  /** 把 from 移到 to（to 为移除 from 之前的插入位置） */
  onMove: (from: number, to: number) => void
  onResize: (i: number, layout: { w: number; h: number }) => void
  onRemove: (i: number) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState<BiFilterValues>(() => initialFilterValues(filters))
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [drop, setDrop] = useState<Drop>(null)
  const [resizing, setResizing] = useState<number | null>(null)

  const sizeOf = (i: number) => refs[i].layout || cards[i]?.layout || { w: 6, h: 2 }

  /** 右 / 下边缘拖拽改尺寸（指针事件，松开即结束） */
  const startResize = (e: React.PointerEvent, i: number, axis: 'w' | 'h') => {
    e.preventDefault()
    e.stopPropagation()
    const grid = gridRef.current
    const cell = (e.currentTarget as HTMLElement).closest('[data-card]') as HTMLElement | null
    if (!grid || !cell) return
    const colW = (grid.clientWidth - GAP * 11) / 12
    const left = cell.getBoundingClientRect().left
    const startY = e.clientY
    const start = sizeOf(i)
    const isKpi = cards[i]?.type === 'kpi'
    // 拖动过程中 props 更新不会进到这个闭包，用局部变量记当前尺寸
    let cur = { ...start }
    setResizing(i)
    onSelect(i)
    const move = (ev: PointerEvent) => {
      const next =
        axis === 'w'
          ? { ...cur, w: Math.max(minWidth(cards[i]?.type), Math.min(12, Math.round((ev.clientX - left + GAP) / (colW + GAP)))) }
          : isKpi
            ? cur
            : { ...cur, h: Math.max(1, Math.min(4, start.h + Math.round((ev.clientY - startY) / ROW_STEP))) }
      if (next.w !== cur.w || next.h !== cur.h) {
        cur = next
        onResize(i, next)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setResizing(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const finishDrop = () => {
    if (dragFrom != null && drop) {
      const to = drop.side === 'before' ? drop.index : drop.index + 1
      if (to !== dragFrom && to !== dragFrom + 1) onMove(dragFrom, to)
    }
    setDragFrom(null)
    setDrop(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <FilterBar filters={filters} values={values} onChange={(name: string, v: BiScalar) => setValues((cur) => ({ ...cur, [name]: v }))} />
      <div ref={gridRef} className="grid gap-3" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
        {refs.map((ref, i) => {
          const card = cards[i]
          const size = sizeOf(i)
          const bad = problems[i].length > 0
          const isSel = i === selected
          const indicator = drop && drop.index === i && dragFrom !== i ? drop.side : null
          return (
            <div
              key={ref.id + i}
              data-card
              style={{ gridColumn: `span ${size.w} / span ${size.w}`, alignSelf: card?.type === 'kpi' ? 'start' : undefined }}
              className={cn('relative min-w-0 flex group', dragFrom === i && 'opacity-40')}
              onClick={() => onSelect(i)}
              onDragOver={(e) => {
                if (dragFrom == null) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
                if (!drop || drop.index !== i || drop.side !== side) setDrop({ index: i, side })
              }}
              onDrop={(e) => {
                e.preventDefault()
                finishDrop()
              }}
            >
              {indicator && <span className={cn('absolute top-0 bottom-0 w-1 rounded-full bg-primary z-20', indicator === 'before' ? '-left-2' : '-right-2')} />}
              <div className={cn('flex-1 min-w-0 flex flex-col rounded-2xl outline-2 outline-offset-2 transition-[outline-color]', isSel ? 'outline outline-primary' : 'outline outline-transparent hover:outline-line-strong')}>
                {/* 工具条：拖动把手 / 尺寸 / 移除 */}
                <div className={cn('absolute -top-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none', isSel || resizing === i ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(i))
                      // 推迟到下一帧再改样式：dragstart 里同步改 DOM 会让 Chrome 直接取消拖动
                      requestAnimationFrame(() => setDragFrom(i))
                    }}
                    onDragEnd={() => {
                      setDragFrom(null)
                      setDrop(null)
                    }}
                    className="pointer-events-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface border border-line shadow-sm text-[11px] text-muted cursor-grab active:cursor-grabbing"
                    title="拖动换位置"
                  >
                    <GripVertical className="w-3.5 h-3.5" />
                    {size.w}/12{card?.type !== 'kpi' ? ` · 高 ${size.h}` : ''}
                  </span>
                  <span className="pointer-events-auto rounded-md bg-surface border border-line shadow-sm">
                    <IconButton
                      label="从看板移除"
                      className="hover:text-danger p-1"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(i)
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
                  </span>
                </div>

                {/* 内容：真实卡片（不响应点击，点击只用于选中）；未完成的显示占位 */}
                {card && !bad ? (
                  <div className={cn('flex-1 min-w-0 flex flex-col pointer-events-none select-none', card.type === 'kpi' ? '' : '[&>section]:flex-1')}>
                    <BiCardView card={{ ...card, layout: size }} filters={values} queries={queries} />
                  </div>
                ) : (
                  <div
                    className="rounded-2xl border border-dashed border-warning/60 bg-warning-soft/40 p-4 flex flex-col gap-1"
                    style={{ minHeight: card?.type === 'kpi' ? 96 : BI_CARD_HEIGHT[size.h] + 48 }}
                  >
                    <span className="text-[13px] font-semibold text-fg truncate">{ref.title || card?.title || ref.chartKey || '（未选图表）'}</span>
                    <span className="text-[12px] text-warning flex items-start gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      {problems[i][0] || '配置未完成'}
                    </span>
                  </div>
                )}
              </div>

              {/* 右边缘：改宽度 */}
              <span
                role="separator"
                aria-label="拖动调整宽度"
                onPointerDown={(e) => startResize(e, i, 'w')}
                className={cn('absolute top-4 bottom-4 -right-2 w-3 z-10 cursor-ew-resize flex items-center justify-center', isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
              >
                <span className="w-1 h-10 rounded-full bg-primary/70" />
              </span>
              {/* 下边缘：改高度（KPI 固定） */}
              {card?.type !== 'kpi' && (
                <span
                  role="separator"
                  aria-label="拖动调整高度"
                  onPointerDown={(e) => startResize(e, i, 'h')}
                  className={cn('absolute left-6 right-6 -bottom-2 h-3 z-10 cursor-ns-resize flex items-center justify-center', isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                >
                  <span className="h-1 w-10 rounded-full bg-primary/70" />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
