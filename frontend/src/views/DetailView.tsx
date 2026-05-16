import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import { apiFetch, type ApiError } from '../utils/api'
import { statusLabel } from '../utils/helpers'

interface Order {
  orderNo: string
  productName: string
  plannedQty: number
  reportedQty: number
  status: string
}

interface Operation {
  id: number
  seqNo: number
  operationName: string
}

interface RecentReport {
  goodQty: number
  scrapQty: number
  reporterName: string
  reportedAt: string
}

export default function DetailView() {
  const currentOrderId = useStore((s) => s.currentOrderId)
  const showToast = useStore((s) => s.showToast)
  const logout = useStore((s) => s.logout)
  const navigateTo = useStore((s) => s.navigateTo)

  const [order, setOrder] = useState<Order | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [recentReports, setRecentReports] = useState<RecentReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedOpId, setSelectedOpId] = useState<number | null>(null)
  const [goodQty, setGoodQty] = useState('')
  const [scrapQty, setScrapQty] = useState('0')
  const [remark, setRemark] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const loadDetail = useCallback(async () => {
    if (!currentOrderId) return
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch(`/orders/${currentOrderId}`)
      setOrder(data.order)
      const ops = data.operations || []
      setOperations(ops)
      if (ops.length > 0) setSelectedOpId(ops[0].id)
      setRecentReports(data.recentReports || [])
    } catch (e: unknown) {
      const err = e as ApiError
      setError(err.message || '加载失败')
      if (err.status === 401) logout()
    } finally {
      setLoading(false)
    }
  }, [currentOrderId, logout])

  useEffect(() => { loadDetail() }, [loadDetail])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError('')

    const good = parseFloat(goodQty)
    if (!isFinite(good) || good <= 0) {
      setSubmitError('请填写大于 0 的良品数量')
      return
    }

    const scrap = parseFloat(scrapQty || '0')
    const body: Record<string, any> = {
      goodQty: good,
      scrapQty: isFinite(scrap) ? scrap : 0,
      remark,
    }
    if (selectedOpId != null) body.operationId = selectedOpId

    setSubmitting(true)
    try {
      await apiFetch(`/orders/${currentOrderId}/report`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      showToast('报工已提交')
      navigateTo('orders')
    } catch (e: any) {
      setSubmitError(e.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!currentOrderId) {
    return (
      <div className="p-4 text-center text-slate-400 py-12">
        未选择订单
      </div>
    )
  }

  const STATUS_COLORS: Record<string, string> = {
    open: 'bg-slate-100 text-slate-600',
    in_progress: 'bg-amber-100 text-amber-700',
    completed: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-red-100 text-red-600',
  }

  return (
    <div className="p-4 pb-24 max-w-2xl mx-auto">
      {loading && <p className="text-slate-400 text-center py-12">加载中…</p>}
      {error && <p className="text-red-500 text-center py-4">{error}</p>}

      {order && (
        <>
          {/* Order header */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-slate-800">{order.orderNo}</h2>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-600'}`}>
                {statusLabel(order.status)}
              </span>
            </div>
            <div className="text-sm text-slate-600 mb-1">{order.productName || '—'}</div>
            <div className="text-xs text-slate-400">
              计划 {order.plannedQty} · 已报 {order.reportedQty}
            </div>
          </div>

          {/* Operations */}
          {operations.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-slate-600 mb-2">工序选择</h3>
              <div className="flex flex-wrap gap-2">
                {operations.map((op) => (
                  <button
                    key={op.id}
                    type="button"
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      selectedOpId === op.id
                        ? 'bg-sky-500 text-white border-sky-500'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-sky-300'
                    }`}
                    onClick={() => setSelectedOpId(op.id)}
                  >
                    {op.seqNo}. {op.operationName || ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Report form */}
          <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4 space-y-3">
            <h3 className="font-semibold text-slate-700">报工提交</h3>

            <label className="block">
              <span className="block text-sm font-medium text-slate-600 mb-1">
                良品数量 <span className="text-red-400">*</span>
              </span>
              <input
                type="number"
                step="any"
                min="0"
                required
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none"
                value={goodQty}
                onChange={(e) => setGoodQty(e.target.value)}
                placeholder="请输入良品数量"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-slate-600 mb-1">不良数量</span>
              <input
                type="number"
                step="any"
                min="0"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none"
                value={scrapQty}
                onChange={(e) => setScrapQty(e.target.value)}
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-slate-600 mb-1">备注</span>
              <textarea
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm min-h-[60px] focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="选填"
              />
            </label>

            {submitError && <p className="text-red-500 text-sm">{submitError}</p>}

            <button
              type="submit"
              className="w-full py-2.5 text-sm rounded-lg bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50 font-medium"
              disabled={submitting}
            >
              {submitting ? '提交中…' : '提交报工'}
            </button>
          </form>

          {/* Recent reports */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <h3 className="font-semibold text-slate-700 mb-3">近期报工记录</h3>
            {recentReports.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">暂无报工记录</p>
            ) : (
              <ul className="space-y-2.5">
                {recentReports.map((r, i) => (
                  <li key={i} className="border-b border-slate-100 last:border-0 pb-2 last:pb-0">
                    <div className="text-sm text-slate-800">
                      良 {r.goodQty} / 不良 {r.scrapQty} · {r.reporterName || ''}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">{r.reportedAt || ''}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
