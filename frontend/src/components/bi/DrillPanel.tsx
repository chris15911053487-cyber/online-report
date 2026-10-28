/**
 * 下钻明细面板：看板上点「下钻」进入配成「明细面板」的一级时打开，原卡片保持不动。
 *
 * 三种外壳，内容相同：
 *   - drawer：PC 右侧抽屉，不加遮罩（看板照常可点，点另一项直接换内容）；左边缘可拖动调宽；
 *             split = 和看板并排（看板让出宽度），否则叠在看板右侧
 *   - sheet：手机底部弹出的全屏面板
 *   - page：新标签页里只看明细的页面（views/BiDrillView）
 *
 * 面板里可以继续下钻（不论下一级配的是哪种方式），「返回」退到面板第一级为止。
 * 关闭 / 浏览器返回键由上层处理（DashboardView 用 router 的 openHistoryOverlay 占一条历史）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Columns2, Copy, Download, ExternalLink, Loader2, PanelRight, RotateCw, Sparkles, X } from 'lucide-react'
import { useStore } from '../../store'
import { apiUrl, authHeaders } from '../../utils/api'
import { fillPlaceholders, withColumnSemantics, type BiColumnDef, type BiFilter, type BiFilterValues, type BiQueryMeta } from '../../utils/bi'
import { buildChartModel, columnLabel, type BiRow } from '../../utils/biOption'
import { canDrillFrom, levelView, nextDrillLabel, popDrillTo, pushDrill, type DrillFrame, type DrillPanelState } from '../../utils/biDrill'
import type { BiPick } from '../../utils/biContext'
import { toTsv } from '../../utils/biTable'
import BiChart from './BiChart'
import DetailTable from './DetailTable'
import { useBiQuery } from './useBiQuery'

export type DrillPanelVariant = 'drawer' | 'sheet' | 'page'

/** 抽屉宽度范围（px）：至少 360，并给看板至少留 320 */
export const DRAWER_MIN_W = 360
const BOARD_MIN_W = 320

interface Props {
  panel: DrillPanelState
  onChange: (p: DrillPanelState) => void
  /** 不传 = 不能关闭（page） */
  onClose?: () => void
  filters: BiFilterValues
  filterDefs: BiFilter[]
  /** 筛选当前值的显示文字（filterDisplayText） */
  filterText: Record<string, string>
  queries: Record<string, BiQueryMeta>
  variant: DrillPanelVariant
  /** drawer：与看板并排 */
  split?: boolean
  onToggleSplit?: () => void
  /** drawer：没有宿主容器时固定到视口右侧 */
  fixed?: boolean
  width?: number
  onResize?: (w: number) => void
  /** 点中明细行 / 「问 AI」：交给上层显示点击浮层；不传（page）时点行直接下钻 */
  onPick?: (pick: BiPick) => void
  /** 在新标签页打开（stack 为要打开的完整路径） */
  onOpenTab?: (stack: DrillFrame[]) => void
}

async function exportExcel(queryKey: string, title: string, columns: BiColumnDef[], rows: BiRow[], label: (c: BiColumnDef) => string) {
  const res = await fetch(apiUrl('/bi/export'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ queryKey, title, columns: columns.map((c) => ({ column: c.column, label: label(c), format: c.format })), rows }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `导出失败 (${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const m = (res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''(.+)/)
  a.download = m ? decodeURIComponent(m[1]) : `${title}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const hhmm = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function DrillPanel(props: Props) {
  const { panel, onChange, onClose, filters, filterDefs, filterText, queries, variant, split, onToggleSplit, fixed, width, onResize, onPick, onOpenTab } = props
  const { card, stack, base } = panel
  const view = levelView(card, stack, filters)
  const { reqKey, loading, data, error, refreshing, refresh } = useBiQuery(view.queryKey, view.params)
  const meta = queries[view.queryKey]
  const showToast = useStore((s) => s.showToast)
  const roles = useStore((s) => s.user?.roles)
  const canExport = !!roles && (roles.includes('admin') || roles.includes('export-excel'))
  const [exporting, setExporting] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  const vars = useMemo(() => ({ ...(JSON.parse(reqKey)[1] as Record<string, unknown>), ...filterText }), [reqKey, filterText])
  const rows = useMemo(() => (data?.rows ?? []) as BiRow[], [data])
  const semantics = meta?.columns
  const resultColumns = data?.columns
  const encoding = useMemo(() => {
    const enc = withColumnSemantics(view.encoding, semantics, resultColumns)
    return enc.columns ? { ...enc, columns: enc.columns.map((c) => (c.label ? { ...c, label: fillPlaceholders(c.label, vars) } : c)) } : enc
  }, [view.encoding, semantics, resultColumns, vars])
  const columns: BiColumnDef[] = useMemo(
    () => (encoding.columns?.length ? encoding.columns : (resultColumns ?? []).map((c) => ({ column: c }))),
    [encoding.columns, resultColumns],
  )
  const canDrill = canDrillFrom(card, stack)
  const drillLabel = nextDrillLabel(card, stack)
  const chart = useMemo(
    () =>
      view.type === 'bar' || view.type === 'line' || view.type === 'pie' || view.type === 'waterfall'
        ? buildChartModel(view.type, encoding, rows, { clickable: canDrill || !!onPick })
        : null,
    [view.type, encoding, rows, canDrill, onPick],
  )

  const crumbs = stack.map((f) => (f.level === 0 ? fillPlaceholders(card.title, vars) : f.crumb))
  const title = crumbs[crumbs.length - 1]
  const chips = filterDefs.filter((f) => filterText[f.name]).map((f) => ({ name: f.name, text: `${f.label}：${filterText[f.name]}` }))
  const deeper = stack.length - 1 > base

  const go = (row: BiRow) => onChange({ ...panel, stack: pushDrill(card, stack, row, view.encoding) })
  const back = () => onChange({ ...panel, stack: popDrillTo(stack, stack.length - 2) })

  const pickRow = (row: BiRow | null, x: number, y: number, newTab = false) => {
    if (!row) return
    if (newTab && onOpenTab && canDrill) {
      onOpenTab(pushDrill(card, stack, row, view.encoding))
      return
    }
    if (onPick && data) {
      onPick({ card, stack, view, row, columns: data.columns, x, y, drillLabel, drill: () => go(row) })
      return
    }
    if (canDrill) go(row)
  }

  /** 问 AI：上下文是这一级明细本身（查询 + 参数 + 路径），不指定某一行 */
  const askAi = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!onPick) return
    const rect = e.currentTarget.getBoundingClientRect()
    onPick({ card, stack, view, row: {}, columns: [], x: rect.left, y: rect.bottom, drillLabel: null, drill: () => {} })
  }

  const label = (c: BiColumnDef) => c.label || columnLabel(encoding, c.column)
  const copy = async (cols: BiColumnDef[], list: BiRow[]) => {
    try {
      await navigator.clipboard.writeText(toTsv(cols, list, label))
      showToast(`已复制 ${list.length} 行，可直接粘贴到 Excel`)
    } catch {
      showToast('复制失败：浏览器不允许访问剪贴板')
    }
  }
  const doExport = async (cols: BiColumnDef[], list: BiRow[]) => {
    if (exporting) return
    setExporting(true)
    try {
      await exportExcel(view.queryKey, title, cols, list, label)
      showToast('导出成功')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  // Esc 关闭（浮层菜单开着时先关浮层；页面被保活隐藏时不响应）
  useEffect(() => {
    if (!onClose || variant === 'page') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="menu"]')) return
      if (!asideRef.current?.getClientRects().length) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, variant])

  // 拖动左边缘调宽（drawer）
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onResize || !asideRef.current) return
    e.preventDefault()
    const startX = e.clientX
    const startW = asideRef.current.offsetWidth
    const hostW = (asideRef.current.offsetParent as HTMLElement | null)?.clientWidth || window.innerWidth
    const clamp = (w: number) => Math.round(Math.max(DRAWER_MIN_W, Math.min(w, hostW - BOARD_MIN_W)))
    const move = (ev: PointerEvent) => onResize(clamp(startW + (startX - ev.clientX)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const resizeByKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onResize || !asideRef.current || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    const hostW = (asideRef.current.offsetParent as HTMLElement | null)?.clientWidth || window.innerWidth
    const w = asideRef.current.offsetWidth + (e.key === 'ArrowLeft' ? 40 : -40)
    onResize(Math.round(Math.max(DRAWER_MIN_W, Math.min(w, hostW - BOARD_MIN_W))))
  }

  const shell =
    variant === 'sheet'
      ? 'fixed inset-0 z-[96] bg-surface flex flex-col safe-bottom bi-sheet-in'
      : variant === 'page'
        ? 'flex flex-col flex-1 min-h-0 bg-surface rounded-2xl border border-line'
        : split
          ? 'relative h-full shrink-0 bg-surface border-l border-line flex flex-col'
          : `${fixed ? 'fixed top-0 bottom-0 right-0 z-[80]' : 'absolute inset-y-0 right-0 z-20'} bg-surface border-l border-line shadow-2xl flex flex-col bi-drawer-in`
  const chartHeight = variant === 'page' ? 480 : variant === 'sheet' ? 320 : 380
  const iconBtn = 'h-8 px-2 rounded-lg flex items-center gap-1 text-[12px] text-muted hover:text-primary hover:bg-surface-2 disabled:opacity-40'

  return (
    <aside
      ref={asideRef}
      className={shell}
      style={variant === 'drawer' && width ? { width } : undefined}
      aria-label={`下钻明细：${title}`}
      role={variant === 'sheet' ? 'dialog' : 'complementary'}
      aria-modal={variant === 'sheet' || undefined}
    >
      {variant === 'drawer' && onResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整明细面板宽度"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeByKey}
          className="absolute left-0 top-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30 focus:bg-primary/30 focus:outline-none z-[4]"
        />
      )}

      <header className="px-4 pt-3 pb-2 border-b border-line flex flex-col gap-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          {deeper && (
            <button type="button" onClick={back} className="h-8 pr-1.5 flex items-center text-[12.5px] text-muted hover:text-primary" aria-label="返回上一级">
              <ChevronLeft className="w-4 h-4" />
              返回
            </button>
          )}
          <h2 className="flex-1 min-w-0 text-[14.5px] font-semibold text-fg truncate" title={title}>
            {title}
          </h2>
          <div className="flex items-center gap-0.5 shrink-0">
            {onPick && (
              <button type="button" onClick={askAi} className={`${iconBtn} text-primary`} title="让 AI 解读这份明细，或就它提问">
                <Sparkles className="w-4 h-4" />
                <span className="hidden sm:inline">问 AI</span>
              </button>
            )}
            <button type="button" onClick={refresh} disabled={refreshing || loading} className={iconBtn} title="刷新（跳过缓存）" aria-label="刷新明细">
              <RotateCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            {variant === 'drawer' && onToggleSplit && (
              <button type="button" onClick={onToggleSplit} className={iconBtn} aria-pressed={!!split} title={split ? '改为浮在看板上' : '与看板并排（看板让出宽度）'}>
                {split ? <PanelRight className="w-4 h-4" /> : <Columns2 className="w-4 h-4" />}
                <span>{split ? '浮动' : '并排'}</span>
              </button>
            )}
            {variant !== 'page' && onOpenTab && (
              <button type="button" onClick={() => onOpenTab(stack)} className={iconBtn} title="在新标签页打开（可分享链接）" aria-label="在新标签页打开">
                <ExternalLink className="w-4 h-4" />
              </button>
            )}
            {onClose && (
              <button type="button" onClick={onClose} className={iconBtn} title="关闭（Esc）" aria-label="关闭明细">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* 从哪来：看板卡片 › 点中项 › …；面板里的各级可点回去 */}
        <nav className="flex items-center gap-1 flex-wrap text-[11.5px] text-subtle" aria-label="下钻路径">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {i > 0 && <ChevronRight className="w-3 h-3 shrink-0" />}
              {i >= base && i < crumbs.length - 1 ? (
                <button type="button" className="text-primary hover:underline truncate max-w-[180px]" onClick={() => onChange({ ...panel, stack: popDrillTo(stack, i) })}>
                  {c}
                </button>
              ) : (
                <span className={`truncate max-w-[200px] ${i === crumbs.length - 1 ? 'text-fg-2 font-medium' : ''}`} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                  {c}
                </span>
              )}
            </span>
          ))}
        </nav>

        {(chips.length > 0 || data?.asOf) && (
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            {chips.map((c) => (
              <span key={c.name} className="px-2 py-0.5 rounded-full bg-surface-2 text-muted">
                {c.text}
              </span>
            ))}
            {data?.asOf && (
              <span className="text-subtle ml-auto" title={data.cached ? '来自缓存' : '刚刚查询'}>
                {data.stale && <span className="text-warning mr-1">更新中</span>}
                截至 {hhmm(data.asOf)}
              </span>
            )}
          </div>
        )}
      </header>

      <div className={`flex-1 min-h-0 flex flex-col p-3 lg:p-4 ${loading && data ? 'opacity-60' : ''}`}>
        {loading && !data && (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-subtle">
            <Loader2 className="w-4 h-4 animate-spin" />
            明细加载中…
          </div>
        )}
        {error && (
          <div className="text-[12.5px] text-danger py-3">
            {error}
            <button type="button" onClick={refresh} className="ml-2 underline">
              重试
            </button>
          </div>
        )}
        {data && !error && view.type === 'table' && (
          <DetailTable
            key={`${stack.length}:${crumbs[crumbs.length - 1]}`}
            rows={rows}
            columns={columns}
            encoding={encoding}
            semantics={semantics}
            onRow={canDrill ? pickRow : undefined}
            toolbar={
              canExport
                ? ({ rows: list, columns: cols }) => (
                    <>
                      <button type="button" className={iconBtn} onClick={() => void copy(cols, list)} disabled={list.length === 0} title="复制当前显示的行（可粘贴到 Excel）">
                        <Copy className="w-3.5 h-3.5" />
                        复制
                      </button>
                      <button type="button" className={iconBtn} onClick={() => void doExport(cols, list)} disabled={exporting || list.length === 0} title="导出当前显示的行（含搜索、筛选、排序）">
                        {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        导出 Excel
                      </button>
                    </>
                  )
                : undefined
            }
          />
        )}
        {data && !error && chart && (
          rows.length === 0 ? (
            <p className="text-[12px] text-subtle py-6 text-center">暂无数据</p>
          ) : (
            <BiChart
              option={chart.option}
              height={chartHeight}
              ariaLabel={`${title}图表，共 ${chart.plotted} 项`}
              onPick={canDrill || onPick ? (e) => pickRow(chart.rowAt(e.dataIndex, e.seriesName), e.x, e.y, e.newTab) : undefined}
              pickIndex={chart.pickIndex}
            />
          )
        )}
        {data?.truncated && <p className="text-[10.5px] text-subtle mt-1.5">仅显示前 {data.rowCount} 行，搜索 / 合计 / 导出只针对这些行</p>}
        {canDrill && view.type === 'table' && rows.length > 0 && (
          <p className="text-[10.5px] text-subtle mt-1.5">点击一行可继续下钻到「{drillLabel}」{onOpenTab ? '，按住 Ctrl / ⌘ 点击在新标签页打开' : ''}</p>
        )}
      </div>
    </aside>
  )
}
