import { useState, useEffect, useCallback } from 'react'
import { getRowValue, reportColumnHeaderText } from '../utils/helpers'

const RETURNPRO_ROUTE = 'returnpro'

const FIELD_LABELS: Record<string, string> = {
  DocEntry: '单据号',
  LineId: '行号',
  ItemCode: '物料编码',
  ItemName: '物料名称',
  U_Spec: '规格',
  U_PlannedQty: '计划数量',
  U_Unit: '单位',
  Quantity: '领料数量',
  ManBtchNum: '批次管理',
  BatchNum: '批次号',
  BaseType: '基准类型',
  BaseEntry: '基准单号',
  BaseLine: '基准行号',
}

const READONLY_FIELDS = [
  'LineId',
  'ItemCode',
  'ItemName',
  'U_Spec',
  'U_PlannedQty',
  'U_Unit',
  'ManBtchNum',
] as const

export function isReturnProRoute(routeKey: string | undefined | null): boolean {
  return String(routeKey || '').trim().toLowerCase() === RETURNPRO_ROUTE
}

function isBatchManaged(row: Record<string, any>): boolean {
  const v = getRowValue(row, 'ManBtchNum')
  return String(v ?? '').trim().toUpperCase() === 'Y'
}

function formatDisplay(val: unknown): string {
  if (val == null || val === '') return '—'
  return String(val)
}

export interface ReturnProLineDraft {
  quantity: string
  batchNum: string
}

function buildDrafts(rows: Record<string, any>[]): ReturnProLineDraft[] {
  return rows.map((row) => {
    const qty = getRowValue(row, 'Quantity')
    const batch = getRowValue(row, 'BatchNum')
    return {
      quantity: qty == null || qty === '' ? '' : String(qty),
      batchNum: batch == null ? '' : String(batch),
    }
  })
}

interface ReturnProPickDetailProps {
  rows: Record<string, any>[]
  columnLabels: Record<string, string>
  detailKey: unknown
  truncated: boolean
  goBack: () => void
  showToast: (msg: string, durationMs?: number) => void
}

export default function ReturnProPickDetail({
  rows,
  columnLabels,
  detailKey,
  truncated,
  goBack,
  showToast,
}: ReturnProPickDetailProps) {
  const [drafts, setDrafts] = useState<ReturnProLineDraft[]>(() => buildDrafts(rows))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setDrafts(buildDrafts(rows))
  }, [rows])

  const headerDocEntry =
    rows.length > 0
      ? formatDisplay(getRowValue(rows[0], 'DocEntry') ?? detailKey)
      : formatDisplay(detailKey)

  const labelFor = useCallback(
    (col: string) => reportColumnHeaderText(col, { ...FIELD_LABELS, ...columnLabels }),
    [columnLabels],
  )

  const updateDraft = useCallback((index: number, patch: Partial<ReturnProLineDraft>) => {
    setDrafts((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  const collectPayload = useCallback(() => {
    return rows.map((row, i) => {
      const draft = drafts[i] ?? { quantity: '', batchNum: '' }
      const qty = parseFloat(draft.quantity)
      return {
        docEntry: getRowValue(row, 'DocEntry'),
        lineId: getRowValue(row, 'LineId'),
        itemCode: getRowValue(row, 'ItemCode'),
        itemName: getRowValue(row, 'ItemName'),
        uSpec: getRowValue(row, 'U_Spec'),
        uPlannedQty: getRowValue(row, 'U_PlannedQty'),
        uUnit: getRowValue(row, 'U_Unit'),
        quantity: Number.isFinite(qty) ? qty : null,
        manBtchNum: getRowValue(row, 'ManBtchNum'),
        baseType: getRowValue(row, 'BaseType'),
        baseEntry: getRowValue(row, 'BaseEntry'),
        baseLine: getRowValue(row, 'BaseLine'),
        batchNum: draft.batchNum.trim(),
      }
    })
  }, [rows, drafts])

  const validate = useCallback((): string | null => {
    for (let i = 0; i < rows.length; i++) {
      const draft = drafts[i]
      const qty = parseFloat(draft?.quantity ?? '')
      if (!Number.isFinite(qty) || qty <= 0) {
        return `第 ${i + 1} 行：请填写有效的领料数量`
      }
      if (isBatchManaged(rows[i]) && !String(draft?.batchNum ?? '').trim()) {
        return `第 ${i + 1} 行：批次管理物料须填写批次号`
      }
    }
    return null
  }, [rows, drafts])

  const handlePick = useCallback(async () => {
    const err = validate()
    if (err) {
      showToast(err)
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        docEntry: detailKey,
        lines: collectPayload(),
      }
      // TODO: 调用 SAP 领料接口
      console.info('[returnpro] 领料待提交', payload)
      showToast('领料接口对接中，数据已校验通过')
    } finally {
      setSubmitting(false)
    }
  }, [validate, collectPayload, detailKey, showToast])

  const inputCls =
    'border border-slate-200 rounded-lg px-3 py-2 w-full text-sm focus:outline-none focus:ring-2 focus:ring-sky-300 focus:border-sky-300'

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button type="button" onClick={goBack} className="text-sky-600 text-sm shrink-0">
          ← 返回
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold truncate">领料明细</h2>
          <p className="text-xs text-slate-500 truncate">单据号 {headerDocEntry}</p>
        </div>
      </div>

      {truncated && (
        <div className="mx-3 mt-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 px-3 py-2 text-xs">
          结果已截断，请缩小查询范围
        </div>
      )}

      <div className="mx-3 mt-3 space-y-3">
        {rows.map((row, ri) => {
          const batchOn = isBatchManaged(row)
          const draft = drafts[ri] ?? { quantity: '', batchNum: '' }
          return (
            <div
              key={ri}
              className="rounded-2xl bg-white shadow-sm border border-slate-100 overflow-hidden"
            >
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-700">
                  行 {formatDisplay(getRowValue(row, 'LineId'))}
                </span>
                {batchOn && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-100">
                    批次管理
                  </span>
                )}
              </div>

              <div className="px-4 py-3 space-y-2 text-sm">
                {READONLY_FIELDS.map((col) => {
                  const val = getRowValue(row, col)
                  if (col === 'ManBtchNum' && !batchOn) return null
                  return (
                    <div key={col} className="flex gap-2">
                      <span className="text-slate-500 shrink-0 w-24">{labelFor(col)}</span>
                      <span className="text-slate-800 break-all flex-1">{formatDisplay(val)}</span>
                    </div>
                  )
                })}

                <div className="pt-2 border-t border-slate-100 space-y-3">
                  <label className="block">
                    <span className="text-slate-500 text-xs mb-1 block">{labelFor('Quantity')}</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={draft.quantity}
                      onChange={(e) => updateDraft(ri, { quantity: e.target.value })}
                      className={inputCls}
                      placeholder="请输入领料数量"
                    />
                  </label>

                  {batchOn && (
                    <label className="block">
                      <span className="text-slate-500 text-xs mb-1 block">{labelFor('BatchNum')}</span>
                      <input
                        type="text"
                        value={draft.batchNum}
                        onChange={(e) => updateDraft(ri, { batchNum: e.target.value })}
                        className={inputCls}
                        placeholder="请输入批次号"
                        autoComplete="off"
                      />
                    </label>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="fixed bottom-0 inset-x-0 z-20 p-3 bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="max-w-2xl mx-auto">
          <button
            type="button"
            onClick={handlePick}
            disabled={submitting || rows.length === 0}
            className="w-full py-3.5 rounded-xl bg-sky-600 text-white font-medium text-base active:bg-sky-700 transition-colors disabled:opacity-50"
          >
            {submitting ? '提交中…' : '领料'}
          </button>
        </div>
      </div>
    </div>
  )
}
