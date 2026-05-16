import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import { apiFetch, type ApiError } from '../utils/api'
import { statusLabel } from '../utils/helpers'

interface OrderItem {
  id: number
  orderNo: string
  status: string
  productName: string
  plannedQty: number
  reportedQty: number
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-600',
}

export default function OrdersView() {
  const showToast = useStore((s) => s.showToast)
  const logout = useStore((s) => s.logout)
  const openOrderDetail = useStore((s) => s.openOrderDetail)

  const [items, setItems] = useState<OrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const touchStartY = useRef(0)

  const loadOrders = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/orders')
      setItems(data.items || [])
    } catch (e: unknown) {
      const err = e as ApiError
      if (err.status === 401) logout()
      else setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [logout])

  useEffect(() => { loadOrders() }, [loadOrders])

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    const dy = e.changedTouches[0].clientY - touchStartY.current
    if (window.scrollY <= 0 && dy > 60) {
      showToast('刷新中…')
      loadOrders()
    }
  }

  return (
    <div
      className="p-4 pb-24"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-800">报工订单</h2>
        <button
          type="button"
          className="text-sm text-sky-500 hover:text-sky-600"
          onClick={loadOrders}
        >
          刷新
        </button>
      </div>

      <p className="text-xs text-slate-400 mb-4 text-center">下拉刷新</p>

      {loading && <p className="text-slate-400 text-center py-12">加载中…</p>}
      {error && <p className="text-red-500 text-center py-4">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="text-slate-400 text-center py-12">暂无生产订单</p>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="w-full bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-left hover:border-sky-200 hover:shadow-md transition-all active:scale-[0.98]"
            onClick={() => openOrderDetail(item.id)}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-medium text-slate-800">{item.orderNo}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[item.status] || 'bg-slate-100 text-slate-600'}`}>
                {statusLabel(item.status)}
              </span>
            </div>
            <div className="text-sm text-slate-600 mb-1">{item.productName || '—'}</div>
            <div className="text-xs text-slate-400">
              计划 {item.plannedQty} · 已报 {item.reportedQty}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
