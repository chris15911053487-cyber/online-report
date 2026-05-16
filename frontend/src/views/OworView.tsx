import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import { apiFetch, type ApiError } from '../utils/api'

interface OworRow {
  itemCode: string
  itemName: string
  frgnName: string
}

export default function OworView() {
  const showToast = useStore((s) => s.showToast)
  const logout = useStore((s) => s.logout)

  const [rows, setRows] = useState<OworRow[]>([])
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const touchStartY = useRef(0)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/owor')
      setRows(data.rows || [])
      setMeta(data.meta || {})
    } catch (e: unknown) {
      const err = e as ApiError
      setError(err.message || '加载失败')
      if (err.status === 401) logout()
    } finally {
      setLoading(false)
    }
  }, [logout])

  useEffect(() => { loadData() }, [loadData])

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    const dy = e.changedTouches[0].clientY - touchStartY.current
    if (window.scrollY <= 0 && dy > 60) {
      showToast('刷新中…')
      loadData()
    }
  }

  const emptyMessage = meta.database
    ? `暂无数据（当前连接库：${meta.database}）。请核对 .env 的 DB_NAME 是否与 SSMS 中查询 OITM 的数据库一致。`
    : '暂无数据'

  return (
    <div
      className="p-4 pb-24"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-800">生产订单</h2>
        <button
          type="button"
          className="text-sm text-sky-500 hover:text-sky-600"
          onClick={loadData}
        >
          刷新
        </button>
      </div>

      <p className="text-xs text-slate-400 mb-4 text-center">下拉刷新</p>

      {loading && <p className="text-slate-400 text-center py-12">加载中…</p>}
      {error && <p className="text-red-500 text-center py-4">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="text-slate-400 text-center py-12 text-sm leading-relaxed">
          {emptyMessage}
        </p>
      )}

      {rows.length > 0 && (
        <>
          {/* Card view (mobile-friendly) */}
          <div className="space-y-3 md:hidden">
            {rows.map((r, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500">物料编码</span>
                  <span className="text-sm font-medium text-sky-600 bg-sky-50 px-2 py-0.5 rounded">
                    {r.itemCode || '—'}
                  </span>
                </div>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">物料名称</dt>
                    <dd className="text-slate-800 text-right max-w-[60%] truncate">{r.itemName || '—'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">外文名称</dt>
                    <dd className="text-slate-800 text-right max-w-[60%] truncate">{r.frgnName || '—'}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          {/* Table view (desktop) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left py-2.5 px-3 font-medium text-slate-600">物料编码</th>
                  <th className="text-left py-2.5 px-3 font-medium text-slate-600">物料名称</th>
                  <th className="text-left py-2.5 px-3 font-medium text-slate-600">外文名称</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2 px-3 text-sky-600 font-medium">{r.itemCode || '—'}</td>
                    <td className="py-2 px-3 text-slate-800">{r.itemName || '—'}</td>
                    <td className="py-2 px-3 text-slate-600">{r.frgnName || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
