/**
 * 看板卡片：自己取数（POST /bi/query，走服务端缓存），按类型渲染 KPI / 图表 / 表格，
 * 卡片内逐级下钻（面包屑返回）。点中元素时把 BiPick 交给上层（显示点击浮层）。
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Info, RotateCw } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { changeRatio, formatValue, type BiCard, type BiColumnDef, type BiFilterValues, type BiQueryMeta, type BiQueryResult } from '../../utils/bi'
import { buildChartModel, columnLabel, type BiRow } from '../../utils/biOption'
import { canDrillFrom, levelView, nextDrillLabel, popDrillTo, pushDrill, rootStack, type DrillFrame } from '../../utils/biDrill'
import type { BiPick } from '../../utils/biContext'
import BiChart from './BiChart'

const CHART_HEIGHT: Record<number, number> = { 1: 170, 2: 260, 3: 360, 4: 460 }

interface Props {
  card: BiCard
  filters: BiFilterValues
  queries: Record<string, BiQueryMeta>
  onPick?: (pick: BiPick) => void
}

type LoadState = { key: string; data?: BiQueryResult; error?: string }

function fetchQuery(queryKey: string, params: unknown, refresh: boolean): Promise<BiQueryResult> {
  return apiFetch('/bi/query', { method: 'POST', body: JSON.stringify({ queryKey, params, refresh }) }) as Promise<BiQueryResult>
}

const hhmm = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function BiCardView({ card, filters, queries, onPick }: Props) {
  const [stack, setStack] = useState<DrillFrame[]>(() => rootStack(card))
  const view = levelView(card, stack, filters)
  const reqKey = JSON.stringify([view.queryKey, view.params])
  const [state, setState] = useState<LoadState | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // 参数变化（筛选、下钻）即取数；只在 Promise 回调里 setState
  useEffect(() => {
    let alive = true
    const [queryKey, params] = JSON.parse(reqKey) as [string, unknown]
    fetchQuery(queryKey, params, false)
      .then((data) => alive && setState({ key: reqKey, data }))
      .catch((err: unknown) => alive && setState({ key: reqKey, error: err instanceof Error ? err.message : '加载失败' }))
    return () => {
      alive = false
    }
  }, [reqKey])

  const refresh = () => {
    setRefreshing(true)
    fetchQuery(view.queryKey, view.params, true)
      .then((data) => setState({ key: reqKey, data }))
      .catch((err: unknown) => setState({ key: reqKey, error: err instanceof Error ? err.message : '加载失败' }))
      .finally(() => setRefreshing(false))
  }

  const loading = !state || state.key !== reqKey
  const data = state?.data
  const error = !loading ? state?.error : undefined
  const meta = queries[view.queryKey]
  const drillLabel = nextDrillLabel(card, stack)
  const clickable = !!onPick && (view.type !== 'table' || canDrillFrom(card, stack))

  const pick = (row: BiRow | null, x: number, y: number) => {
    if (!row || !onPick || !data) return
    onPick({
      card,
      stack,
      view,
      row,
      columns: data.columns,
      x,
      y,
      drillLabel,
      drill: () => setStack((s) => pushDrill(card, s, row, view.encoding)),
    })
  }

  const rows = useMemo(() => (data?.rows ?? []) as BiRow[], [data])
  const chart = useMemo(
    () =>
      view.type === 'bar' || view.type === 'line' || view.type === 'pie'
        ? buildChartModel(view.type, view.encoding, rows, { clickable })
        : null,
    // view.encoding 直接引用 card 里的对象（卡片或某级下钻），引用稳定
    [rows, view.type, view.encoding, clickable],
  )

  const height = CHART_HEIGHT[card.layout.h] ?? CHART_HEIGHT[2]

  return (
    <section
      className="bg-white rounded-2xl border border-[#eef0f4] p-4 flex flex-col min-w-0"
      aria-label={card.title}
      style={{ boxShadow: '0 1px 2px rgba(16,24,40,.03)' }}
    >
      {/* 标题行 */}
      <header className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-[#1a1a2e] truncate flex items-center gap-1">
            {card.title}
            {meta?.caliberNote && (
              <span title={`口径：${meta.caliberNote}`} className="text-slate-400 cursor-help">
                <Info className="w-3.5 h-3.5" aria-label={`口径：${meta.caliberNote}`} />
              </span>
            )}
          </h3>
          {card.subtitle && stack.length === 1 && <p className="text-[11.5px] text-slate-400 truncate">{card.subtitle}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[10.5px] text-slate-400">
          {data?.stale && <span className="text-amber-600" title="缓存已过期，后台正在更新">更新中</span>}
          {/* KPI 卡较窄（手机半宽），时间放到底部，保证标题完整 */}
          {data?.asOf && card.type !== 'kpi' && <span title={data.cached ? '来自缓存' : '刚刚查询'}>截至 {hhmm(data.asOf)}</span>}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || loading}
            className="p-1 rounded hover:bg-slate-100 disabled:opacity-40"
            title="刷新（跳过缓存）"
            aria-label={`刷新 ${card.title}`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* 下钻面包屑 */}
      {stack.length > 1 && (
        <nav className="flex items-center gap-1 flex-wrap mb-2 text-[11.5px]" aria-label="下钻路径">
          <button type="button" onClick={() => setStack((s) => popDrillTo(s, s.length - 2))} className="flex items-center text-slate-500 hover:text-[#4f6ef7] mr-1" aria-label="返回上一级">
            <ChevronLeft className="w-3.5 h-3.5" />
            返回
          </button>
          {stack.map((f, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />}
              {i < stack.length - 1 ? (
                <button type="button" onClick={() => setStack((s) => popDrillTo(s, i))} className="text-[#4f6ef7] hover:underline truncate max-w-[160px]">
                  {f.crumb}
                </button>
              ) : (
                <span className="text-slate-700 font-medium truncate max-w-[200px]" aria-current="page">{f.crumb}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      {/* 内容 */}
      <div className={`relative flex-1 min-h-0 ${loading && data ? 'opacity-60' : ''}`}>
        {loading && !data && <div className="rounded-xl animate-pulse bg-[#eef0f4]" style={{ height: view.type === 'kpi' ? 56 : height }} />}
        {error && (
          <div className="text-[12px] text-rose-600 py-3">
            {error}
            <button type="button" onClick={refresh} className="ml-2 underline">重试</button>
          </div>
        )}
        {data && !error && rows.length === 0 && <p className="text-[12px] text-slate-400 py-6 text-center">暂无数据</p>}
        {data && !error && rows.length > 0 && (
          <>
            {view.type === 'kpi' && <KpiBody card={card} row={rows[0]} onClick={(x, y) => pick(rows[0], x, y)} clickable={!!onPick} />}
            {chart && (
              <BiChart
                option={chart.option}
                height={height}
                ariaLabel={`${card.title}图表，共 ${chart.plotted} 项`}
                onPick={clickable ? (e) => pick(chart.rowAt(e.dataIndex, e.seriesName), e.x, e.y) : undefined}
              />
            )}
            {view.type === 'table' && (
              <TableBody
                rows={rows}
                columns={data.columns}
                encoding={view.encoding}
                maxHeight={height}
                onRow={clickable ? (row, x, y) => pick(row, x, y) : undefined}
              />
            )}
            {data.truncated && <p className="text-[10.5px] text-slate-400 mt-1">仅显示前 {data.rowCount} 行</p>}
          </>
        )}
      </div>

      {card.type === 'kpi' && data?.asOf && (
        <p className="text-[10.5px] text-slate-400 mt-1.5" title={data.cached ? '来自缓存' : '刚刚查询'}>数据截至 {hhmm(data.asOf)}</p>
      )}
      {clickable && data && rows.length > 0 && (
        <p className="text-[10.5px] text-slate-300 mt-1.5">
          点击{view.type === 'kpi' ? '数字' : view.type === 'table' ? '行' : '图形'}可{drillLabel ? `下钻到「${drillLabel}」或` : ''}让 AI 解读
        </p>
      )}
    </section>
  )
}

function KpiBody({ card, row, onClick, clickable }: { card: BiCard; row: BiRow; onClick: (x: number, y: number) => void; clickable: boolean }) {
  const enc = card.encoding
  const value = enc.value ? row[enc.value] : undefined
  const ratio = enc.compare ? changeRatio(value, row[enc.compare]) : null
  const label = enc.label && row[enc.label] != null ? String(row[enc.label]) : ''
  const body = (
    <>
      <div className="text-[26px] font-semibold tabular-nums text-[#1a1a2e] leading-tight">
        {formatValue(value, enc, { withUnit: false })}
        {enc.unit && enc.format !== 'percent' && <span className="text-[13px] font-normal text-slate-400 ml-1">{enc.unit}</span>}
      </div>
      <div className="flex items-center gap-2 mt-1 text-[11.5px]">
        {ratio != null && (
          <span className={ratio >= 0 ? 'text-[#4f6ef7]' : 'text-amber-600'}>
            {ratio >= 0 ? '▲' : '▼'} {Math.abs(ratio * 100).toFixed(1)}%
            <span className="text-slate-400 ml-1">较对比期</span>
          </span>
        )}
        {label && <span className="text-slate-400 truncate">{label}</span>}
      </div>
    </>
  )
  if (!clickable) return <div>{body}</div>
  return (
    <button
      type="button"
      className="text-left w-full rounded-lg -m-1 p-1 hover:bg-[#f5f7ff] transition-colors"
      onClick={(e) => onClick(e.clientX, e.clientY)}
      aria-label={`${card.title}：${formatValue(value, enc)}，点击查看操作`}
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
  onRow,
}: {
  rows: BiRow[]
  columns: string[]
  encoding: BiCard['encoding']
  maxHeight: number
  onRow?: (row: BiRow, x: number, y: number) => void
}) {
  const cols: BiColumnDef[] = encoding.columns?.length ? encoding.columns : columns.map((c) => ({ column: c }))
  const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  return (
    <div className="overflow-auto border border-slate-100 rounded-lg" style={{ maxHeight }}>
      <table className="min-w-full text-[12px]">
        <thead className="bg-slate-50 sticky top-0 z-[1]">
          <tr>
            {cols.map((c) => (
              <th key={c.column} scope="col" className="px-2.5 py-1.5 text-left font-medium text-slate-500 whitespace-nowrap">
                {c.label || columnLabel(encoding, c.column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className={`border-t border-slate-100 ${onRow ? 'cursor-pointer hover:bg-[#f5f7ff]' : ''}`}
              onClick={onRow ? (e) => onRow(r, e.clientX, e.clientY) : undefined}
              onKeyDown={onRow ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  onRow(r, rect.left + 40, rect.bottom)
                }
              } : undefined}
              tabIndex={onRow ? 0 : undefined}
            >
              {cols.map((c) => {
                const v = r[c.column]
                const num = c.format != null || isNum(v)
                return (
                  <td key={c.column} className={`px-2.5 py-1.5 whitespace-nowrap text-slate-700 ${num ? 'text-right tabular-nums' : ''}`}>
                    {c.format ? formatValue(v, { format: c.format }) : v == null ? '' : String(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
