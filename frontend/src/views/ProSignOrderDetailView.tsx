import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { reportColumnHeaderText } from '../utils/helpers'
import { useIsPc } from '../hooks/useMediaQuery'
import { Badge, Card, EmptyState, Notice } from '../ui'
import { cn, tableClass, tdClass, thClass } from '../ui/classes'
import {
  type DetailTable,
  detailTableTitle,
  formatDetailValue,
  isNumericColumn,
  splitCardColumns,
  visibleColumns,
} from '../utils/detailTables'

export default function ProSignOrderDetailView() {
  const { proSignOrderDetailOrderNo, activeMenu, user, goBack, showToast } = useStore()

  const orderNo = proSignOrderDetailOrderNo || ''
  const labels = activeMenu?.columnLabels ?? {}
  const isPc = useIsPc()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tables, setTables] = useState<DetailTable[]>([])

  const routeKey = useMemo(() => {
    return (activeMenu?.routeKey ? String(activeMenu.routeKey) : 'pro-sign').trim().toLowerCase()
  }, [activeMenu?.routeKey])

  const detailKeyParam = useMemo(() => {
    const raw = activeMenu?.detailKeyParam != null ? String(activeMenu.detailKeyParam).trim() : ''
    return raw || 'OrderNo'
  }, [activeMenu?.detailKeyParam])

  const loginUser = useMemo(() => {
    return user?.username ? String(user.username).trim() : ''
  }, [user?.username])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      setTables([])

      if (!orderNo) {
        setError('缺少订单号')
        setLoading(false)
        return
      }
      if (!loginUser) {
        setError('缺少登录信息')
        setLoading(false)
        return
      }

      try {
        const data = await apiFetch('/pro-sign/order-detail', {
          method: 'POST',
          body: JSON.stringify({
            routeKey,
            params: { [detailKeyParam]: orderNo },
          }),
        })

        const t: DetailTable[] = (data?.tables && Array.isArray(data.tables) ? data.tables : []) as any
        if (!cancelled) setTables(t)
      } catch (e: any) {
        if (cancelled) return
        const msg = e?.message || '加载失败'
        setError(msg)
        showToast(msg)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [orderNo, routeKey, detailKeyParam, loginUser, showToast])

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-subtle">加载中…</div>
  }

  if (error) {
    return (
      <div className="px-4 py-4 lg:px-6 max-w-2xl">
        <Notice tone="danger" className="whitespace-pre-wrap">{error}</Notice>
        <button onClick={goBack} className="mt-4 text-primary underline text-sm" type="button">
          返回
        </button>
      </div>
    )
  }

  const label = (c: string) => reportColumnHeaderText(c, labels)

  return (
    <div className="px-3 py-3 lg:px-6 lg:py-5 space-y-3 lg:space-y-4 pb-8">
      <div className="flex items-baseline gap-2 px-1">
        <span className="text-xs text-muted">订单号</span>
        <span className="font-display text-lg font-semibold text-fg num break-all">{orderNo || '—'}</span>
      </div>

      {tables.length === 0 || tables.every((t) => !t.rows?.length) ? (
        <Card><EmptyState title="无详情数据" /></Card>
      ) : (
        tables.map((t, i) => {
          const rows = Array.isArray(t.rows) ? t.rows : []
          if (rows.length === 0) return null
          const cols = visibleColumns(t)
          const title = detailTableTitle(t, i)
          return (
            <Card key={t.index ?? i} className="overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line">
                <h3 className="text-sm font-semibold text-fg">{title}</h3>
                {rows.length > 1 && <Badge>{rows.length} 条</Badge>}
              </div>
              {rows.length === 1 ? (
                <FieldGrid row={rows[0]} cols={cols} label={label} skipValue={orderNo} />
              ) : isPc ? (
                <RowsTable rows={rows} cols={cols} label={label} />
              ) : (
                <RowCards rows={rows} cols={cols} label={label} />
              )}
            </Card>
          )
        })
      )}
    </div>
  )
}

type LabelFn = (c: string) => string

/** 单行结果：字段名在上、值在下的网格；长文本占整行，空值不显示 */
function FieldGrid({ row, cols, label, skipValue }: { row: Record<string, unknown>; cols: string[]; label: LabelFn; /** 页头已显示的值（订单号）不再重复 */ skipValue?: string }) {
  const items = cols
    .map((c) => ({ c, v: formatDetailValue(row[c]) }))
    .filter((x) => x.v !== '' && x.v !== skipValue)
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 px-4 py-3">
      {items.map(({ c, v }) => (
        <div key={c} className={cn('min-w-0', v.length > 24 && 'col-span-2')}>
          <dt className="text-xs text-muted">{label(c)}</dt>
          <dd className="mt-0.5 text-sm text-fg break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 多行结果（PC）：表格，表头吸顶，数字列右对齐 */
function RowsTable({ rows, cols, label }: { rows: Record<string, unknown>[]; cols: string[]; label: LabelFn }) {
  const numeric = new Set(cols.filter((c) => isNumericColumn(c, rows)))
  return (
    <div className="overflow-auto max-h-[70vh]">
      <table className={tableClass}>
        <thead className="sticky top-0 z-[1]">
          <tr>
            {cols.map((c) => (
              <th key={c} className={cn(thClass, numeric.has(c) && 'text-right')}>{label(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="hover:bg-surface-2/60">
              {cols.map((c) => (
                <td key={c} className={cn(tdClass, 'whitespace-nowrap', numeric.has(c) && 'text-right num')}>
                  {formatDetailValue(r[c]) || <span className="text-subtle">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 多行结果（手机）：每行一张小卡——抬头（编码 / 名称 / 规格）、数量区、其余字段；空值不显示 */
function RowCards({ rows, cols, label }: { rows: Record<string, unknown>[]; cols: string[]; label: LabelFn }) {
  const { lead, nums, others } = splitCardColumns(cols, rows)
  // 一个文本列：直接作标题；两个以上：第一列（编码）小字在上，第二列（名称）作标题，其余跟在后面
  const [codeCol, nameCol, ...subCols] = lead.length === 1 ? [undefined, lead[0]] : lead
  return (
    <div className="divide-y divide-line">
      {rows.map((row, ri) => {
        const v = (c?: string) => (c ? formatDetailValue(row[c]) : '')
        const sub = subCols.map(v).filter(Boolean).join(' · ')
        const rest = others.map((c) => ({ c, v: v(c) })).filter((x) => x.v !== '')
        return (
          <div key={ri} className="px-4 py-3">
            {v(codeCol) && <div className="text-xs text-muted num break-all">{v(codeCol)}</div>}
            {v(nameCol) && <div className="text-sm font-medium text-fg break-words">{v(nameCol)}</div>}
            {sub && <div className="text-xs text-muted mt-0.5 break-words">{sub}</div>}
            {nums.length > 0 && (
              <dl className="mt-2 grid grid-cols-3 gap-2 rounded-lg bg-surface-2 px-3 py-2">
                {nums.map((c) => (
                  <div key={c} className="min-w-0">
                    <dt className="text-[11px] text-muted truncate">{label(c)}</dt>
                    <dd className="num text-base font-semibold text-fg">{v(c) || '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
            {rest.length > 0 && (
              <dl className="mt-2 space-y-1">
                {rest.map(({ c, v: val }) => (
                  <div key={c} className="flex gap-2 text-xs">
                    <dt className="text-muted shrink-0">{label(c)}</dt>
                    <dd className="text-fg-2 break-words min-w-0">{val}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )
      })}
    </div>
  )
}
