import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '../ui'
import { cn } from '../ui/classes'
import { buildImageSrc, isImageColumn, reportColumnHeaderText } from '../utils/helpers'
import { formatCardValue, resolveCard, type ReportCardConfig } from '../utils/reportCard'

/**
 * 报表结果的手机卡片列表（菜单配了 mobileCard 时代替表格）。
 * 选择模式（合并报工）：点卡片勾选，「详情」进订单详情；否则点卡片进行详情（若有）。
 */
export default function ReportCardList({
  rows,
  config,
  columnLabels,
  selectable,
  selected,
  onToggle,
  onOpen,
  canOpen,
  onImageClick,
}: {
  rows: Record<string, unknown>[]
  config: ReportCardConfig
  columnLabels: Record<string, string>
  selectable: boolean
  selected: Set<number>
  onToggle: (idx: number) => void
  /** 行详情；不传则卡片上没有详情入口 */
  onOpen?: (row: Record<string, unknown>) => void
  /** 该行能否打开详情（如没有单号的行不显示「详情」）；默认都能 */
  canOpen?: (row: Record<string, unknown>) => boolean
  onImageClick: (src: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const maxRest = config.maxRest ?? 4
  const label = (col: string) => reportColumnHeaderText(col, columnLabels)

  return (
    <div className="flex flex-col gap-2.5 px-4 pb-3">
      {rows.map((row, idx) => {
        const c = resolveCard(row, config)
        const isSel = selected.has(idx)
        const open = expanded.has(idx)
        const rest = open ? c.rest : c.rest.slice(0, maxRest)
        const openable = !!onOpen && (canOpen ? canOpen(row) : true)
        const clickable = selectable || openable
        const metricText = c.metric ? formatCardValue(c.metric.value, true) : ''
        const pct = c.progress ? Math.max(0, Math.min(100, (c.progress.done / c.progress.total) * 100)) : 0

        return (
          <article
            key={idx}
            className={cn(
              'flex flex-col gap-1.5 rounded-xl border bg-surface px-3 pt-3 pb-2.5',
              isSel ? 'border-primary ring-1 ring-primary' : 'border-line',
              clickable && 'cursor-pointer active:bg-surface-2',
            )}
            onClick={() => {
              if (selectable) onToggle(idx)
              else if (openable) onOpen?.(row)
            }}
          >
            <div className="flex items-center gap-2">
              {selectable && (
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => onToggle(idx)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="选择"
                  className="h-[18px] w-[18px] shrink-0 accent-primary"
                />
              )}
              <div className="num min-w-0 flex-1 break-all text-base font-bold text-fg">
                {c.title ? (
                  <>
                    {/* 列标题映射里给标题列起了中文名（如 DocEntry → 单号）才显示前缀 */}
                    {label(c.title.col) !== c.title.col ? (
                      <span className="mr-1 text-xs font-normal text-muted">{label(c.title.col)}</span>
                    ) : null}
                    {formatCardValue(c.title.value) || String(c.title.value)}
                  </>
                ) : (
                  '—'
                )}
              </div>
              {c.badge && <Badge tone={c.badge.tone}>{String(c.badge.value)}</Badge>}
            </div>

            <div className="flex items-end gap-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {c.subtitle && (
                  <div className="line-clamp-2 text-sm text-fg">
                    {String(c.subtitle.value)}
                    {c.subNote && <span className="ml-1.5 whitespace-nowrap text-xs text-subtle">{String(c.subNote.value)}</span>}
                  </div>
                )}
                {c.meta.length > 0 && (
                  <div className="num break-all text-xs text-muted">
                    {c.meta.map((m) => formatCardValue(m.value)).join(' · ')}
                  </div>
                )}
              </div>
              {c.metric && (
                <div className="shrink-0 text-right">
                  <div className="num text-2xl font-bold leading-tight text-fg">{metricText || '—'}</div>
                  <div className="text-[11px] text-muted">{label(c.metric.col)}</div>
                </div>
              )}
            </div>

            {c.progress && (
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>{label(c.progress.doneCol)}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full bg-success" style={{ width: `${pct}%` }} />
                </div>
                <span className="num">
                  {formatCardValue(c.progress.done, true) || '0'} / {formatCardValue(c.progress.total, true)}
                </span>
              </div>
            )}

            {(c.rest.length > 0 || (selectable && openable)) && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-dashed border-line pt-1.5 text-xs">
                {rest.map((f) => (
                  <div key={f.col} className="flex min-w-0 gap-1.5">
                    <dt className="shrink-0 text-muted">{label(f.col)}</dt>
                    <dd className="num min-w-0 break-all text-fg-2">
                      {isImageColumn(f.col) ? (
                        <button
                          type="button"
                          className="text-primary"
                          onClick={(e) => {
                            e.stopPropagation()
                            onImageClick(buildImageSrc(String(f.value)))
                          }}
                        >
                          查看图片
                        </button>
                      ) : (
                        formatCardValue(f.value)
                      )}
                    </dd>
                  </div>
                ))}
                <div className="col-span-2 flex justify-end gap-4">
                  {c.rest.length > maxRest && (
                    <button
                      type="button"
                      className="py-0.5 text-primary"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(idx)) next.delete(idx)
                          else next.add(idx)
                          return next
                        })
                      }}
                    >
                      {open ? '收起' : `展开全部（${c.rest.length}）`}
                    </button>
                  )}
                  {selectable && openable && (
                    <button
                      type="button"
                      className="inline-flex items-center py-0.5 text-primary"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpen(row)
                      }}
                    >
                      详情
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </dl>
            )}
          </article>
        )
      })}
    </div>
  )
}
