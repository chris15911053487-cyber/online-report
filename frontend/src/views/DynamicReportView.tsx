import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport } from '../utils/api'
import {
  isImageColumn,
  buildImageSrc,
  getRowValue,
  reportColumnHeaderText,
  collectFilterParams,
  formatAIResult,
  formatApiErrorDetail,
} from '../utils/helpers'
import type { FilterField, FilterOption, ReportResult } from '../types'
import ImageLightbox from '../components/ImageLightbox'
import TextOverlay from '../components/TextOverlay'
import { openBarcodeScan } from '../utils/barcodeScan'

const PAGE_SIZE_OPTIONS = [50, 100, 200]

/**
 * 生产报工吸底按钮：**仅**根据筛参名 `Status`（忽略大小写，即 `status`）判断接单 / 完工，不看其它筛选。
 */
function findProSignStatusField(schema: FilterField[]): FilterField | undefined {
  return schema.find((f) => (f.name || '').trim().toLowerCase() === 'status')
}

/** 与 FilterFieldInput 一致：下拉首条 option 的 value（字符串化 code） */
function firstSelectableCode(items: FilterOption[] | undefined | null): string {
  if (!items?.length) return ''
  const c = items[0].code
  return c != null && typeof c !== 'object' ? String(c) : ''
}

/**
 * 仅从下拉选项的「显示文案」判断是否对应接单 / 完工（不做数值 0/1 推断）。
 * 接单 / 完工分开写清：完工侧依赖「未完」排除；接单侧排除含「不接单」类否定（与「待接单」不冲突）。
 */
function mergeLabelFromOptionDisplayText(nameRaw: string): '接单' | '完工' | null {
  const name = String(nameRaw).trim()
  if (!name) return null
  if (name === '接单' || name === '待接单' || name === '未接单') return '接单'
  if (name.includes('接单') && !/不接单|暂不接(?:单)?/.test(name)) return '接单'
  if (name === '完工' || name === '已完工' || name === '待完工') return '完工'
  if (name.includes('待完工')) return '完工'
  if (name.includes('完工') && !name.includes('未完')) return '完工'
  return null
}

function resolveFilterOpts(
  field: FilterField | undefined,
  resolvedOptions?: FilterOption[] | null,
): FilterOption[] | null {
  if (!field) return null
  if (resolvedOptions && resolvedOptions.length > 0) return resolvedOptions
  if (field.options && field.options.length > 0) return field.options
  return null
}

function findMatchingFilterOption(opts: FilterOption[], v: unknown): FilterOption | undefined {
  return opts.find((o) => {
    if (o.code === v) return true
    if (v != null && typeof v === 'number' && o.code != null && typeof o.code === 'number' && o.code === v)
      return true
    const oc = o.code != null && typeof o.code !== 'object' ? String(o.code) : ''
    const vs = v != null && typeof v !== 'object' ? String(v) : ''
    if (vs !== '' && oc === vs) return true
    /** 常见于 SQL Server：`code` 为 integer，`<select>` 存 string */
    const nO = Number(oc)
    const nV = Number(vs)
    if (vs !== '' && oc !== '' && Number.isFinite(nO) && Number.isFinite(nV) && nO === nV) return true
    return false
  })
}

/**
 * 与列表页吸底按钮文案一致；合并页「暂停报工」依赖是否为「完工」。
 * 兼容：数值 0/1、字符串 "0"/"00"、以及 **静态 options 或 optionsSql 拉取的选项** 名称（含「接单」等）。
 * @param resolvedOptions 筛选项来自 optionsSql 时传 sqlOptions[field.name]，勿仅用 field.options（往往为空）
 */
function resolveProSignMergeButtonLabel(
  field: FilterField | undefined,
  formValues: Record<string, any>,
  resolvedOptions?: FilterOption[] | null,
): string {
  if (!field) return '合并报工'
  const v = formValues[field.name]
  if (v === '' || v === null || v === undefined) return '合并报工'
  if (typeof v === 'boolean') return '合并报工'

  const opts = resolveFilterOpts(field, resolvedOptions)
  let name = ''
  if (opts && opts.length > 0) {
    const hit = findMatchingFilterOption(opts, v)
    name = hit?.name != null ? String(hit.name).trim() : ''
    const fromDisp = mergeLabelFromOptionDisplayText(name)
    if (fromDisp) return fromDisp
  }

  const s = String(v).trim()
  if (s === '') return '合并报工'
  /** 兜底：选项尚未加载或与 value 存的是文案而非 code */
  const fromPlain = mergeLabelFromOptionDisplayText(s)
  if (fromPlain) return fromPlain
  const num = Number(s)
  if (Number.isFinite(num)) {
    if (num === 0) return '接单'
    if (num === 1) return '完工'
  }
  return '合并报工'
}

function normalizePageSize(size: number): number {
  const n = Math.trunc(Number(size))
  if (!Number.isFinite(n) || n < 1) return 50
  if (PAGE_SIZE_OPTIONS.includes(n)) return n
  return 50
}

/** Inputs that typically open the software keyboard on mobile (exclude checkbox/radio etc.) */
function isKeyboardFocusableControl(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const t = ((el as HTMLInputElement).type || 'text').toLowerCase()
  const noKeyboard = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ])
  return !noKeyboard.has(t)
}

function shouldShowAllOption(
  f: FilterField,
  proSignMode: boolean,
): boolean {
  if (f.required) return false
  if (f.noAllOption) return false
  if (proSignMode && (f.name || '').trim().toLowerCase() === 'status') return false
  return true
}

export default function DynamicReportView() {
  const {
    activeMenu,
    proSignMode,
    showToast,
    openReportRowDetail,
    openProSignReceive,
    navigateTo,
    currentView,
    shouldRefreshProSignListAfterReceive,
    clearProSignListRefreshFlag,
  } = useStore()

  const schema = activeMenu?.filterSchema ?? []
  const routeKey = activeMenu?.routeKey ?? ''
  const columnLabels = activeMenu?.columnLabels ?? {}

  // Filter form state
  const [formValues, setFormValues] = useState<Record<string, any>>({})
  const [sqlOptions, setSqlOptions] = useState<Record<string, FilterOption[]>>({})
  const [sqlOptionsLoading, setSqlOptionsLoading] = useState<Record<string, boolean>>({})
  const [sqlOptionsError, setSqlOptionsError] = useState<Record<string, boolean>>({})
  const [optionsReady, setOptionsReady] = useState(false)

  // Report data state
  const [columns, setColumns] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [totalRowCount, setTotalRowCount] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [clientSidePaging, setClientSidePaging] = useState(false)
  const [clientRowsBuffer, setClientRowsBuffer] = useState<Record<string, any>[] | null>(null)
  const [serverRows, setServerRows] = useState<Record<string, any>[] | null>(null)

  // UI state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [textOverlay, setTextOverlay] = useState<{ title: string; text: string } | null>(null)

  // ProSign state
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [mergeLoading, setMergeLoading] = useState(false)
  /** Hide sticky merge bar while a text-like control is focused (avoids bar sitting above mobile keyboard). */
  const [mergeBarHiddenForKeyboard, setMergeBarHiddenForKeyboard] = useState(false)

  // Jump-to-page input
  const [jumpInput, setJumpInput] = useState('')

  const hasQueried = useRef(false)
  const initDone = useRef(false)

  useEffect(() => {
    if (!proSignMode) {
      setMergeBarHiddenForKeyboard(false)
      return
    }
    const sync = () => {
      setMergeBarHiddenForKeyboard(isKeyboardFocusableControl(document.activeElement))
    }
    const onFocusOut = () => requestAnimationFrame(sync)
    document.addEventListener('focusin', sync)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', sync)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [proSignMode])

  // Derived: visible rows for current page
  const getVisibleRows = useCallback((): Record<string, any>[] => {
    if (clientSidePaging && clientRowsBuffer) {
      const start = (page - 1) * pageSize
      return clientRowsBuffer.slice(start, start + pageSize)
    }
    return serverRows ?? []
  }, [clientSidePaging, clientRowsBuffer, serverRows, page, pageSize])

  const maxPage = useCallback((): number => {
    const ps = pageSize < 1 ? 1 : pageSize
    return Math.max(1, Math.ceil(totalRowCount / ps))
  }, [totalRowCount, pageSize])

  // --- Filter options loading ---
  useEffect(() => {
    if (initDone.current) return
    initDone.current = true

    const defaults: Record<string, any> = {}
    for (const f of schema) {
      if (f.type === 'bool') {
        defaults[f.name] = false
        continue
      }
      const isProSignStatus =
        proSignMode && (f.name || '').trim().toLowerCase() === 'status'
      const fromSql = !!(f.optionsSql || f.optionsFromSql)
      if (isProSignStatus && !fromSql && f.options && f.options.length > 0) {
        defaults[f.name] = firstSelectableCode(f.options)
      } else {
        defaults[f.name] = ''
      }
    }
    setFormValues(defaults)

    const sqlFields = schema.filter((f) => f.optionsSql || f.optionsFromSql)
    if (sqlFields.length === 0) {
      setOptionsReady(true)
      return
    }

    const loadingMap: Record<string, boolean> = {}
    for (const f of sqlFields) loadingMap[f.name] = true
    setSqlOptionsLoading(loadingMap)

    const promises = sqlFields.map((f) =>
      apiFetch('/reports/filter-field-options', {
        method: 'POST',
        body: JSON.stringify({ routeKey, fieldName: f.name }),
      })
        .then((data) => {
          const items: FilterOption[] = data?.items ?? []
          setSqlOptions((prev) => ({ ...prev, [f.name]: items }))
          setSqlOptionsLoading((prev) => ({ ...prev, [f.name]: false }))
        })
        .catch((err) => {
          showToast(err.message || '下拉选项加载失败')
          setSqlOptionsError((prev) => ({ ...prev, [f.name]: true }))
          setSqlOptionsLoading((prev) => ({ ...prev, [f.name]: false }))
        }),
    )

    Promise.all(promises).then(() => setOptionsReady(true))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 生产报工 Status 不带「全部」：受控值为 '' 时浏览器仍可能显示第一项，但未写入 formValues，
   * 查询后吸底仍显示「合并报工」。在选项就绪后用首项 code 对齐真实选中值。
   */
  useEffect(() => {
    if (!proSignMode) return
    const sf = findProSignStatusField(schema)
    if (!sf) return

    let items: FilterOption[] | undefined
    if (sf.optionsSql || sf.optionsFromSql) {
      if (!optionsReady) return
      items = sqlOptions[sf.name]
      if (!items?.length) return
    } else if (sf.options?.length) {
      items = sf.options
    } else {
      return
    }

    const firstCode = firstSelectableCode(items)
    if (!firstCode) return

    setFormValues((prev) => {
      const cur = prev[sf.name]
      if (cur !== '' && cur != null) return prev
      if (prev[sf.name] === firstCode) return prev
      return { ...prev, [sf.name]: firstCode }
    })
  }, [proSignMode, optionsReady, schema, sqlOptions])

  // Auto-query when schema is empty or after all options loaded
  useEffect(() => {
    if (!optionsReady || hasQueried.current) return
    if (schema.length === 0) {
      hasQueried.current = true
      runQuery(1, pageSize)
    }
  }, [optionsReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Query execution ---
  const runQuery = useCallback(
    async (targetPage: number = 1, targetSize: number = pageSize) => {
      setLoading(true)
      setError('')
      setSelectedRows(new Set())

      const params = collectFilterParams(schema, formValues)
      const body = {
        routeKey,
        params,
        page: targetPage,
        pageSize: targetSize,
      }

      const reportPath = proSignMode ? '/pro-sign/run-list' : '/reports/run'
      try {
        const data: ReportResult = await apiFetchReport(reportPath, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        setColumns(data.columns ?? [])
        setTruncated(!!data.truncated)
        setClientSidePaging(!!data.clientSidePaging)

        let total =
          data.totalRowCount != null ? Number(data.totalRowCount) : (data.rows ?? []).length
        if (!Number.isFinite(total) || total < 0) total = 0
        setTotalRowCount(total)

        const respPage = data.page != null ? Number(data.page) || 1 : targetPage
        setPage(respPage)
        if (data.pageSize != null) {
          setPageSize(normalizePageSize(data.pageSize))
        }

        if (data.clientSidePaging) {
          setClientRowsBuffer(data.rows ?? [])
          setServerRows(null)
        } else {
          setClientRowsBuffer(null)
          setServerRows(data.rows ?? [])
        }
      } catch (err: any) {
        let msg = err.message || '查询失败'
        if (err.name === 'AbortError') {
          msg = '请求超时，请缩小条件或稍后重试'
        }
        if (err.data?.detail) {
          msg += '\n\n详细错误：\n' + err.data.detail
        }
        setError(msg)
        if (err.status === 401) navigateTo('login')
      } finally {
        setLoading(false)
      }
    },
    [schema, formValues, routeKey, proSignMode, pageSize, navigateTo],
  )

  // 从合并报工返回：保持筛选条件，自动重新查询最新列表（回到第 1 页）
  useEffect(() => {
    if (!proSignMode || currentView !== 'dynamic-report') return
    if (!shouldRefreshProSignListAfterReceive || !optionsReady) return
    clearProSignListRefreshFlag()
    hasQueried.current = true
    setPage(1)
    void runQuery(1, pageSize)
  }, [
    proSignMode,
    currentView,
    shouldRefreshProSignListAfterReceive,
    optionsReady,
    clearProSignListRefreshFlag,
    runQuery,
    pageSize,
  ])

  const handleSubmit = () => {
    hasQueried.current = true
    setPage(1)
    runQuery(1, pageSize)
  }

  // --- Pagination ---
  const changePage = (delta: number) => {
    const mp = maxPage()
    const next = page + delta
    if (next < 1 || next > mp) return
    setPage(next)
    setSelectedRows(new Set())
    if (clientSidePaging) return // re-render handles it
    runQuery(next, pageSize)
  }

  const goToPage = (target: number | string) => {
    const mp = maxPage()
    let p = Math.trunc(Number(target))
    if (!Number.isFinite(p)) return
    if (p < 1) p = 1
    if (p > mp) p = mp
    if (p === page) return
    setPage(p)
    setSelectedRows(new Set())
    if (clientSidePaging) return
    runQuery(p, pageSize)
  }

  const changePageSize = (newSize: number) => {
    const ps = normalizePageSize(newSize)
    if (ps === pageSize) return
    setPageSize(ps)
    setPage(1)
    setSelectedRows(new Set())
    if (clientSidePaging) return
    runQuery(1, ps)
  }

  // --- AI Analysis ---
  const handleAI = async () => {
    if (aiLoading) return
    setAiLoading(true)
    try {
      const params = collectFilterParams(schema, formValues)
      const data = await apiFetchReport(
        '/ai/analyze',
        {
          method: 'POST',
          body: JSON.stringify({ routeKey, params }),
        },
        30000,
      )

      let text = ''
      if (data?.success) {
        if (data.formatted) {
          text = String(data.formatted)
        } else if (data.analysis && typeof data.analysis === 'object') {
          text = formatAIResult(data.analysis)
        } else {
          text = String(data.analysis ?? '')
        }
      } else if (data?.analysis) {
        text = String(data.analysis)
      } else {
        text = 'AI 返回为空'
      }

      if (data && !data.success && data.aiError) {
        text += '\n\n—— 详情（供排查）——\n' + String(data.aiError)
      }

      setTextOverlay({ title: 'AI 分析', text })
    } catch (e: any) {
      if (e.status === 401) {
        navigateTo('login')
        showToast(e.message || '请重新登录')
        return
      }
      setTextOverlay({
        title: 'AI 分析未成功',
        text: formatApiErrorDetail('POST /ai/analyze', e, 30),
      })
    } finally {
      setAiLoading(false)
    }
  }

  // --- ProSign merge ---
  const getMergeButtonLabel = (): string => {
    const sf = findProSignStatusField(schema)
    let resolvedOpts: FilterOption[] | undefined
    if (sf && (sf.optionsSql || sf.optionsFromSql)) {
      resolvedOpts = sqlOptions[sf.name]
    } else if (sf?.options?.length) {
      resolvedOpts = sf.options
    }
    return resolveProSignMergeButtonLabel(sf, formValues, resolvedOpts)
  }

  const handleMerge = async () => {
    if (mergeLoading) return
    const rows = getVisibleRows()
    const selected: Array<{ orderId: number; operationId: string; row: Record<string, any> }> = []

    for (const idx of selectedRows) {
      const row = rows[idx]
      if (!row) continue
      const orderId = getRowValue(row, 'DocEntry')
      const opRaw = getRowValue(row, 'StepCode')
      if (orderId == null || opRaw == null || orderId === '' || opRaw === '') continue
      let stepStr = String(opRaw).trim()
      if (!stepStr) continue
      if (stepStr.length > 50) stepStr = stepStr.slice(0, 50)
      const oN = Number(orderId)
      if (!Number.isFinite(oN)) continue
      selected.push({ orderId: oN, operationId: stepStr, row })
    }

    if (selected.length === 0) {
      showToast('请先勾选至少一行（需含有效 DocEntry 和 StepCode）')
      return
    }

    setMergeLoading(true)
    try {
      const lines = selected.map((s) => ({
        docEntry: String(s.orderId),
        stepCode: String(s.operationId),
      }))
      const data = await apiFetch('/pro-sign/toowor-sign-detail', {
        method: 'POST',
        body: JSON.stringify({ lines }),
      })
      openProSignReceive(selected, data?.lineResults ?? [], getMergeButtonLabel())
    } catch (e: any) {
      showToast(e.message || '预检失败')
    } finally {
      setMergeLoading(false)
    }
  }

  // --- Row detail ---
  const handleRowClick = (row: Record<string, any>) => {
    if (!activeMenu?.rowDetailEnabled || !activeMenu.detailKeyColumn || proSignMode) return
    const keyCol = activeMenu.detailKeyColumn
    const raw = getRowValue(row, keyCol)
    if (raw === undefined || raw === null || raw === '') {
      showToast('当前行缺少主键列「' + keyCol + '」')
      return
    }
    const detailKey = typeof raw === 'bigint' ? raw.toString() : raw
    const params = collectFilterParams(schema, formValues)
    openReportRowDetail(routeKey, { ...params, detailKey }, columnLabels)
  }

  // --- Select all ---
  const visibleRows = getVisibleRows()
  const allSelected =
    visibleRows.length > 0 && selectedRows.size === visibleRows.length

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedRows(new Set())
    } else {
      setSelectedRows(new Set(visibleRows.map((_, i) => i)))
    }
  }

  const toggleRow = (idx: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const rowDetailOn =
    !!activeMenu?.rowDetailEnabled && !!activeMenu.detailKeyColumn && !proSignMode

  const displayCols =
    columns.length > 0 ? columns : visibleRows.length > 0 ? Object.keys(visibleRows[0]) : []

  const mp = maxPage()

  // Form field value change handler
  const setFieldValue = (name: string, value: any) => {
    setFormValues((prev) => ({ ...prev, [name]: value }))
  }

  // --- Render ---
  return (
    <div className="flex flex-col h-full">
      {/* Title */}
      <div className="px-4 pt-3 pb-2">
        <h1 className="text-lg font-semibold text-gray-900">
          {activeMenu?.label ?? '报表'}
        </h1>
      </div>

      {/* Filter form */}
      {schema.length > 0 && (
        <div className="px-4 pb-3">
          <div className="space-y-3">
            {schema.map((f) => (
              <FilterFieldInput
                key={f.name}
                field={f}
                value={formValues[f.name] ?? ''}
                onChange={(v) => setFieldValue(f.name, v)}
                proSignMode={proSignMode}
                sqlOptions={sqlOptions[f.name]}
                sqlLoading={sqlOptionsLoading[f.name]}
                sqlError={sqlOptionsError[f.name]}
                showToast={showToast}
              />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white active:bg-blue-700 disabled:opacity-50"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? '查询中…' : '查询'}
            </button>
            {activeMenu?.aiPrompt?.trim() && (
              <button
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white active:bg-emerald-700 disabled:opacity-50"
                onClick={handleAI}
                disabled={aiLoading}
              >
                {aiLoading ? '分析中…' : 'AI 分析'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="mx-4 mb-3 rounded-xl border border-red-200 bg-red-50 p-3">
          <pre className="whitespace-pre-wrap text-sm text-red-700">{error}</pre>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div className="py-10 text-center text-sm text-gray-400">加载中…</div>
      )}

      {/* Empty state */}
      {!loading && hasQueried.current && totalRowCount === 0 && visibleRows.length === 0 && (
        <div className="py-10 text-center text-sm text-gray-400">无数据</div>
      )}

      {/* Current page empty but data exists */}
      {!loading && visibleRows.length === 0 && totalRowCount > 0 && (
        <div className="py-10 text-center text-sm text-gray-400">当前页无数据</div>
      )}

      {/* Table */}
      {!loading && visibleRows.length > 0 && (
        <div className="flex-1 overflow-x-auto px-4">
          <table className="w-full min-w-[600px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                {proSignMode && (
                  <th className="w-10 px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="全选本页"
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </th>
                )}
                {displayCols.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-gray-600"
                  >
                    {reportColumnHeaderText(col, columnLabels)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className={
                    'border-b border-gray-100' +
                    (rowDetailOn ? ' cursor-pointer hover:bg-blue-50 active:bg-blue-100' : '') +
                    (rowIdx % 2 === 0 ? ' bg-white' : ' bg-gray-50/50')
                  }
                  onClick={() => rowDetailOn && handleRowClick(row)}
                >
                  {proSignMode && (
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={selectedRows.has(rowIdx)}
                        onChange={() => toggleRow(rowIdx)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                    </td>
                  )}
                  {displayCols.map((col) => (
                    <ReportCell
                      key={col}
                      col={col}
                      row={row}
                      onImageClick={setLightboxSrc}
                      onExpandText={(title, text) => setTextOverlay({ title, text })}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pager */}
      {!loading && totalRowCount > 0 && (
        <div className="border-t border-gray-100 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-gray-600">
            {mp > 1 && (
              <button
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => changePage(-1)}
              >
                上一页
              </button>
            )}
            <span>
              {mp > 1
                ? `第 ${page} / ${mp} 页，共 ${totalRowCount} 条`
                : `共 ${totalRowCount} 条`}
              {truncated && (
                <span className="text-amber-600">（结果已截断）</span>
              )}
            </span>
            {mp > 1 && (
              <button
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs disabled:opacity-40"
                disabled={page >= mp}
                onClick={() => changePage(1)}
              >
                下一页
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <label className="flex items-center gap-1 text-xs text-gray-500">
              每页
              <select
                className="rounded border border-gray-200 px-2 py-1 text-xs"
                value={pageSize}
                onChange={(e) => changePageSize(Number(e.target.value))}
                aria-label="每页条数"
              >
                {PAGE_SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s} 条
                  </option>
                ))}
              </select>
            </label>
            {mp > 1 && (
              <label className="flex items-center gap-1 text-xs text-gray-500">
                跳转
                <input
                  type="number"
                  className="w-16 rounded border border-gray-200 px-2 py-1 text-xs"
                  min={1}
                  max={mp}
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      goToPage(jumpInput)
                      setJumpInput('')
                    }
                  }}
                  inputMode="numeric"
                  aria-label="跳转到页码"
                />
                <button
                  className="rounded border border-gray-200 px-2 py-1 text-xs"
                  onClick={() => {
                    goToPage(jumpInput)
                    setJumpInput('')
                  }}
                >
                  前往
                </button>
              </label>
            )}
          </div>
        </div>
      )}

      {/* ProSign sticky merge button — collapses while a keyboard field is focused */}
      {proSignMode && (
        <div
          className={
            'sticky bottom-0 border-t border-gray-200 bg-white px-4 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] transition-[max-height,opacity,padding,box-shadow,border-color] duration-200 ease-out ' +
            (mergeBarHiddenForKeyboard
              ? 'max-h-0 overflow-hidden border-t-transparent py-0 opacity-0 shadow-none pointer-events-none'
              : 'py-3 opacity-100')
          }
          aria-hidden={mergeBarHiddenForKeyboard}
        >
          <button
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white active:bg-indigo-700 disabled:opacity-50"
            onClick={handleMerge}
            disabled={mergeLoading || selectedRows.size === 0}
          >
            {mergeLoading ? '处理中…' : getMergeButtonLabel()}
            {!mergeLoading && selectedRows.size > 0 && ` (${selectedRows.size})`}
          </button>
        </div>
      )}

      {/* ImageLightbox */}
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* TextOverlay */}
      {textOverlay && (
        <TextOverlay
          title={textOverlay.title}
          text={textOverlay.text}
          onClose={() => setTextOverlay(null)}
        />
      )}
    </div>
  )
}

// ── ScanFieldWrap（filter_schema scan:true，对齐 legacy app.js）────────

function ScanFieldWrap({
  enabled,
  showToast,
  onScanSuccess,
  children,
}: {
  enabled: boolean
  showToast: (msg: string, durationMs?: number) => void
  onScanSuccess: (text: string) => void
  children: ReactNode
}) {
  if (!enabled) return <>{children}</>
  return (
    <div className="flex items-stretch gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        className="flex shrink-0 items-center justify-center self-stretch rounded-lg border border-gray-200 bg-gray-50 px-3 text-gray-700 active:bg-gray-100"
        aria-label="扫码"
        title="扫码：点击直接启动摄像头；摄像头不可用时可选相册照片识别。外接扫码枪可直接扫入。"
        onClick={(ev) => {
          ev.preventDefault()
          openBarcodeScan({ showToast, onDecoded: onScanSuccess })
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={22}
          height={22}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 7V5a2 2 0 0 1 2-2h2" />
          <path d="M17 3h2a2 2 0 0 1 2 2v2" />
          <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
          <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
          <line x1="7" y1="12" x2="17" y2="12" />
        </svg>
      </button>
    </div>
  )
}

// ── FilterFieldInput ─────────────────────────────────────

interface FilterFieldInputProps {
  field: FilterField
  value: any
  onChange: (v: any) => void
  proSignMode: boolean
  sqlOptions?: FilterOption[]
  sqlLoading?: boolean
  sqlError?: boolean
  showToast: (msg: string, durationMs?: number) => void
}

function FilterFieldInput({
  field,
  value,
  onChange,
  proSignMode,
  sqlOptions,
  sqlLoading,
  sqlError,
  showToast,
}: FilterFieldInputProps) {
  const f = field
  const t = (f.type || 'string').toLowerCase()
  const showAll = shouldShowAllOption(f, proSignMode)
  const useScan =
    f.scan === true && (t === 'string' || t === 'int' || t === 'decimal')

  const labelEl = (
    <span className="mb-1 block text-xs font-medium text-gray-600">
      {f.label || f.name}
      {f.required && <span className="ml-0.5 text-red-500">*</span>}
    </span>
  )

  const inputCls =
    'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400'

  if (f.optionsSql || f.optionsFromSql) {
    if (sqlLoading) {
      return (
        <label className="block">
          {labelEl}
          <select className={inputCls} disabled>
            <option>加载中…</option>
          </select>
        </label>
      )
    }
    if (sqlError) {
      return (
        <label className="block">
          {labelEl}
          <select className={inputCls} disabled>
            <option>（加载失败）</option>
          </select>
        </label>
      )
    }
    const items = sqlOptions ?? []
    return (
      <label className="block">
        {labelEl}
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
          {showAll && <option value="">（全部）</option>}
          {items.map((op, i) => {
            const cv =
              op.code != null && typeof op.code !== 'object' ? String(op.code) : ''
            return (
              <option key={`${cv}-${i}`} value={cv}>
                {op.name != null ? String(op.name) : ''}
              </option>
            )
          })}
        </select>
      </label>
    )
  }

  if (Array.isArray(f.options) && f.options.length > 0) {
    return (
      <label className="block">
        {labelEl}
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
          {showAll && <option value="">（全部）</option>}
          {f.options.map((op, i) => {
            const cv =
              op.code != null && typeof op.code !== 'object' ? String(op.code) : ''
            return (
              <option key={`${cv}-${i}`} value={cv}>
                {op.name != null ? String(op.name) : ''}
              </option>
            )
          })}
        </select>
      </label>
    )
  }

  if (t === 'bool') {
    return (
      <label className="flex items-center gap-2 py-1">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <span className="text-sm text-gray-700">{f.label || f.name}</span>
      </label>
    )
  }

  if (t === 'date' || t === 'datetime') {
    return (
      <label className="block">
        {labelEl}
        <input
          type={t === 'date' ? 'date' : 'datetime-local'}
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    )
  }

  if (t === 'int' || t === 'decimal') {
    return (
      <label className="block">
        {labelEl}
        <ScanFieldWrap
          enabled={useScan}
          showToast={showToast}
          onScanSuccess={(text) => onChange(text)}
        >
          <input
            type="number"
            step={t === 'int' ? '1' : 'any'}
            className={inputCls}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </ScanFieldWrap>
      </label>
    )
  }

  return (
    <label className="block">
      {labelEl}
      <ScanFieldWrap
        enabled={useScan}
        showToast={showToast}
        onScanSuccess={(text) => onChange(text)}
      >
        <input
          type="text"
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </ScanFieldWrap>
    </label>
  )
}

// ── ReportCell ───────────────────────────────────────────

interface ReportCellProps {
  col: string
  row: Record<string, any>
  onImageClick: (src: string) => void
  onExpandText: (title: string, text: string) => void
}

function ReportCell({ col, row, onImageClick, onExpandText }: ReportCellProps) {
  const raw = getRowValue(row, col)
  const display = raw == null || raw === '' ? '—' : String(raw)

  if (isImageColumn(col) && display !== '—') {
    const src = buildImageSrc(display)
    const [imgError, setImgError] = useState(false)

    return (
      <td className="px-3 py-2">
        {imgError ? (
          <span className="text-xs text-gray-400">加载失败</span>
        ) : (
          <img
            src={src}
            alt={display}
            loading="lazy"
            className="h-20 max-w-[120px] cursor-pointer object-contain"
            title="点击查看原图"
            onClick={(e) => {
              e.stopPropagation()
              onImageClick(src)
            }}
            onError={() => setImgError(true)}
          />
        )}
      </td>
    )
  }

  return (
    <td className="max-w-[240px] px-3 py-2">
      <div className="flex items-center gap-1">
        <span className="truncate" title={display !== '—' ? display : ''}>
          {display}
        </span>
        {display !== '—' && display.length > 36 && (
          <button
            className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
            onClick={(e) => {
              e.stopPropagation()
              onExpandText(col, display)
            }}
            aria-label="查看全文"
          >
            ···
          </button>
        )}
      </div>
    </td>
  )
}
