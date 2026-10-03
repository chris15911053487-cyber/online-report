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
  open: 'bg-surface-2 text-fg-2',
  in_progress: 'bg-warning-soft text-warning',
  completed: 'bg-success-soft text-success',
  cancelled: 'bg-danger-soft text-danger',
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
        <h2 className="text-xl font-semibold text-fg">报工订单</h2>
        <button
          type="button"
          className="text-sm text-primary hover:text-primary"
          onClick={loadOrders}
        >
          刷新
        </button>
      </div>

      <p className="text-xs text-subtle mb-4 text-center">下拉刷新</p>

      {loading && <p className="text-subtle text-center py-12">加载中…</p>}
      {error && <p className="text-danger text-center py-4">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="text-subtle text-center py-12">暂无生产订单</p>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="w-full bg-surface rounded-xl border border-line shadow-sm p-4 text-left hover:border-primary/25 hover:shadow-md transition-all active:scale-[0.98]"
            onClick={() => openOrderDetail(item.id)}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-medium text-fg">{item.orderNo}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[item.status] || 'bg-surface-2 text-fg-2'}`}>
                {statusLabel(item.status)}
              </span>
            </div>
            <div className="text-sm text-fg-2 mb-1">{item.productName || '—'}</div>
            <div className="text-xs text-subtle">
              计划 {item.plannedQty} · 已报 {item.reportedQty}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
