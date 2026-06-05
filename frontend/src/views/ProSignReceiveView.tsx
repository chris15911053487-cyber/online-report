import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { proSignDefaultOperatorCodes, proSignLineDisplay, pad2 } from '../utils/helpers'
import ReportOverlay from '../components/ReportOverlay'

interface Operator {
  code: string
  name: string
}

interface LineEntry {
  baseEntry: string
  baseOType: string
  baseOEntry: string
  baseOLine: string
  gxLineId: string
  stepCode: string
  stepName: string
  quantity: number
  lastStepCode: string
  lastStepName: string
  lastStepTimeLabel: string
  lastStepTimeIso: string | null
  pc: string
  itemName: string
}

function nowLabel() {
  const d = new Date()
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  )
}

export default function ProSignReceiveView() {
  const {
    proSignMergeItems: mergeItems,
    proSignLineResults: lineResults,
    proSignMergeButtonLabel,
    user,
    showToast,
    goBack,
  } = useStore()

  const [clock, setClock] = useState(nowLabel)
  const [operators, setOperators] = useState<Operator[]>([])
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(() => {
    const codes = proSignDefaultOperatorCodes(lineResults, user?.username)
    return new Set(codes)
  })
  const [operatorSearch, setOperatorSearch] = useState('')
  const [quantities, setQuantities] = useState<number[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [showPausePreview, setShowPausePreview] = useState(false)
  const [pauseRemarks, setPauseRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [pauseSaving, setPauseSaving] = useState(false)
  const mountedRef = useRef(true)

  const items = mergeItems ?? []
  const results = lineResults ?? []

  const lines: LineEntry[] = items.map((mi, i) => proSignLineDisplay(mi, results[i]))
  const headerLine = lines[0]

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setClock(nowLabel()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (lines.length > 0 && quantities.length === 0) {
      setQuantities(lines.map((l) => l.quantity))
    }
  }, [lines.length])

  useEffect(() => {
    let cancelled = false
    apiFetch('/pro-sign/online-sign-operators')
      .then((res) => {
        if (!cancelled) setOperators(res?.data?.operators ?? res?.operators ?? [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const toggleOperator = useCallback((code: string) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }, [])

  const selectOnlySelf = useCallback(() => {
    const s = new Set<string>()
    if (user?.username) s.add(user.username)
    setSelectedCodes(s)
  }, [user?.username])

  /** 预检带回的操作员可能不在 X_ONLINE_VIEW_OHEM，仍须展示为可选项 */
  const operatorChoices = useMemo(() => {
    const map = new Map<string, Operator>()
    for (const op of operators) map.set(op.code, op)
    for (const code of selectedCodes) {
      if (!map.has(code)) map.set(code, { code, name: '（上一环节）' })
    }
    return Array.from(map.values())
  }, [operators, selectedCodes])

  const filteredOperators = operatorChoices.filter((op) => {
    if (!operatorSearch) return true
    const q = operatorSearch.toLowerCase()
    return op.code.toLowerCase().includes(q) || op.name.toLowerCase().includes(q)
  })

  const updateQty = useCallback((idx: number, val: string) => {
    const n = parseFloat(val)
    setQuantities((prev) => {
      const next = [...prev]
      next[idx] = Number.isFinite(n) ? n : 0
      return next
    })
  }, [])

  const operatorCodesArr = Array.from(selectedCodes)
  const selectedSummary =
    selectedCodes.size > 0
      ? `已选 ${selectedCodes.size} 人：${operatorCodesArr.join('、')}`
      : '未勾选人员；保存时将默认使用当前登录账号'

  const signType =
    proSignMergeButtonLabel === '接单'
      ? '接单'
      : proSignMergeButtonLabel === '完工'
        ? '完工'
        : proSignMergeButtonLabel === '恢复报工'
          ? '恢复报工'
          : '合并报工'

  /** Status=1：主按钮「完工」+ 副按钮「暂停报工」 */
  const isCompletionFlow = signType === '完工'
  /** Status=8：仅「恢复报工」主按钮 */
  const isResumeFlow = signType === '恢复报工'

  const buildOnlineSignBody = useCallback(
    (signTypeForSave: string, remarksStr: string) => {
      const signAt = nowLabel()
      const finalOperators =
        operatorCodesArr.length > 0
          ? operatorCodesArr
          : user?.username
            ? [user.username]
            : []

      return {
        remarks: remarksStr.trim().slice(0, 500),
        stepCode: headerLine?.stepCode ?? '',
        stepName: headerLine?.stepName ?? '',
        operatorCodes: finalOperators,
        signType: signTypeForSave,
        signAt,
        lines: lines.map((l, i) => ({
          baseEntry: l.baseEntry,
          baseOType: l.baseOType === '—' ? '' : l.baseOType,
          baseOEntry: l.baseOEntry === '—' ? '' : l.baseOEntry,
          baseOLine: l.baseOLine === '—' ? '' : l.baseOLine,
          gxLineId: l.gxLineId === '—' ? '' : l.gxLineId,
          quantity: quantities[i] ?? l.quantity,
          lastStepCode: l.lastStepCode === '—' ? '' : l.lastStepCode,
          lastStepName: l.lastStepName === '—' ? '' : l.lastStepName,
          lastStepTime: l.lastStepTimeIso ?? '',
          pc: l.pc,
          itemName: l.itemName === '—' ? '' : l.itemName,
        })),
      }
    },
    [operatorCodesArr, user, headerLine, lines, quantities],
  )

  const handleConfirmSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    const body = buildOnlineSignBody(signType, '')

    try {
      await apiFetch('/pro-sign/online-sign-save', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!mountedRef.current) return
      showToast('保存成功')
      setShowPreview(false)
      goBack()
    } catch (err: any) {
      if (!mountedRef.current) return
      showToast(err?.message || '保存失败')
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [saving, buildOnlineSignBody, signType, showToast, goBack])

  const handleConfirmPause = useCallback(async () => {
    if (pauseSaving) return
    setPauseSaving(true)
    const body = buildOnlineSignBody('暂停报工', pauseRemarks)

    try {
      await apiFetch('/pro-sign/online-sign-save', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!mountedRef.current) return
      showToast('已暂停报工')
      setShowPausePreview(false)
      setPauseRemarks('')
      goBack()
    } catch (err: any) {
      if (!mountedRef.current) return
      showToast(err?.message || '暂停报工保存失败')
    } finally {
      if (mountedRef.current) setPauseSaving(false)
    }
  }, [pauseSaving, buildOnlineSignBody, pauseRemarks, showToast, goBack])

  if (!items.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <p>无合并报工数据</p>
        <button onClick={goBack} className="mt-4 text-sky-600 underline text-sm">返回</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 pb-20">
      {/* Header card */}
      <div className="m-3 rounded-2xl bg-white shadow-sm border border-slate-100 p-4 space-y-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span><span className="text-slate-500">工序编码：</span>{headerLine?.stepCode}</span>
          <span><span className="text-slate-500">工序名称：</span>{headerLine?.stepName}</span>
        </div>
        <div className="text-sm">
          <span className="text-slate-500">当前时间：</span>
          <span className="font-mono">{clock}</span>
        </div>

        {/* Operator picker */}
        <div className="text-sm">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-slate-500 shrink-0">当前操作员：</span>
            <button
              onClick={selectOnlySelf}
              className="text-xs px-2 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200 active:bg-sky-100"
            >
              仅本人
            </button>
          </div>
          <input
            type="text"
            placeholder="搜索编码/姓名…"
            value={operatorSearch}
            onChange={(e) => setOperatorSearch(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-sky-300"
          />
          <div className="max-h-36 overflow-y-auto border border-slate-100 rounded-lg">
            {filteredOperators.length === 0 && (
              <div className="px-3 py-2 text-slate-400 text-xs">无匹配人员</div>
            )}
            {filteredOperators.map((op) => (
              <label
                key={op.code}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedCodes.has(op.code)}
                  onChange={() => toggleOperator(op.code)}
                  className="accent-sky-600"
                />
                <span>{op.code}</span>
                <span className="text-slate-400">{op.name}</span>
              </label>
            ))}
          </div>
          <div className="mt-1 text-xs text-slate-500">{selectedSummary}</div>
        </div>
      </div>

      {/* Line items */}
      <div className="mx-3 space-y-3">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4"
          >
            <h3 className="font-medium text-sm mb-2">
              第 {idx + 1} 条 · 工单 {line.baseEntry}
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600">
              <span>来源类型：{line.baseOType}</span>
              <span>来源单号：{line.baseOEntry}</span>
              <span>来源行号：{line.baseOLine}</span>
              <span>工序行号：{line.gxLineId}</span>
              <span>批次：{line.pc || '—'}</span>
              <span>物料名称：{line.itemName}</span>
              <span>上道工序编码：{line.lastStepCode}</span>
              <span>上道工序名称：{line.lastStepName}</span>
              <span className="col-span-2">上道工序时间：{line.lastStepTimeLabel}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm">
              <label className="text-slate-500 shrink-0">数量：</label>
              <input
                type="number"
                value={quantities[idx] ?? line.quantity}
                onChange={(e) => updateQty(idx, e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 w-28 focus:outline-none focus:ring-1 focus:ring-sky-300"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Sticky save buttons */}
      <div className="fixed bottom-0 inset-x-0 p-3 bg-white/90 backdrop-blur border-t border-slate-100 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex gap-2">
          {isCompletionFlow && (
            <button
              type="button"
              onClick={() => setShowPausePreview(true)}
              disabled={saving || pauseSaving}
              className="flex-1 py-3 rounded-xl border-2 border-amber-500 text-amber-800 bg-amber-50 font-medium active:bg-amber-100 transition-colors disabled:opacity-50"
            >
              暂停报工
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowPreview(true)}
            disabled={saving || pauseSaving}
            className={`py-3 rounded-xl font-medium transition-colors disabled:opacity-50 ${
              isCompletionFlow ? 'flex-1' : 'w-full'
            } ${
              isResumeFlow
                ? 'bg-emerald-600 text-white active:bg-emerald-700'
                : 'bg-sky-600 text-white active:bg-sky-700'
            }`}
          >
            {proSignMergeButtonLabel || '合并报工'}
          </button>
        </div>
      </div>

      {/* Pause confirm overlay */}
      {showPausePreview && (
        <ReportOverlay title="暂停报工" onClose={() => !pauseSaving && setShowPausePreview(false)}>
          <div className="space-y-3 text-sm">
            <p className="text-slate-600">
              将当前明细以「暂停报工」类型写入系统（与常规「完工」为不同单据类型）。
            </p>
            <label className="block space-y-1">
              <span className="text-slate-500 text-xs">备注（选填）</span>
              <textarea
                value={pauseRemarks}
                onChange={(e) => setPauseRemarks(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="可填写暂停原因等"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400 resize-y min-h-[72px]"
              />
            </label>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                disabled={pauseSaving}
                onClick={() => setShowPausePreview(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 active:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={pauseSaving}
                onClick={handleConfirmPause}
                className="flex-1 py-2.5 rounded-xl bg-amber-600 text-white font-medium active:bg-amber-700 disabled:opacity-50"
              >
                {pauseSaving ? '提交中…' : '确认暂停报工'}
              </button>
            </div>
          </div>
        </ReportOverlay>
      )}

      {/* Save preview overlay */}
      {showPreview && (
        <ReportOverlay title="保存前确认" onClose={() => !saving && setShowPreview(false)}>
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <p><span className="text-slate-500">工序编码：</span>{headerLine?.stepCode}</p>
              <p><span className="text-slate-500">工序名称：</span>{headerLine?.stepName}</p>
              <p><span className="text-slate-500">签到时间：</span>保存时自动记录为提交时刻</p>
              <p>
                <span className="text-slate-500">操作员：</span>
                {operatorCodesArr.length > 0 ? operatorCodesArr.join('、') : user?.username || '—'}
              </p>
            </div>

            <div className="border-t border-slate-100 pt-2 space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="rounded-lg bg-slate-50 p-3 text-xs space-y-0.5">
                  <p className="font-medium text-sm">工单 {line.baseEntry}</p>
                  <p>来源：{line.baseOType} / {line.baseOEntry} / {line.baseOLine}</p>
                  <p>工序行号：{line.gxLineId}</p>
                  <p>批次：{line.pc || '—'} ｜ 物料名称：{line.itemName}</p>
                  <p>上道工序：{line.lastStepCode} / {line.lastStepName} / {line.lastStepTimeLabel}</p>
                  <p>数量：{quantities[idx] ?? line.quantity}</p>
                </div>
              ))}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                disabled={saving}
                onClick={() => setShowPreview(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 active:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                disabled={saving}
                onClick={handleConfirmSave}
                className="flex-1 py-2.5 rounded-xl bg-sky-600 text-white font-medium active:bg-sky-700 disabled:opacity-50"
              >
                {saving ? '保存中…' : '确认'}
              </button>
            </div>
          </div>
        </ReportOverlay>
      )}
    </div>
  )
}
