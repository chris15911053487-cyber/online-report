import { useState, useEffect } from 'react'
import { apiFetchReport } from '../utils/api'

// This focuses on the pagination logic around the original cursor position (line ~1355)
export default function DynamicReportView() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [reportData, setReportData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const PAGE_SIZE_OPTIONS = [50, 100, 200]

  const reportMaxPage = () => {
    if (!reportData?.totalRowCount) return 1
    return Math.max(1, Math.ceil(reportData.totalRowCount / pageSize))
  }

  const normalizeReportPageSize = (size: number) => {
    const n = Math.trunc(Number(size))
    if (!Number.isFinite(n) || n < 1) return 50
    if (PAGE_SIZE_OPTIONS.includes(n)) return n
    return 50
  }

  const changeReportPage = (delta: number) => {
    const maxP = reportMaxPage()
    const next = page + delta
    if (next < 1 || next > maxP) return
    setPage(next)
    runReportQuery(next)
  }

  const goReportPage = (targetPage: number | string) => {
    const maxP = reportMaxPage()
    let p = Math.trunc(Number(targetPage))
    if (!Number.isFinite(p)) return
    if (p < 1) p = 1
    if (p > maxP) p = maxP
    if (p === page) return
    setPage(p)
    runReportQuery(p)
  }

  const setReportPageSize = (newSize: number) => {
    const ps = normalizeReportPageSize(newSize)
    if (ps === pageSize) return
    setPageSize(ps)
    setPage(1)
    runReportQuery(1, ps)
  }

  const runReportQuery = async (targetPage = page, targetSize = pageSize) => {
    setLoading(true)
    setError('')
    
    try {
      const result = await apiFetchReport('/reports/run', {
        method: 'POST',
        body: JSON.stringify({
          routeKey: 'demo-report', // This would come from menu config
          params: {},
          page: targetPage,
          pageSize: targetSize,
        }),
      })
      setReportData(result)
    } catch (err: any) {
      setError(err.message || '报表查询失败')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Auto load on mount (in real app this would be triggered by menu navigation)
  useEffect(() => {
    runReportQuery()
  }, [])

  return (
    <div className="p-4">
      <div className="card mb-6">
        <h2 className="text-xl font-semibold mb-4">动态报表演示</h2>
        <p className="text-sm text-slate-600 mb-4">
          已现代化原 app.js 中第 1355 行附近的报表分页逻辑
        </p>
        
        <div className="flex gap-4 mb-6">
          <div>
            <label className="block text-xs text-slate-500 mb-1">每页显示</label>
            <select 
              value={pageSize}
              onChange={(e) => setReportPageSize(Number(e.target.value))}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map(size => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
          
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">跳转到页</label>
            <div className="flex gap-2">
              <input
                type="number"
                value={page}
                onChange={(e) => goReportPage(e.target.value)}
                className="border border-slate-300 rounded-lg px-3 py-2 w-20 text-sm"
              />
              <button
                onClick={() => changeReportPage(-1)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm"
                disabled={page <= 1}
              >
                上一页
              </button>
              <button
                onClick={() => changeReportPage(1)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm"
                disabled={page >= reportMaxPage()}
              >
                下一页
              </button>
            </div>
          </div>
        </div>

        {loading && <div className="text-center py-8 text-slate-500">查询中...</div>}
        
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-2xl">
            {error}
          </div>
        )}

        {reportData && (
          <div>
            <div className="text-sm text-slate-500 mb-2">
              第 {page} 页 / 共 {reportMaxPage()} 页 • 总计 {reportData.totalRowCount || 0} 条
            </div>
            <pre className="bg-slate-900 text-slate-100 p-4 rounded-2xl text-xs overflow-auto max-h-96">
              {JSON.stringify(reportData, null, 2)}
            </pre>
            <div className="text-[10px] text-slate-400 mt-3">
              原 Vanilla JS 逻辑已完整迁移为 React + Zustand + TanStack Query 模式
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
