import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { batchStatusLabel, formatDuration } from '../utils/helpers'

interface BatchLine {
  lineId: number
  orderDoc?: string
  stepName?: string
  plannedQty?: number
  [k: string]: any
}

interface BatchData {
  id: number
  status: string
  totalWorkingSeconds: number
  lastActiveAt: string | null
  userCode?: string
  [k: string]: any
}

interface LineInput {
  goodQty: string
  scrapQty: string
  remark: string
}

export default function WorkRegistrationView() {
  const { workRegBatchId, user, showToast, goBack } = useStore()

  const [batch, setBatch] = useState<BatchData | null>(null)
  const [lines, setLines] = useState<BatchLine[]>([])
  const [lineInputs, setLineInputs] = useState<LineInput[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [acting, setActing] = useState(false)
  const [liveDuration, setLiveDuration] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchBatch = useCallback(async (silent = false) => {
    if (!workRegBatchId) return
    if (!silent) setLoading(true)
    try {
      const res = await apiFetch(`/pro-sign/batches/${workRegBatchId}`)
      if (!mountedRef.current) return
      const b: BatchData = res.batch ?? res
      const ls: BatchLine[] = res.lines ?? []
      setBatch(b)
      setLines(ls)
      if (lineInputs.length === 0 && ls.length > 0) {
        setLineInputs(ls.map(() => ({ goodQty: '', scrapQty: '0', remark: '' })))
      }
      setError('')
    } catch (err: any) {
      if (!mountedRef.current) return
      setError(err?.message || '加载失败')
    } finally {
      if (mountedRef.current && !silent) setLoading(false)
    }
  }, [workRegBatchId])

  useEffect(() => { fetchBatch() }, [fetchBatch])

  // Poll every 5s for status/duration updates
  useEffect(() => {
    if (!workRegBatchId) return
    const timer = setInterval(() => fetchBatch(true), 5000)
    return () => clearInterval(timer)
  }, [workRegBatchId, fetchBatch])

  // Live 1s timer when in_progress
  useEffect(() => {
    if (!batch) return

    const calcDuration = () => {
      let base = batch.totalWorkingSeconds || 0
      if (batch.status === 'in_progress' && batch.lastActiveAt) {
        const elapsed = (Date.now() - new Date(batch.lastActiveAt).getTime()) / 1000
        if (Number.isFinite(elapsed) && elapsed > 0) base += elapsed
      }
      return Math.floor(base)
    }

    setLiveDuration(calcDuration())

    if (batch.status !== 'in_progress') return
    const timer = setInterval(() => {
      if (mountedRef.current) setLiveDuration(calcDuration())
    }, 1000)
    return () => clearInterval(timer)
  }, [batch?.status, batch?.totalWorkingSeconds, batch?.lastActiveAt])

  const updateLine = useCallback((idx: number, field: keyof LineInput, val: string) => {
    setLineInputs((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: val }
      return next
    })
  }, [])

  const doAction = useCallback(async (action: string, body?: any) => {
    if (acting || !workRegBatchId) return
    setActing(true)
    try {
      await apiFetch(`/pro-sign/batches/${workRegBatchId}/${action}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!mountedRef.current) return
      showToast('操作成功')
      await fetchBatch(true)
    } catch (err: any) {
      if (mountedRef.current) showToast(err?.message || '操作失败')
    } finally {
      if (mountedRef.current) setActing(false)
    }
  }, [acting, workRegBatchId, showToast, fetchBatch])

  const handleAccept = useCallback(() => doAction('accept'), [doAction])
  const handleResume = useCallback(() => doAction('resume'), [doAction])

  const handlePause = useCallback(() => {
    const reason = prompt('请输入暂停原因：')
    if (reason == null) return
    doAction('pause', { reason })
  }, [doAction])

  const handleSubmit = useCallback(async () => {
    const collected = lineInputs.map((inp, i) => ({
      lineId: lines[i]?.lineId,
      goodQty: parseFloat(inp.goodQty) || 0,
      scrapQty: parseFloat(inp.scrapQty) || 0,
      remark: inp.remark,
    }))

    if (!collected.some((l) => l.goodQty > 0)) {
      showToast('请至少填写一行良品数量')
      return
    }

    if (acting) return
    setActing(true)
    try {
      await apiFetch(`/pro-sign/batches/${workRegBatchId}/submit`, {
        method: 'POST',
        body: JSON.stringify({ lines: collected }),
      })
      if (!mountedRef.current) return
      showToast('报工提交成功')
      goBack()
    } catch (err: any) {
      if (mountedRef.current) showToast(err?.message || '提交失败')
    } finally {
      if (mountedRef.current) setActing(false)
    }
  }, [lineInputs, lines, acting, workRegBatchId, showToast, goBack])

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-slate-400">加载中…</div>
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <div className="rounded-2xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm whitespace-pre-wrap">
          {error}
        </div>
        <button onClick={goBack} className="mt-4 text-sky-600 underline text-sm">返回</button>
      </div>
    )
  }

  const status = batch?.status ?? ''

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 pb-4">
      {/* Header */}
      <div className="m-3 rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
        <h2 className="text-base font-semibold mb-2">报工登记</h2>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          <span>账号：{user?.username || '—'}</span>
          <span>状态：
            <span className={
              status === 'in_progress' ? 'text-emerald-600 font-medium'
              : status === 'paused' ? 'text-amber-600 font-medium'
              : ''
            }>
              {batchStatusLabel(status)}
            </span>
          </span>
          <span>累计工时：<span className="font-mono">{formatDuration(liveDuration)}</span></span>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 mt-3">
          {status === 'pending' && (
            <button
              disabled={acting}
              onClick={handleAccept}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium active:bg-emerald-700 disabled:opacity-50"
            >
              接单开工
            </button>
          )}
          {status === 'in_progress' && (
            <button
              disabled={acting}
              onClick={handlePause}
              className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-medium active:bg-amber-600 disabled:opacity-50"
            >
              暂停
            </button>
          )}
          {status === 'paused' && (
            <button
              disabled={acting}
              onClick={handleResume}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium active:bg-emerald-700 disabled:opacity-50"
            >
              继续开工
            </button>
          )}
          {(status === 'in_progress' || status === 'paused') && (
            <button
              disabled={acting}
              onClick={handleSubmit}
              className="px-4 py-2 rounded-xl bg-sky-600 text-white text-sm font-medium active:bg-sky-700 disabled:opacity-50"
            >
              提交报工
            </button>
          )}
        </div>
      </div>

      {/* Lines table */}
      <div className="mx-3 overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-100 text-slate-600">
              <th className="text-left px-3 py-2 rounded-tl-xl">订单</th>
              <th className="text-left px-3 py-2">工序</th>
              <th className="text-center px-3 py-2">良品</th>
              <th className="text-center px-3 py-2">不良</th>
              <th className="text-left px-3 py-2 rounded-tr-xl">备注</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => (
              <tr key={line.lineId ?? idx} className="border-b border-slate-100 bg-white">
                <td className="px-3 py-2 whitespace-nowrap">{line.orderDoc ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{line.stepName ?? '—'}</td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    value={lineInputs[idx]?.goodQty ?? ''}
                    onChange={(e) => updateLine(idx, 'goodQty', e.target.value)}
                    placeholder="0"
                    className="w-20 border border-slate-200 rounded-lg px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-sky-300"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    value={lineInputs[idx]?.scrapQty ?? '0'}
                    onChange={(e) => updateLine(idx, 'scrapQty', e.target.value)}
                    className="w-20 border border-slate-200 rounded-lg px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-sky-300"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={lineInputs[idx]?.remark ?? ''}
                    onChange={(e) => updateLine(idx, 'remark', e.target.value)}
                    placeholder=""
                    className="w-full min-w-[80px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-sky-300"
                  />
                </td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-slate-400">暂无明细</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
