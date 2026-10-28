/**
 * 下钻明细表（明细面板 / 新标签页）：表头与第一列固定、点表头排序（Shift 追加多列）、
 * 搜索 + 按列筛选、底部合计行。只处理已取回的行；toolbar 由调用方放进来（复制 / 导出等）。
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Filter, Search, X } from 'lucide-react'
import { formatValue, toNumber, type BiColumnDef, type BiColumnSemantic, type BiEncoding, type BiTrend } from '../../utils/bi'
import { columnLabel, sameRow, type BiRow } from '../../utils/biOption'
import { filterRows, sortRows, sumColumns, summableColumns, toggleSort, type SortKey } from '../../utils/biTable'

interface Props {
  rows: BiRow[]
  /** 已继承列语义的列定义（withColumnSemantics 之后） */
  columns: BiColumnDef[]
  encoding: BiEncoding
  semantics?: BiColumnSemantic[]
  /** 行可点（还能继续下钻）；newTab = 按住了 Ctrl / ⌘ */
  onRow?: (row: BiRow, x: number, y: number, newTab: boolean) => void
  selectedRow?: BiRow | null
  /** 搜索框右侧的按钮（复制、导出） */
  toolbar?: (visible: { rows: BiRow[]; columns: BiColumnDef[] }) => React.ReactNode
}

function deltaTone(n: number, trend?: BiTrend): string {
  if (n === 0) return 'text-muted'
  if (trend === 'up-good') return n > 0 ? 'text-success' : 'text-danger'
  if (trend === 'up-bad') return n > 0 ? 'text-danger' : 'text-success'
  return n > 0 ? 'text-primary' : 'text-warning'
}

const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))

export default function DetailTable({ rows, columns, encoding, semantics, onRow, selectedRow, toolbar }: Props) {
  const [search, setSearch] = useState('')
  const [sorts, setSorts] = useState<SortKey[]>([])
  const [showColFilters, setShowColFilters] = useState(false)
  const [colFilters, setColFilters] = useState<Record<string, string>>({})

  const visible = useMemo(() => sortRows(filterRows(rows, columns, search, colFilters), sorts), [rows, columns, search, colFilters, sorts])
  const sumCols = useMemo(() => summableColumns(columns, rows, semantics), [columns, rows, semantics])
  const totals = useMemo(() => sumColumns(visible, sumCols), [visible, sumCols])
  const delta = new Set(encoding.deltaColumns || [])
  // 数值列（有格式或可合计）表头右对齐，与数字对齐
  const numCols = new Set([...sumCols, ...columns.filter((c) => c.format).map((c) => c.column)])
  const label = (c: BiColumnDef) => c.label || columnLabel(encoding, c.column)
  const filtered = visible.length !== rows.length
  const activeColFilters = Object.values(colFilters).filter((v) => v.trim()).length

  const sticky0 = 'sticky left-0 z-[1]'

  return (
    <div className="flex flex-col min-h-0 flex-1 gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="relative flex-1 min-w-[10rem] max-w-xs">
          <Search className="w-3.5 h-3.5 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
          <input
            className="w-full h-8 pl-8 pr-7 rounded-lg border border-line bg-surface text-[12.5px] text-fg-2 focus:outline-none focus:border-primary"
            placeholder="搜索明细"
            aria-label="搜索明细"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-subtle hover:text-fg" onClick={() => setSearch('')} aria-label="清空搜索">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => setShowColFilters((v) => !v)}
          aria-pressed={showColFilters}
          className={`h-8 px-2.5 rounded-lg border text-[12px] flex items-center gap-1 ${showColFilters || activeColFilters ? 'border-primary text-primary bg-primary-soft' : 'border-line text-muted hover:text-fg'}`}
          title="按列筛选"
        >
          <Filter className="w-3.5 h-3.5" />
          按列筛选{activeColFilters ? ` · ${activeColFilters}` : ''}
        </button>
        <span className="text-[11.5px] text-subtle num">
          {filtered ? `${visible.length} / ${rows.length} 行` : `共 ${rows.length} 行`}
          {sorts.length > 0 && (
            <button type="button" className="ml-2 text-primary hover:underline" onClick={() => setSorts([])}>
              取消排序
            </button>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">{toolbar?.({ rows: visible, columns })}</div>
      </div>

      <div className="overflow-auto border border-line rounded-lg flex-1 min-h-0">
        <table className="min-w-full text-[12px] border-separate border-spacing-0">
          <thead className="sticky top-0 z-[2]">
            <tr>
              {columns.map((c, i) => {
                const si = sorts.findIndex((s) => s.column === c.column)
                const sort = si >= 0 ? sorts[si] : null
                return (
                  <th
                    key={c.column}
                    scope="col"
                    aria-sort={sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={`bg-surface-2 border-b border-line px-2.5 py-1.5 font-medium text-muted whitespace-nowrap ${numCols.has(c.column) ? 'text-right' : 'text-left'} ${i === 0 ? `${sticky0} z-[3]` : ''}`}
                  >
                    <button
                      type="button"
                      className={`inline-flex items-center gap-0.5 hover:text-fg ${numCols.has(c.column) ? 'flex-row-reverse' : ''}`}
                      title="点击排序，按住 Shift 追加排序列"
                      onClick={(e) => setSorts((s) => toggleSort(s, c.column, e.shiftKey))}
                    >
                      {label(c)}
                      {sort && (sort.dir === 'asc' ? <ArrowUp className="w-3 h-3 text-primary" /> : <ArrowDown className="w-3 h-3 text-primary" />)}
                      {sort && sorts.length > 1 && <span className="text-[10px] text-primary num">{si + 1}</span>}
                    </button>
                  </th>
                )
              })}
            </tr>
            {showColFilters && (
              <tr>
                {columns.map((c, i) => (
                  <th key={c.column} className={`bg-surface-2 border-b border-line px-1.5 py-1 ${i === 0 ? `${sticky0} z-[3]` : ''}`}>
                    <input
                      className="w-full min-w-[5rem] h-7 px-2 rounded-md border border-line bg-surface text-[11.5px] font-normal text-fg-2 focus:outline-none focus:border-primary"
                      placeholder="包含…"
                      aria-label={`筛选 ${label(c)}`}
                      value={colFilters[c.column] ?? ''}
                      onChange={(e) => setColFilters((f) => ({ ...f, [c.column]: e.target.value }))}
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visible.map((r, ri) => {
              const selected = !!selectedRow && sameRow(r, selectedRow)
              const rowBg = selected ? 'bg-primary-soft' : 'bg-surface'
              return (
                <tr
                  key={ri}
                  className={`group ${onRow ? 'cursor-pointer' : ''}`}
                  aria-selected={selectedRow ? selected : undefined}
                  onClick={onRow ? (e) => onRow(r, e.clientX, e.clientY, e.ctrlKey || e.metaKey) : undefined}
                  onKeyDown={
                    onRow
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                            onRow(r, rect.left + 40, rect.bottom, false)
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRow ? 0 : undefined}
                >
                  {columns.map((c, i) => {
                    const v = r[c.column]
                    const n = delta.has(c.column) ? toNumber(v) : null
                    const num = c.format != null || isNum(v)
                    const base = `border-b border-line px-2.5 py-1.5 whitespace-nowrap ${rowBg} ${onRow ? 'group-hover:bg-primary-soft' : ''} ${i === 0 ? sticky0 : ''}`
                    if (n != null) {
                      return (
                        <td key={c.column} className={`${base} text-right tabular-nums ${deltaTone(n, encoding.trend)}`}>
                          {n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}
                          {formatValue(Math.abs(n), { format: c.format })}
                        </td>
                      )
                    }
                    return (
                      <td key={c.column} className={`${base} text-fg-2 ${num ? 'text-right tabular-nums' : ''}`}>
                        {c.format ? formatValue(v, { format: c.format }) : v == null ? '' : String(v)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-subtle">
                  {rows.length === 0 ? '暂无数据' : '没有符合条件的行'}
                </td>
              </tr>
            )}
          </tbody>
          {sumCols.length > 0 && visible.length > 0 && (
            <tfoot className="sticky bottom-0 z-[2]">
              <tr>
                {columns.map((c, i) => (
                  <td
                    key={c.column}
                    className={`bg-surface-2 border-t border-line px-2.5 py-1.5 whitespace-nowrap font-medium ${i === 0 ? sticky0 : ''} ${c.column in totals ? 'text-right tabular-nums text-fg' : 'text-muted'}`}
                  >
                    {c.column in totals ? formatValue(totals[c.column], { format: c.format }) : i === 0 ? (filtered ? '合计（筛选后）' : '合计') : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
