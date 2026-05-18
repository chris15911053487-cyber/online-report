import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { apiFetchReport } from '../utils/api'
import { getRowValue, reportColumnHeaderText } from '../utils/helpers'
import ReturnProPickDetail, { isReturnProRoute } from './ReturnProPickDetail'

export default function ReportRowDetailView() {
  const {
    reportDetailRouteKey: routeKey,
    reportDetailParams: params,
    reportDetailColumnLabels: columnLabels,
    reportDetailKey: detailKey,
    goBack,
    showToast,
  } = useStore()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, any>[]>([])
  const [truncated, setTruncated] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!routeKey) {
      setError('缺少报表配置')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError('')

    const effectiveDetailKey =
      detailKey ?? (params && typeof params === 'object' ? params.detailKey : undefined)

    apiFetchReport('/reports/detail', {
      method: 'POST',
      body: JSON.stringify({ routeKey, params, detailKey: effectiveDetailKey }),
    })
      .then((res) => {
        if (cancelled) return
        setColumns(res.columns ?? [])
        setRows(res.rows ?? (res.data ? [res.data] : []))
        setTruncated(!!res.truncated)
      })
      .catch((err: any) => {
        if (cancelled) return
        const msg = err?.message || '详情加载失败'
        setError(msg)
        showToast(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [routeKey, params, detailKey])

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-slate-400">加载中…</div>
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-2xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm whitespace-pre-wrap">
          {error}
        </div>
        <button onClick={goBack} className="mt-4 text-sky-600 underline text-sm">返回</button>
      </div>
    )
  }

  const effectiveDetailKeyForView =
    detailKey ?? (params && typeof params === 'object' ? params.detailKey : undefined)

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <p>无详情数据</p>
        <button onClick={goBack} className="mt-4 text-sky-600 underline text-sm">返回</button>
      </div>
    )
  }

  if (isReturnProRoute(routeKey)) {
    return (
      <ReturnProPickDetail
        rows={rows}
        columnLabels={columnLabels}
        detailKey={effectiveDetailKeyForView}
        truncated={truncated}
        goBack={goBack}
        showToast={showToast}
      />
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-6">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button onClick={goBack} className="text-sky-600 text-sm shrink-0">← 返回</button>
        <h2 className="text-base font-semibold truncate">行详情</h2>
      </div>

      {truncated && (
        <div className="mx-3 mt-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 px-3 py-2 text-xs">
          (结果已截断)
        </div>
      )}

      <div className="mx-3 mt-3 space-y-4">
        {rows.map((row, ri) => (
          <div key={ri} className="rounded-2xl bg-white shadow-sm border border-slate-100 overflow-hidden">
            {rows.length > 1 && (
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 text-xs font-medium text-slate-500">
                记录 {ri + 1}
              </div>
            )}
            <table className="w-full text-sm">
              <tbody>
                {columns.map((col, ci) => {
                  const val = getRowValue(row, col)
                  const label = reportColumnHeaderText(col, columnLabels)
                  const display = val == null || val === '' ? '—' : String(val)
                  return (
                    <tr key={ci} className={ci % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'}>
                      <th className="text-left px-4 py-2 text-slate-500 font-normal w-1/3 align-top whitespace-nowrap">
                        {label}
                      </th>
                      <td className="px-4 py-2 break-all">{display}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}
