/**
 * 看板卡片：自己取数（POST /bi/query，走服务端缓存），按类型渲染 KPI / 图表 / 表格。
 * 下钻：配成「卡片内」的一级在卡片里切换（面包屑返回）；配成「明细面板」的一级交给上层打开面板（onOpenPanel），
 * 面板开着时卡片上高亮来源项（selectedRow）。点中元素时把 BiPick 交给上层（显示点击浮层）；
 * 按住 Ctrl / ⌘ 点击直接在新标签页打开下一级（onOpenTab）。
 * 图表 / 表格卡片可单独全屏：同一个卡片原地铺满视口（不卸载，保留下钻），Esc 退出。
 * 手机上由看板接管全屏（onRequestFullscreen → LandscapeViewer 横屏、左右滑动切换），查看器里的卡片为嵌入模式（embedded）。
 */
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Info, Maximize2, Minimize2, RotateCw } from 'lucide-react'
import { usePageFullscreen } from '../../hooks/usePageFullscreen'
import { BI_CARD_HEIGHT, changeRatio, dataBarScale, fillPlaceholders, formatValue, toNumber, withColumnSemantics, type BiCard, type BiColumnDef, type BiColumnSemantic, type BiFilterValues, type BiQueryMeta, type BiTrend } from '../../utils/bi'
import { summableColumns, sumColumns } from '../../utils/biTable'
import { buildChartModel, columnLabel, highlightPoint, sameRow, type BiRow } from '../../utils/biOption'
import { canDrillFrom, levelView, nextDrillLabel, nextOpensInPanel, popDrillTo, pushDrill, rootStack, type DrillFrame } from '../../utils/biDrill'
import type { BiPick } from '../../utils/biContext'
import BiChart from './BiChart'
import { useBiQuery } from './useBiQuery'


interface Props {
  card: BiCard
  filters: BiFilterValues
  queries: Record<string, BiQueryMeta>
  /** 筛选当前值的显示文字（filterDisplayText），替换标题 / 列名里的 {筛选名} */
  filterText?: Record<string, string>
  onPick?: (pick: BiPick) => void
  /** 下一级配成「明细面板」时：交给上层打开面板（stack 为含下一级的完整路径） */
  onOpenPanel?: (stack: DrillFrame[]) => void
  /** Ctrl / ⌘ + 点击：在新标签页打开下一级 */
  onOpenTab?: (stack: DrillFrame[]) => void
  /** 明细面板正显示这张卡片哪一行的明细（高亮） */
  selectedRow?: BiRow | null
  /** 全屏按钮交给上层（手机横屏查看器）；不传 = 卡片自己原地全屏 */
  onRequestFullscreen?: () => void
  /** 嵌入横屏查看器：铺满父容器，全屏按钮变成「退出」 */
  embedded?: { onExit: () => void }
}

/** 涨跌颜色：up-good 涨绿跌红、up-bad 涨红跌绿；不写用中性色（主色 / 警示色） */
function deltaTone(n: number, trend?: BiTrend): string {
  if (n === 0) return 'text-muted'
  if (trend === 'up-good') return n > 0 ? 'text-success' : 'text-danger'
  if (trend === 'up-bad') return n > 0 ? 'text-danger' : 'text-success'
  return n > 0 ? 'text-primary' : 'text-warning'
}

const hhmm = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function BiCardView({ card, filters, queries, filterText, onPick, onOpenPanel, onOpenTab, selectedRow, onRequestFullscreen, embedded }: Props) {
  const [stack, setStack] = useState<DrillFrame[]>(() => rootStack(card))
  const view = levelView(card, stack, filters)
  // 参数变化（筛选、下钻）即取数
  const { reqKey, loading, data, error, refreshing, refresh } = useBiQuery(view.queryKey, view.params)
  const own = usePageFullscreen()
  const fullscreen = !!embedded || own.fullscreen
  const exitFullscreen = embedded ? embedded.onExit : own.exit
  const toggleFullscreen = embedded ? embedded.onExit : onRequestFullscreen ?? own.toggle

  const meta = queries[view.queryKey]
  const drillLabel = nextDrillLabel(card, stack)
  const clickable = !!onPick && (view.type !== 'table' || canDrillFrom(card, stack))

  // 标题 / 列名里的 {名称}：筛选显示文字优先（如「去年同期」），其次本级参数值
  // （依赖 reqKey 而不是每次渲染都新建的 view.params，保证 encoding / 图表 option 引用稳定）
  const vars = useMemo(() => ({ ...(JSON.parse(reqKey)[1] as Record<string, unknown>), ...filterText }), [reqKey, filterText])
  const title = fillPlaceholders(card.title, vars)
  const subtitle = card.subtitle ? fillPlaceholders(card.subtitle, vars) : ''

  /** 进入下一级：明细面板的一级交给上层（并退出单卡全屏；横屏查看器不关，面板盖在上面，关掉面板回到查看器），其余在卡片里切换 */
  const drillInto = (row: BiRow) => {
    const next = pushDrill(card, stack, row, view.encoding)
    if (onOpenPanel && nextOpensInPanel(card, stack)) {
      if (!embedded) exitFullscreen()
      onOpenPanel(next)
    } else {
      setStack(next)
    }
  }

  const pick = (row: BiRow | null, x: number, y: number, newTab = false) => {
    if (!row || !onPick || !data) return
    if (newTab && onOpenTab && canDrillFrom(card, stack)) {
      onOpenTab(pushDrill(card, stack, row, view.encoding))
      return
    }
    onPick({
      card: title === card.title ? card : { ...card, title },
      stack,
      view,
      row,
      columns: data.columns,
      x,
      y,
      drillLabel,
      drill: () => drillInto(row),
      exitFullscreen,
    })
  }

  const rows = useMemo(() => (data?.rows ?? []) as BiRow[], [data])
  // 卡片没写的格式 / 单位 / 列名从查询的列语义继承；view.encoding 直接引用 card 里的对象，引用稳定
  const semantics = meta?.columns
  const resultColumns = data?.columns
  const encoding = useMemo(() => {
    const enc = withColumnSemantics(view.encoding, semantics, resultColumns)
    return enc.columns ? { ...enc, columns: enc.columns.map((c) => (c.label ? { ...c, label: fillPlaceholders(c.label, vars) } : c)) } : enc
  }, [view.encoding, semantics, resultColumns, vars])
  const chart = useMemo(
    () =>
      view.type === 'bar' || view.type === 'line' || view.type === 'pie' || view.type === 'waterfall'
        ? buildChartModel(view.type, encoding, rows, { clickable })
        : null,
    [rows, view.type, encoding, clickable],
  )
  // 明细面板开着：高亮来源项（来源行不在当前级的结果里时不高亮）
  const chartOption = useMemo(
    () => (chart && selectedRow ? highlightPoint(chart.option, chart.indexOf?.(selectedRow) ?? null) : chart?.option),
    [chart, selectedRow],
  )

  // 合计显示在标题下方（柱 / 线；饼图画在环中间）。单项只写「合计 金额」，多项带系列名
  const headerTotals =
    chart && !error && encoding.sumMode === 'header' && view.type !== 'pie' && chart.totals.length
      ? `合计 ${chart.totals.length === 1 ? chart.totals[0].text : chart.totals.map((t) => `${t.name} ${t.text}`).join(' · ')}`
      : ''

  const height = BI_CARD_HEIGHT[card.layout.h] ?? BI_CARD_HEIGHT[2]
  // 全屏时图表 / 表格铺满内容区（内容区是 flex-1，高度确定）
  const bodyHeight: number | string = fullscreen ? '100%' : height

  return (
    <section
      className={
        embedded
          ? 'h-full bg-surface px-4 pt-3 pb-1 flex flex-col min-w-0'
          : fullscreen
          ? 'fixed inset-0 z-[95] bg-surface p-4 lg:p-6 safe-bottom flex flex-col min-w-0'
          : 'bg-surface rounded-2xl border border-line shadow-sm p-4 flex flex-col min-w-0'
      }
      aria-label={title}
      aria-modal={(fullscreen && !embedded) || undefined}
      role={fullscreen && !embedded ? 'dialog' : undefined}
    >
      {/* 标题行 */}
      <header className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-fg truncate flex items-center gap-1">
            {title}
            {meta?.caliberNote && (
              <span title={`口径：${meta.caliberNote}`} className="text-subtle cursor-help">
                <Info className="w-3.5 h-3.5" aria-label={`口径：${meta.caliberNote}`} />
              </span>
            )}
          </h3>
          {subtitle && stack.length === 1 && <p className="text-[11.5px] text-subtle truncate">{subtitle}</p>}
          {headerTotals && (
            <p className="text-[11.5px] text-muted truncate num" title={headerTotals}>
              {headerTotals}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[10.5px] text-subtle">
          {data?.stale && <span className="text-warning" title="缓存已过期，后台正在更新">更新中</span>}
          {/* KPI 卡较窄（手机半宽），时间放到底部，保证标题完整 */}
          {data?.asOf && card.type !== 'kpi' && <span title={data.cached ? '来自缓存' : '刚刚查询'}>截至 {hhmm(data.asOf)}</span>}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || loading}
            className="p-1 rounded hover:bg-surface-2 disabled:opacity-40"
            title="刷新（跳过缓存）"
            aria-label={`刷新 ${title}`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          {card.type !== 'kpi' && (
            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-1 rounded hover:bg-surface-2"
              title={fullscreen ? '退出全屏（Esc）' : '全屏查看'}
              aria-label={fullscreen ? `退出全屏 ${title}` : `全屏查看 ${title}`}
              aria-pressed={fullscreen}
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </header>

      {/* 下钻面包屑 */}
      {stack.length > 1 && (
        <nav className="flex items-center gap-1 flex-wrap mb-2 text-[11.5px]" aria-label="下钻路径">
          <button type="button" onClick={() => setStack((s) => popDrillTo(s, s.length - 2))} className="flex items-center text-muted hover:text-primary mr-1" aria-label="返回上一级">
            <ChevronLeft className="w-3.5 h-3.5" />
            返回
          </button>
          {stack.map((f, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {i > 0 && <ChevronRight className="w-3 h-3 text-subtle shrink-0" />}
              {i < stack.length - 1 ? (
                <button type="button" onClick={() => setStack((s) => popDrillTo(s, i))} className="text-primary hover:underline truncate max-w-[160px]">
                  {f.crumb}
                </button>
              ) : (
                <span className="text-fg-2 font-medium truncate max-w-[200px]" aria-current="page">{f.crumb}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      {/* 内容 */}
      <div className={`relative flex-1 min-h-0 ${fullscreen ? 'flex flex-col' : ''} ${loading && data ? 'opacity-60' : ''}`}>
        {loading && !data && <div className="rounded-xl animate-pulse bg-surface-2" style={{ height: view.type === 'kpi' ? 56 : bodyHeight }} />}
        {error && (
          <div className="text-[12px] text-danger py-3">
            {error}
            <button type="button" onClick={refresh} className="ml-2 underline">重试</button>
          </div>
        )}
        {data && !error && rows.length === 0 && <p className="text-[12px] text-subtle py-6 text-center">暂无数据</p>}
        {data && !error && rows.length > 0 && (
          <>
            {view.type === 'kpi' && <KpiBody title={title} enc={encoding} row={rows[0]} onClick={(x, y, newTab) => pick(rows[0], x, y, newTab)} clickable={!!onPick} />}
            {(chart || view.type === 'table') && (
              <div className={fullscreen ? 'flex-1 min-h-0' : undefined}>
                {chart && (
                  <BiChart
                    option={chartOption ?? chart.option}
                    height={bodyHeight}
                    ariaLabel={`${title}图表，共 ${chart.plotted} 项`}
                    onPick={clickable ? (e) => pick(chart.rowAt(e.dataIndex, e.seriesName), e.x, e.y, e.newTab) : undefined}
                    pickIndex={chart.pickIndex}
                  />
                )}
                {view.type === 'table' && (
                  <TableBody
                    rows={rows}
                    columns={data.columns}
                    encoding={encoding}
                    maxHeight={bodyHeight}
                    selectedRow={selectedRow}
                    semantics={semantics}
                    truncated={!!data.truncated}
                    onRow={clickable ? (row, x, y, newTab) => pick(row, x, y, newTab) : undefined}
                  />
                )}
              </div>
            )}
            {data.truncated && <p className="text-[10.5px] text-subtle mt-1">仅显示前 {data.rowCount} 行</p>}
          </>
        )}
      </div>

      {card.type === 'kpi' && data?.asOf && (
        <p className="text-[10.5px] text-subtle mt-1.5" title={data.cached ? '来自缓存' : '刚刚查询'}>数据截至 {hhmm(data.asOf)}</p>
      )}
    </section>
  )
}

function KpiBody({ title, enc, row, onClick, clickable }: { title: string; enc: BiCard['encoding']; row: BiRow; onClick: (x: number, y: number, newTab: boolean) => void; clickable: boolean }) {
  const value = enc.value ? row[enc.value] : undefined
  const prev = enc.compare ? row[enc.compare] : undefined
  const ratio = enc.compare ? changeRatio(value, prev) : null
  // 对比列的显示名（如「去年同期」「上月」，可用 {筛选名} 占位符随对比方式变化）
  const compareLabel = (enc.compare && enc.columns?.find((c) => c.column === enc.compare)?.label) || '对比期'
  const label = enc.label && row[enc.label] != null ? String(row[enc.label]) : ''
  const body = (
    <>
      <div className="num text-[26px] font-semibold text-fg leading-tight">
        {formatValue(value, enc, { withUnit: false })}
        {enc.unit && enc.format !== 'percent' && <span className="text-[13px] font-normal text-subtle ml-1">{enc.unit}</span>}
      </div>
      <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11.5px]">
        {ratio != null && (
          <span className={`num ${deltaTone(ratio, enc.trend)}`}>
            {ratio > 0 ? '▲' : ratio < 0 ? '▼' : ''} {Math.abs(ratio * 100).toFixed(1)}%
          </span>
        )}
        {enc.compare && toNumber(prev) != null && (
          <span className="text-subtle">
            {ratio != null ? '较' : ''}
            {compareLabel} <span className="num">{formatValue(prev, enc)}</span>
          </span>
        )}
        {label && <span className="text-subtle truncate">{label}</span>}
      </div>
    </>
  )
  if (!clickable) return <div>{body}</div>
  return (
    <button
      type="button"
      className="text-left w-full rounded-lg -m-1 p-1 hover:bg-primary-soft/60 transition-colors"
      onClick={(e) => onClick(e.clientX, e.clientY, e.ctrlKey || e.metaKey)}
      aria-label={`${title}：${formatValue(value, enc)}，点击查看操作`}
    >
      {body}
    </button>
  )
}

function TableBody({
  rows,
  columns,
  encoding,
  maxHeight,
  selectedRow,
  semantics,
  truncated,
  onRow,
}: {
  rows: BiRow[]
  columns: string[]
  encoding: BiCard['encoding']
  maxHeight: number | string
  selectedRow?: BiRow | null
  semantics?: BiColumnSemantic[]
  truncated: boolean
  onRow?: (row: BiRow, x: number, y: number, newTab: boolean) => void
}) {
  const cols: BiColumnDef[] = encoding.columns?.length ? encoding.columns : columns.map((c) => ({ column: c }))
  // 底部合计行：sumColumns 不写时取可合计的度量列（与明细面板一致）
  const sumCols =
    encoding.sumMode !== 'row'
      ? []
      : encoding.sumColumns?.length
        ? encoding.sumColumns.filter((c) => cols.some((x) => x.column === c))
        : summableColumns(cols, rows, semantics)
  const totals = sumCols.length ? sumColumns(rows, sumCols) : null
  const delta = new Set(encoding.deltaColumns || [])
  const barCols = (encoding.barColumns || []).filter((c) => cols.some((x) => x.column === c))
  const barMax = dataBarScale(rows, barCols, encoding.barShared)
  const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  return (
    <div className="overflow-auto border border-line rounded-lg" style={{ maxHeight }}>
      <table className="min-w-full text-[12px]">
        <thead className="bg-surface-2 sticky top-0 z-[1]">
          <tr>
            {cols.map((c) => (
              <th key={c.column} scope="col" className="px-2.5 py-1.5 text-left font-medium text-muted whitespace-nowrap">
                {c.label || columnLabel(encoding, c.column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className={`border-t border-line ${selectedRow && sameRow(r, selectedRow) ? 'bg-primary-soft' : ''} ${onRow ? 'cursor-pointer hover:bg-primary-soft/60' : ''}`}
              aria-selected={selectedRow ? sameRow(r, selectedRow) : undefined}
              onClick={onRow ? (e) => onRow(r, e.clientX, e.clientY, e.ctrlKey || e.metaKey) : undefined}
              onKeyDown={onRow ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  onRow(r, rect.left + 40, rect.bottom, false)
                }
              } : undefined}
              tabIndex={onRow ? 0 : undefined}
            >
              {cols.map((c) => {
                const v = r[c.column]
                const num = c.format != null || isNum(v)
                if (c.column in barMax) {
                  const b = toNumber(v)
                  const ratio = b != null && barMax[c.column] > 0 ? Math.abs(b) / barMax[c.column] : 0
                  const text = delta.has(c.column) && b != null ? `${b > 0 ? '▲ ' : b < 0 ? '▼ ' : ''}${formatValue(Math.abs(b), { format: c.format })}` : formatValue(v, { format: c.format })
                  return (
                    <td key={c.column} className="px-2.5 py-1.5 min-w-[10rem]">
                      {/* 条长按 (单元格宽 - 数字宽) × 比例，数字紧跟在条的末端 */}
                      <div className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className={`h-3.5 rounded-sm shrink-0 ${b != null && b < 0 ? 'bg-danger/60' : 'bg-primary/70'}`}
                          style={{ width: `calc((100% - 5rem) * ${ratio})` }}
                        />
                        <span className={`whitespace-nowrap tabular-nums ${delta.has(c.column) && b != null ? deltaTone(b, encoding.trend) : 'text-fg-2'}`}>{text}</span>
                      </div>
                    </td>
                  )
                }
                const n = delta.has(c.column) ? toNumber(v) : null
                if (n != null) {
                  return (
                    <td key={c.column} className={`px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums ${deltaTone(n, encoding.trend)}`}>
                      {n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}
                      {formatValue(Math.abs(n), { format: c.format })}
                    </td>
                  )
                }
                return (
                  <td key={c.column} className={`px-2.5 py-1.5 whitespace-nowrap text-fg-2 ${num ? 'text-right tabular-nums' : ''}`}>
                    {c.format ? formatValue(v, { format: c.format }) : v == null ? '' : String(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot className="sticky bottom-0 z-[1]">
            <tr>
              {cols.map((c, i) => (
                <td
                  key={c.column}
                  className={`bg-surface-2 border-t border-line px-2.5 py-1.5 whitespace-nowrap font-medium ${c.column in totals ? 'text-right tabular-nums text-fg' : 'text-muted'}`}
                >
                  {c.column in totals ? formatValue(totals[c.column], { format: c.format }) : i === 0 ? (truncated ? '合计（已显示的行）' : '合计') : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
