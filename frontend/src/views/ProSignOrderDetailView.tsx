import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { getRowValue, reportColumnHeaderText } from '../utils/helpers'

type DetailTable = {
  index?: number
  columns: string[]
  rows: Record<string, any>[]
}

export default function ProSignOrderDetailView() {
  const { proSignOrderDetailOrderNo, activeMenu, user, goBack, showToast } = useStore()

  const orderNo = proSignOrderDetailOrderNo || ''

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
      <div className="p-4 text-center">
        <div className="rounded-2xl bg-danger-soft border border-danger/25 text-danger p-4 text-sm whitespace-pre-wrap inline-block text-left">
          {error}
        </div>
        <button
          onClick={goBack}
          className="mt-4 text-primary underline text-sm"
          type="button"
        >
          返回
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface-2 pb-6">
      <div className="sticky top-0 z-10 bg-surface border-b border-line px-4 py-3 flex items-center gap-3">
        <button onClick={goBack} className="text-primary text-sm shrink-0" type="button">
          ← 返回
        </button>
        <h2 className="text-base font-semibold truncate">订单详情</h2>
      </div>

      <div className="px-4 py-3">
        <div className="text-sm text-fg-2 mb-3">
          订单号：<span className="font-mono">{orderNo || '—'}</span>
        </div>

        {tables.length === 0 ? (
          <div className="text-center text-subtle py-10 text-sm">无详情数据</div>
        ) : (
          <div className="space-y-4">
            {tables.map((t, i) => {
              const cols = Array.isArray(t.columns) ? t.columns : []
              const rows = Array.isArray(t.rows) ? t.rows : []
              return (
                <div
                  key={i}
                  className="rounded-2xl bg-surface shadow-sm border border-line overflow-hidden"
                >
                  <div className="px-4 py-2 bg-surface-2 border-b border-line text-xs font-medium text-muted">
                    {t.index != null ? `表 ${t.index}` : `表 ${i + 1}`}
                  </div>

                  {rows.length === 0 || cols.length === 0 ? (
                    <div className="p-4 text-center text-subtle text-sm">无数据</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-surface border-b border-line">
                            {cols.map((c) => (
                              <th
                                key={c}
                                className="text-left px-3 py-2 text-xs font-semibold text-fg-2 whitespace-nowrap"
                              >
                                {reportColumnHeaderText(c, {})}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, ri) => (
                            <tr key={ri} className={ri % 2 === 0 ? 'bg-surface' : 'bg-surface-2/60'}>
                              {cols.map((c, ci) => {
                                const v = getRowValue(r, c)
                                const d = v == null || v === '' ? '—' : String(v)
                                return (
                                  <td key={ci} className="px-3 py-2 break-all">
                                    {d}
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

