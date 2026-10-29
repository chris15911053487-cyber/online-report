import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport } from '../utils/api'
import { apiUrl, authHeaders } from '../utils/api'
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
import ReportCardList from '../components/ReportCardList'
import { cn } from '../ui/classes'
import { DatePicker, SelectPicker } from '../ui/pickers'
import { normalizeCardConfig } from '../utils/reportCard'
import { useIsPc } from '../hooks/useMediaQuery'

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

/** 生产报工 Status 筛选项 code → 吸底/合并页按钮文案（固定映射） */
const PRO_SIGN_STATUS_CODE_TO_LABEL: Record<number, string> = {
  0: '接单',
  1: '完工',
  2: '已完工',
  8: '恢复报工',
}

/** 与 filter_schema 静态 options 中 string code 对齐（如 "0"/"1"/"2"/"8"） */
const PRO_SIGN_STATUS_STRING_TO_LABEL: Record<string, string> = {
  '0': '接单',
  '1': '完工',
  '2': '已完工',
  '8': '恢复报工',
}

/** 生产报工 Status 固定四项（与吸底按钮映射一致） */
const PRO_SIGN_STATUS_SEGMENT_CODES = [0, 1, 2, 8] as const

type ProSignStatusSlot = (typeof PRO_SIGN_STATUS_SEGMENT_CODES)[number]

function parseProSignStatusCode(code: unknown): number | null {
  if (code === '' || code === null || code === undefined) return null
  if (typeof code === 'boolean') return null
  if (typeof code === 'number' && Number.isFinite(code)) return Math.trunc(code)
  const s = String(code).trim()
  if (!s) return null
  const n = parseInt(s, 10)
  if (!Number.isFinite(n)) return null
  return n
}

/** 下拉显示名 → 吸底/合并页文案（code 非 0/1/2/8 时兜底） */
function mergeLabelFromOptionDisplayName(nameRaw: string): string | null {
  const name = String(nameRaw).trim()
  if (!name) return null
  if (/恢复/.test(name)) return '恢复报工'
  if (name === '已完工' || /^已完工$/.test(name)) return '已完工'
  if (name === '完工' || name === '待完工' || /待完工/.test(name)) return '完工'
  if (/完工/.test(name) && !/未完|恢复|已完/.test(name)) return '完工'
  if (name === '接单' || name === '待接单' || name === '未接单') return '接单'
  if (/接单/.test(name) && !/不接单|暂不接(?:单)?/.test(name)) return '接单'
  return null
}

function findOptionForProSignSlot(
  opts: FilterOption[] | null | undefined,
  slot: ProSignStatusSlot,
): FilterOption | undefined {
  if (!opts?.length) return undefined
  const byCode = opts.find((o) => parseProSignStatusCode(o.code) === slot)
  if (byCode) return byCode
  const patterns: Record<ProSignStatusSlot, RegExp> = {
    0: /待接单|未接单|^接单$|接单/,
    1: /待完工|^完工$|完工/,
    2: /^已完工$|已完工/,
    8: /恢复报工|恢复|暂停后继续|继续报工/,
  }
  const re = patterns[slot]
  return opts.find((o) => {
    const n = String(o.name ?? '').trim()
    return (
      n &&
      re.test(n) &&
      (slot !== 1 || (!/未完/.test(n) && !/已完工/.test(n))) &&
      (slot !== 0 || !/不接单|暂不接(?:单)?/.test(n)) &&
      (slot !== 2 || /已完工/.test(n))
    )
  })
}

function buildProSignStatusSegmentItems(
  opts: FilterOption[] | null | undefined,
): { code: string; label: string }[] {
  return PRO_SIGN_STATUS_SEGMENT_CODES.map((slot) => {
    const hit = findOptionForProSignSlot(opts, slot)
    const fallback = PRO_SIGN_STATUS_CODE_TO_LABEL[slot] ?? String(slot)
    const label =
      hit?.name != null && String(hit.name).trim() ? String(hit.name).trim() : fallback
    /** 固定业务 code 0/1/2/8；静态 options 配置与筛参、吸底映射一致 */
    return { code: String(slot), label }
  })
}

function isProSignStatusFieldName(name: string | undefined): boolean {
  return (name || '').trim().toLowerCase() === 'status'
}

const PRO_SIGN_MULTI_STEP_MSG = '不能同时勾选多个不同工序进行报工，请只选择同一工序的明细'

/** 列表行工序编码（StepCode），与 handleMerge 一致 */
function proSignRowStepCode(row: Record<string, any> | undefined): string {
  if (!row) return ''
  const opRaw = getRowValue(row, 'StepCode')
  if (opRaw == null || opRaw === '') return ''
  let stepStr = String(opRaw).trim()
  if (!stepStr) return ''
  if (stepStr.length > 50) stepStr = stepStr.slice(0, 50)
  return stepStr
}

function proSignSelectedStepCodes(
  rows: Record<string, any>[],
  indices: Iterable<number>,
): Set<string> {
  const codes = new Set<string>()
  for (const i of indices) {
    const code = proSignRowStepCode(rows[i])
    if (code) codes.add(code)
  }
  return codes
}

/** 勾选该行是否会与已选行的工序冲突 */
function proSignWouldMixSteps(
  rows: Record<string, any>[],
  selected: Set<number>,
  idx: number,
): boolean {
  const step = proSignRowStepCode(rows[idx])
  if (!step) return false
  const existing = proSignSelectedStepCodes(rows, selected)
  if (existing.size === 0) return false
  return !existing.has(step) || existing.size > 1
}

function proSignVisibleRowsHaveMultipleSteps(rows: Record<string, any>[]): boolean {
  return proSignSelectedStepCodes(rows, rows.map((_, i) => i)).size > 1
}

/** 读取表单值（字段名大小写不敏感，兼容 Status / status） */
function getFormFieldValue(formValues: Record<string, any>, fieldName: string): unknown {
  if (!fieldName) return undefined
  if (Object.prototype.hasOwnProperty.call(formValues, fieldName)) {
    return formValues[fieldName]
  }
  const lower = fieldName.toLowerCase()
  for (const k of Object.keys(formValues)) {
    if (k.toLowerCase() === lower) return formValues[k]
  }
  return undefined
}

function setFormFieldValue(
  formValues: Record<string, any>,
  fieldName: string,
  value: unknown,
): Record<string, any> {
  if (Object.prototype.hasOwnProperty.call(formValues, fieldName)) {
    return { ...formValues, [fieldName]: value }
  }
  const lower = fieldName.toLowerCase()
  const hit = Object.keys(formValues).find((k) => k.toLowerCase() === lower)
  if (hit) return { ...formValues, [hit]: value }
  return { ...formValues, [fieldName]: value }
}

function mergeButtonLabelFromStatusCode(code: unknown): string | null {
  if (code === '' || code == null || typeof code === 'boolean') return null
  const s = String(code).trim()
  if (PRO_SIGN_STATUS_STRING_TO_LABEL[s]) return PRO_SIGN_STATUS_STRING_TO_LABEL[s]
  const num = parseProSignStatusCode(code)
  if (num == null) return null
  return PRO_SIGN_STATUS_CODE_TO_LABEL[num] ?? null
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
 * 与列表页吸底按钮文案一致；合并页「暂停报工」仅在 Status code=1（完工）时显示。
 * Status code 固定：0 接单、1 完工、2 已完工、8 恢复报工；其它 → 合并报工。
 * @param resolvedOptions 筛选项来自 optionsSql 时传 sqlOptions[field.name]，勿仅用 field.options（往往为空）
 */
function resolveProSignMergeButtonLabel(
  field: FilterField | undefined,
  formValues: Record<string, any>,
  resolvedOptions?: FilterOption[] | null,
): string {
  if (!field) return '合并报工'
  const v = getFormFieldValue(formValues, field.name)
  if (v === '' || v === null || v === undefined) return '合并报工'
  if (typeof v === 'boolean') return '合并报工'

  /** 分段按钮写入的 0/1/2/8 或 parseInt 可解析的值优先 */
  const direct = mergeButtonLabelFromStatusCode(v)
  if (direct) return direct

  const opts = resolveFilterOpts(field, resolvedOptions)
  if (opts && opts.length > 0) {
    const hit = findMatchingFilterOption(opts, v)
    if (hit?.name) {
      const fromName = mergeLabelFromOptionDisplayName(String(hit.name))
      if (fromName) return fromName
    }
    if (hit?.code != null) {
      const fromCode = mergeButtonLabelFromStatusCode(hit.code)
      if (fromCode) return fromCode
    }
  }

  return '合并报工'
}

/** 折叠筛选标签上显示的值：有选项时显示选项名 */
function filterValueText(f: FilterField, v: unknown, sqlOpts?: FilterOption[]): string {
  const s = v == null ? '' : String(v)
  const opts = f.optionsSql || f.optionsFromSql ? sqlOpts : f.options
  const hit = opts?.find((o) => o.code != null && String(o.code) === s)
  return hit?.name != null ? String(hit.name) : s
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
    user,
    activeMenu,
    proSignMode,
    showToast,
    openReportRowDetail,
    openProSignReceive,
    openProSignOrderDetail,
    navigateTo,
    currentView,
    shouldRefreshProSignListAfterReceive,
    clearProSignListRefreshFlag,
    proSignMergeButtonLabel: storeMergeLabel,
    prefilledFilters,
    prefilledAutoQuery,
    consumePrefilledFilters,
  } = useStore()

  const schema = activeMenu?.filterSchema ?? []
  const routeKey = activeMenu?.routeKey ?? ''
  const columnLabels = activeMenu?.columnLabels ?? {}
  const isPc = useIsPc()
  /** 手机上折叠的「更多筛选」是否展开 */
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false)
  const cardConfig = useMemo(() => normalizeCardConfig(activeMenu?.mobileCard), [activeMenu?.mobileCard])
  /** 菜单配了手机卡片布局：手机上用卡片代替表格，PC 仍是表格 */
  const useCards = !isPc && !!cardConfig

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
  const [exporting, setExporting] = useState(false)

  // 是否有导出 Excel 权限
  const canExportExcel = useMemo(() => {
    const roles = user?.roles ?? []
    return roles.includes('admin') || roles.includes('export-excel')
  }, [user])

  const hasQueried = useRef(false)
  const initDone = useRef(false)
  const proSignAutoQueried = useRef(false)
  const menuInitKey = `${activeMenu?.id ?? ''}:${routeKey}`

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

  // --- Filter options loading（切换菜单时重新初始化） ---
  useEffect(() => {
    initDone.current = false
    proSignAutoQueried.current = false
    hasQueried.current = false
    setOptionsReady(false)
    setSqlOptions({})
    setSqlOptionsLoading({})
    setSqlOptionsError({})
  }, [menuInitKey])

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
        const slot0 = findOptionForProSignSlot(f.options, 0)
        defaults[f.name] =
          slot0?.code != null && typeof slot0.code !== 'object'
            ? String(slot0.code)
            : firstSelectableCode(f.options)
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
  }, [menuInitKey, routeKey, proSignMode, showToast]) // schema 随 menuInitKey 变化，勿直接依赖数组引用

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

    const slot0 = findOptionForProSignSlot(items, 0)
    const firstCode =
      slot0?.code != null && typeof slot0.code !== 'object'
        ? String(slot0.code)
        : firstSelectableCode(items)
    if (!firstCode) return

    setFormValues((prev) => {
      const cur = getFormFieldValue(prev, sf.name)
      if (cur !== '' && cur != null) return prev
      if (String(getFormFieldValue(prev, sf.name) ?? '') === firstCode) return prev
      return setFormFieldValue(prev, sf.name, firstCode)
    })
  }, [proSignMode, optionsReady, schema, sqlOptions])

  // Auto-query when schema is empty or after all options loaded
  // 如果有 prefilledFilters 待消费，则交给下面的 prefill effect 触发查询，避免重复请求
  useEffect(() => {
    if (!optionsReady || hasQueried.current) return
    if (prefilledFilters) return
    if (schema.length === 0) {
      hasQueried.current = true
      runQuery(1, pageSize)
    }
  }, [optionsReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Query execution ---
  const runQuery = useCallback(
    async (
      targetPage: number = 1,
      targetSize: number = pageSize,
      overrideFormValues?: Record<string, any>,
    ) => {
      setLoading(true)
      setError('')
      setSelectedRows(new Set())

      const values = overrideFormValues ?? formValues
      const params = collectFilterParams(schema, values)
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

  /**
   * 语音/外部跳转预填筛选条件并自动查询：
   * - 选项就绪后才能正确解析下拉值
   * - schema 中存在的字段才会被填入（大小写不敏感）
   * - 处理后立即从 store 消费掉，避免菜单切换时残留
   */
  useEffect(() => {
    if (!prefilledFilters || !optionsReady) return

    const lookup: Record<string, string> = {}
    for (const f of schema) lookup[(f.name || '').toLowerCase()] = f.name

    let applied = false
    const merged: Record<string, any> = { ...formValues }
    for (const k of Object.keys(prefilledFilters)) {
      const realName = lookup[String(k).toLowerCase()]
      if (!realName) continue
      const v = prefilledFilters[k]
      if (v == null) continue
      merged[realName] = typeof v === 'boolean' ? v : String(v)
      applied = true
    }

    const wantAutoQuery = prefilledAutoQuery !== false
    consumePrefilledFilters()

    if (!applied) return

    setFormValues(merged)
    if (wantAutoQuery) {
      hasQueried.current = true
      runQuery(1, pageSize, merged)
    }
  }, [prefilledFilters, optionsReady]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const proSignStatusField = proSignMode ? findProSignStatusField(schema) : undefined
  /** 生产报工「已完工」(Status=2) 只能查看：不显示勾选和底部按钮 */
  const proSignReadOnly =
    !!proSignStatusField &&
    parseProSignStatusCode(getFormFieldValue(formValues, proSignStatusField.name)) === 2
  const proSignSelectable = proSignMode && !proSignReadOnly

  const stickyMergeButtonLabel = useMemo(() => {
    if (!proSignMode || !proSignStatusField) return '合并报工'
    let resolvedOpts: FilterOption[] | undefined
    if (proSignStatusField.optionsSql || proSignStatusField.optionsFromSql) {
      resolvedOpts = sqlOptions[proSignStatusField.name]
    } else if (proSignStatusField.options?.length) {
      resolvedOpts = proSignStatusField.options
    }
    return resolveProSignMergeButtonLabel(proSignStatusField, formValues, resolvedOpts)
  }, [proSignMode, proSignStatusField, formValues, sqlOptions])

  useEffect(() => {
    if (!proSignMode) return
    if (storeMergeLabel === stickyMergeButtonLabel) return
    useStore.setState({ proSignMergeButtonLabel: stickyMergeButtonLabel })
  }, [proSignMode, stickyMergeButtonLabel, storeMergeLabel])

  /** 进入生产报工且 Status 已就绪时自动查一次，避免先点「查询」 */
  useEffect(() => {
    if (!proSignMode || !optionsReady || proSignAutoQueried.current) return
    if (!proSignStatusField) return
    const v = getFormFieldValue(formValues, proSignStatusField.name)
    if (v === '' || v == null) return
    proSignAutoQueried.current = true
    hasQueried.current = true
    void runQuery(1, pageSize)
  }, [proSignMode, optionsReady, proSignStatusField, formValues, runQuery, pageSize])

  const handleProSignStatusPick = useCallback(
    (code: string) => {
      if (!proSignStatusField) return
      const cur = getFormFieldValue(formValues, proSignStatusField.name)
      const curStr = cur != null && typeof cur !== 'object' ? String(cur) : ''
      if (curStr === code) {
        if (!hasQueried.current) {
          hasQueried.current = true
          setPage(1)
          void runQuery(1, pageSize)
        }
        return
      }
      const nextValues = setFormFieldValue(formValues, proSignStatusField.name, code)
      setFormValues(nextValues)
      hasQueried.current = true
      setPage(1)
      void runQuery(1, pageSize, nextValues)
    },
    [proSignStatusField, formValues, runQuery, pageSize],
  )

  /** 生产报工：任一非 Status 筛选项输入完成后自动查询（等同点击「查询」） */
  const handleProSignFilterComplete = useCallback(
    (patch?: { name: string; value: unknown }) => {
      if (!proSignMode) return
      const nextValues = patch ? { ...formValues, [patch.name]: patch.value } : formValues
      if (patch) setFormValues(nextValues)
      hasQueried.current = true
      setPage(1)
      void runQuery(1, pageSize, patch ? nextValues : undefined)
    },
    [proSignMode, formValues, runQuery, pageSize],
  )

  /** 分段按钮（segment）：点选即查询 */
  const handleSegmentPick = (name: string, code: string) => {
    const nextValues = { ...formValues, [name]: code }
    setFormValues(nextValues)
    hasQueried.current = true
    setPage(1)
    void runQuery(1, pageSize, nextValues)
  }

  /** 折叠区里清掉一个条件并重新查询 */
  const clearFilterAndQuery = (name: string) => {
    const nextValues = { ...formValues, [name]: '' }
    setFormValues(nextValues)
    if (!hasQueried.current) return
    setPage(1)
    void runQuery(1, pageSize, nextValues)
  }

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

  // --- Excel 导出 ---
  const handleExportExcel = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const params = collectFilterParams(schema, formValues)
      const res = await fetch(apiUrl('/reports/export-excel'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ routeKey, params }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `导出失败 (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // 从 Content-Disposition 提取文件名
      const cd = res.headers.get('Content-Disposition') || ''
      const fnMatch = cd.match(/filename\*=UTF-8''(.+)/)
      a.download = fnMatch ? decodeURIComponent(fnMatch[1]) : '报表.xlsx'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showToast('导出成功')
    } catch (e: any) {
      showToast(e.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const handleMerge = async () => {
    if (mergeLoading) return
    const rows = getVisibleRows()
    const selected: Array<{
      orderId: number
      operationId: string
      baseOType: string
      baseOEntry: string
      baseOLine: string
      row: Record<string, any>
    }> = []

    for (const idx of selectedRows) {
      const row = rows[idx]
      if (!row) continue
      const orderId = getRowValue(row, 'DocEntry')
      const opRaw = getRowValue(row, 'StepCode')
      const baseOType = getRowValue(row, 'BaseOType')
      const baseOEntry = getRowValue(row, 'BaseOEntry')
      const baseOLine = getRowValue(row, 'BaseOLine')
      if (
        orderId == null ||
        opRaw == null ||
        baseOType == null ||
        baseOEntry == null ||
        baseOLine == null ||
        orderId === '' ||
        opRaw === '' ||
        baseOType === '' ||
        baseOEntry === '' ||
        baseOLine === ''
      ) {
        continue
      }
      let stepStr = String(opRaw).trim()
      if (!stepStr) continue
      if (stepStr.length > 50) stepStr = stepStr.slice(0, 50)
      const oN = Number(orderId)
      if (!Number.isFinite(oN)) continue
      selected.push({
        orderId: oN,
        operationId: stepStr,
        baseOType: String(baseOType).trim(),
        baseOEntry: String(baseOEntry).trim(),
        baseOLine: String(baseOLine).trim(),
        row,
      })
    }

    if (selected.length === 0) {
      showToast(
        '请先勾选至少一行（需含有效 DocEntry、StepCode、BaseOType、BaseOEntry、BaseOLine）',
      )
      return
    }

    const distinctStepCodes = new Set(selected.map((s) => s.operationId))
    if (distinctStepCodes.size > 1) {
      showToast(PRO_SIGN_MULTI_STEP_MSG)
      return
    }

    const statusVal = proSignStatusField
      ? String(getFormFieldValue(formValues, proSignStatusField.name) ?? '').trim()
      : ''
    if (proSignStatusField && !statusVal) {
      showToast('请先选择状态')
      return
    }

    setMergeLoading(true)
    try {
      const lines = selected.map((s) => ({
        docEntry: String(s.orderId),
        stepCode: String(s.operationId),
        baseOType: s.baseOType,
        baseOEntry: s.baseOEntry,
        baseOLine: s.baseOLine,
      }))
      const data = await apiFetch('/pro-sign/toowor-sign-detail', {
        method: 'POST',
        body: JSON.stringify({ lines, status: statusVal }),
      })
      openProSignReceive(selected, data?.lineResults ?? [], stickyMergeButtonLabel)
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
    openReportRowDetail(routeKey, params, columnLabels, detailKey)
  }

  /** pro-sign 列表：点击该行打开“订单只读详情”（主键列名来自菜单 detailKeyColumn） */
  const handleProSignOrderDetailClick = (row: Record<string, any>) => {
    if (!proSignMode) return
    const keyCol = activeMenu?.detailKeyColumn?.trim()
    let raw: unknown
    if (keyCol) {
      raw = getRowValue(row, keyCol)
    } else {
      raw =
        getRowValue(row, 'orderNo') ??
        getRowValue(row, 'OrderNo') ??
        getRowValue(row, '订单号') ??
        getRowValue(row, 'orderno')
    }
    const orderNo = raw == null ? '' : String(raw).trim()
    if (!orderNo) {
      const hint = keyCol
        ? `当前行缺少主键列「${keyCol}」（请在菜单设置中核对「行主键列名」与列表列名一致）`
        : '当前行缺少订单号（请在菜单设置中填写「行主键列名」，如 orderNo / 订单号）'
      showToast(hint)
      return
    }
    openProSignOrderDetail(orderNo)
  }

  // --- Select all ---
  const visibleRows = getVisibleRows()
  const allSelected =
    visibleRows.length > 0 && selectedRows.size === visibleRows.length

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedRows(new Set())
      return
    }
    if (proSignMode && proSignVisibleRowsHaveMultipleSteps(visibleRows)) {
      showToast(PRO_SIGN_MULTI_STEP_MSG)
      return
    }
    setSelectedRows(new Set(visibleRows.map((_, i) => i)))
  }

  const toggleRow = (idx: number) => {
    setSelectedRows((prev) => {
      if (prev.has(idx)) {
        const next = new Set(prev)
        next.delete(idx)
        return next
      }
      if (proSignMode && proSignWouldMixSteps(visibleRows, prev, idx)) {
        showToast(PRO_SIGN_MULTI_STEP_MSG)
        return prev
      }
      const next = new Set(prev)
      next.add(idx)
      return next
    })
  }

  const rowDetailOn =
    !!activeMenu?.rowDetailEnabled && !!activeMenu.detailKeyColumn && !proSignMode
  const proSignOrderDetailOn = proSignMode

  const displayCols =
    columns.length > 0 ? columns : visibleRows.length > 0 ? Object.keys(visibleRows[0]) : []

  const mp = maxPage()

  const proSignStatusSegmentItems = proSignStatusField
    ? buildProSignStatusSegmentItems(
        proSignStatusField.optionsSql || proSignStatusField.optionsFromSql
          ? sqlOptions[proSignStatusField.name]
          : proSignStatusField.options,
      )
    : []
  const proSignStatusOptionsLoading = proSignStatusField
    ? !!(proSignStatusField.optionsSql || proSignStatusField.optionsFromSql) &&
      sqlOptionsLoading[proSignStatusField.name]
    : false

  const segmentFields = schema.filter(
    (f) => f.segment && !(proSignMode && isProSignStatusFieldName(f.name)),
  )
  const otherFields = schema.filter(
    (f) => !f.segment && !(proSignMode && isProSignStatusFieldName(f.name)),
  )
  /** 手机上有固定的分段筛选时，其余条件默认折叠 */
  const collapseOtherFilters = !isPc && (!!proSignStatusField || segmentFields.length > 0)
  /** 手机紧凑筛选（与折叠同时生效） */
  const compactFilters = collapseOtherFilters
  /** 生产报工手机紧凑模式下各项都会自动查询，去掉「查询」按钮（展开的筛选区里另有一个），AI 分析挪到结果条 */
  const hideMainActions = compactFilters && proSignMode
  /** 折叠时仍固定显示的条件：扫码字段和 pin 字段 */
  const pinnedFields = collapseOtherFilters ? otherFields.filter((f) => f.scan || f.pin) : []
  const foldFields = collapseOtherFilters ? otherFields.filter((f) => !(f.scan || f.pin)) : otherFields
  const activeOtherFields = foldFields.filter((f) => {
    const v = formValues[f.name]
    return v !== undefined && v !== null && v !== '' && v !== false
  })

  // Form field value change handler
  const setFieldValue = (name: string, value: any) => {
    setFormValues((prev) => ({ ...prev, [name]: value }))
  }

  const renderFilterInput = (f: FilterField, compact = false) => (
    <FilterFieldInput
      compact={compact}
      key={f.name}
      field={f}
      value={formValues[f.name] ?? ''}
      onChange={(v) => setFieldValue(f.name, v)}
      proSignMode={proSignMode}
      autoQueryOnComplete={proSignMode}
      onFieldComplete={handleProSignFilterComplete}
      sqlOptions={sqlOptions[f.name]}
      sqlLoading={sqlOptionsLoading[f.name]}
      sqlError={sqlOptionsError[f.name]}
      showToast={showToast}
    />
  )

  /** 订单详情的主键有值（Z1 等没有单号的行 DocEntry=0，不提供详情） */
  const hasDetailKey = (row: Record<string, unknown>) => {
    const v = getRowValue(row, activeMenu?.detailKeyColumn?.trim() || 'DocEntry')
    return v != null && String(v).trim() !== '' && String(v).trim() !== '0'
  }

  const aiButton = activeMenu?.aiPrompt?.trim() ? (
    <button
      className={cn(
        'rounded-lg bg-success font-medium text-white active:bg-success disabled:opacity-50',
        hideMainActions ? 'px-3 py-1 text-xs' : 'px-5 py-2 text-sm',
      )}
      onClick={handleAI}
      disabled={aiLoading}
      data-voice-label="AI分析" data-voice-action="click"
    >
      {aiLoading ? '分析中…' : 'AI 分析'}
    </button>
  ) : null

  // --- Render ---
  return (
    <div className="flex flex-col h-full">
      {/* Title（手机顶栏已显示菜单名，页内标题只在 PC 显示） */}
      <div className="hidden px-4 pt-3 pb-2 lg:block">
        <h1 className="font-display text-lg font-semibold text-fg">
          {activeMenu?.label ?? '报表'}
        </h1>
      </div>

      {/* Filter form */}
      {schema.length > 0 && (
        <div className="px-4 pb-3 pt-3 lg:pt-0">
          {/* 固定区：生产报工状态 + segment 字段（分段按钮，点选即查询）。PC 限宽各占一行；手机紧凑：无标题、矮按钮 */}
          {(proSignStatusField || segmentFields.length > 0) && (
            <div className={cn('grid lg:max-w-xl', compactFilters ? 'mb-2 gap-2' : 'mb-3 gap-3')}>
              {proSignStatusField && (
                <ProSignStatusSegment
                  field={proSignStatusField}
                  value={getFormFieldValue(formValues, proSignStatusField.name) ?? ''}
                  items={proSignStatusSegmentItems}
                  loading={proSignStatusOptionsLoading}
                  queryLoading={loading}
                  onSelect={handleProSignStatusPick}
                  compact={compactFilters}
                />
              )}
              {segmentFields.map((f) => (
                <SegmentFilter
                  key={f.name}
                  field={f}
                  value={formValues[f.name] ?? ''}
                  options={(f.optionsSql || f.optionsFromSql ? sqlOptions[f.name] : f.options) ?? []}
                  showAll={shouldShowAllOption(f, proSignMode)}
                  disabled={loading || (!!(f.optionsSql || f.optionsFromSql) && !!sqlOptionsLoading[f.name])}
                  onSelect={(code) => handleSegmentPick(f.name, code)}
                  compact={compactFilters}
                />
              ))}
            </div>
          )}

          {/* 手机紧凑：扫码 / pin 条件与「筛选」按钮同一行，其余条件折叠；收起时已填的条件显示为可清除的标签 */}
          {compactFilters && (pinnedFields.length > 0 || foldFields.length > 0) && (
            <div className="flex items-start gap-2">
              {pinnedFields.map((f) => (
                <div key={f.name} className="min-w-0 flex-1">
                  {renderFilterInput(f, true)}
                </div>
              ))}
              {foldFields.length > 0 && (
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-[38px] shrink-0 items-center gap-1 rounded-lg border bg-surface px-3 text-sm',
                    moreFiltersOpen || activeOtherFields.length > 0 ? 'border-primary/60 text-primary' : 'border-line text-fg-2',
                  )}
                  aria-expanded={moreFiltersOpen}
                  onClick={() => setMoreFiltersOpen((v) => !v)}
                >
                  筛选
                  {activeOtherFields.length > 0 && (
                    <span className="num rounded-full bg-primary-soft px-1.5 text-[11px] text-primary">
                      {activeOtherFields.length}
                    </span>
                  )}
                  <span aria-hidden className="text-xs">{moreFiltersOpen ? '▴' : '▾'}</span>
                </button>
              )}
            </div>
          )}
          {compactFilters && !moreFiltersOpen && activeOtherFields.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {activeOtherFields.map((f) => (
                <span
                  key={f.name}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 py-1 pl-2.5 pr-1 text-xs text-fg-2"
                >
                  <span className="truncate">
                    {f.label || f.name}：{filterValueText(f, formValues[f.name], sqlOptions[f.name])}
                  </span>
                  <button
                    type="button"
                    className="rounded-full px-1 text-muted active:bg-surface-3"
                    aria-label={`清除${f.label || f.name}`}
                    onClick={() => clearFilterAndQuery(f.name)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {(!compactFilters || moreFiltersOpen) && foldFields.length > 0 && (
            <div
              className={cn(
                'grid gap-3 lg:grid-cols-3 xl:grid-cols-4 lg:items-end',
                compactFilters && 'mt-2 rounded-lg border border-line bg-surface-2/50 p-3',
              )}
            >
              {foldFields.map((f) => renderFilterInput(f))}
              {hideMainActions && (
                <button
                  className="rounded-lg bg-primary py-2 text-sm font-medium text-primary-fg active:bg-primary-hover disabled:opacity-50"
                  onClick={() => {
                    setMoreFiltersOpen(false)
                    handleSubmit()
                  }}
                  disabled={loading}
                >
                  {loading ? '查询中…' : '查询'}
                </button>
              )}
            </div>
          )}

          {!hideMainActions && (
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-fg active:bg-primary-hover disabled:opacity-50"
                onClick={handleSubmit}
                disabled={loading}
                data-voice-label="查询" data-voice-action="click"
              >
                {loading ? '查询中…' : '查询'}
              </button>
              {aiButton}
            </div>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="mx-4 mb-3 rounded-xl border border-danger/25 bg-danger-soft p-3">
          <pre className="whitespace-pre-wrap text-sm text-danger">{error}</pre>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div className="py-10 text-center text-sm text-subtle">加载中…</div>
      )}

      {/* Empty state */}
      {!loading && hasQueried.current && totalRowCount === 0 && visibleRows.length === 0 && (
        <div className="py-10 text-center text-sm text-subtle">无数据</div>
      )}

      {/* Current page empty but data exists */}
      {!loading && visibleRows.length === 0 && totalRowCount > 0 && (
        <div className="py-10 text-center text-sm text-subtle">当前页无数据</div>
      )}

      {/* 手机结果条：条数 + AI 分析（紧凑筛选时从筛选区挪来）+ 卡片模式的全选 */}
      {!loading && visibleRows.length > 0 && (useCards || hideMainActions) && (
        <div className="flex items-center gap-3 px-4 pb-2 text-xs text-muted">
          <span className="flex-1">
            共 <b className="num font-semibold text-fg">{totalRowCount}</b> 条
          </span>
          {hideMainActions && aiButton}
          {useCards && proSignSelectable && (
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="h-4 w-4 accent-primary"
              />
              全选本页
            </label>
          )}
        </div>
      )}

      {/* Mobile cards */}
      {!loading && visibleRows.length > 0 && useCards && cardConfig && (
        <>
          <ReportCardList
            rows={visibleRows}
            config={cardConfig}
            columnLabels={columnLabels}
            selectable={proSignSelectable}
            selected={selectedRows}
            onToggle={toggleRow}
            onOpen={
              proSignOrderDetailOn ? handleProSignOrderDetailClick : rowDetailOn ? handleRowClick : undefined
            }
            canOpen={proSignOrderDetailOn ? hasDetailKey : undefined}
            onImageClick={setLightboxSrc}
          />
        </>
      )}

      {/* Table */}
      {!loading && visibleRows.length > 0 && !useCards && (
        <div className="flex-1 overflow-x-auto px-4">
          <table className="w-full min-w-[600px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                {proSignSelectable && (
                  <th className="w-10 px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="全选本页"
                      className="h-4 w-4 rounded border-line-strong"
                    />
                  </th>
                )}
                {displayCols.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-fg-2"
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
                    'border-b border-line' +
                    (rowDetailOn || proSignOrderDetailOn
                      ? ' cursor-pointer hover:bg-primary-soft active:bg-primary-soft'
                      : '') +
                    (rowIdx % 2 === 0 ? ' bg-surface' : ' bg-surface-2/50')
                  }
                  onClick={() => {
                    if (rowDetailOn) return handleRowClick(row)
                    if (proSignOrderDetailOn) return handleProSignOrderDetailClick(row)
                    return undefined
                  }}
                >
                  {proSignSelectable && (
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={selectedRows.has(rowIdx)}
                        onChange={() => toggleRow(rowIdx)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-line-strong"
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

      {/* Pager（手机结果条已显示条数，只有一页时不再重复） */}
      {!loading && totalRowCount > 0 && !((useCards || hideMainActions) && mp <= 1) && (
        <div className="border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-2">
            {mp > 1 && (
              <button
                className="rounded-lg border border-line px-3 py-1.5 text-xs disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => changePage(-1)}
                data-voice-label="上一页" data-voice-action="click"
              >
                上一页
              </button>
            )}
            <span>
              {mp > 1
                ? `第 ${page} / ${mp} 页，共 ${totalRowCount} 条`
                : `共 ${totalRowCount} 条`}
              {truncated && (
                <span className="text-warning">（结果已截断）</span>
              )}
            </span>
            {mp > 1 && (
              <button
                className="rounded-lg border border-line px-3 py-1.5 text-xs disabled:opacity-40"
                disabled={page >= mp}
                onClick={() => changePage(1)}
                data-voice-label="下一页" data-voice-action="click"
              >
                下一页
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <label className="flex items-center gap-1 text-xs text-muted">
              每页
              <SelectPicker
                className="w-auto rounded border border-line px-2 py-1 text-xs"
                value={String(pageSize)}
                options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${n} 条` }))}
                onChange={(v) => changePageSize(Number(v))}
                aria-label="每页条数"
              />
            </label>
            {mp > 1 && (
              <label className="flex items-center gap-1 text-xs text-muted">
                跳转
                <input
                  type="number"
                  className="w-16 rounded border border-line px-2 py-1 text-xs"
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
                  className="rounded border border-line px-2 py-1 text-xs"
                  onClick={() => {
                    goToPage(jumpInput)
                    setJumpInput('')
                  }}
                >
                  前往
                </button>
              </label>
            )}
            {canExportExcel && !proSignMode && (
              <button
                className="ml-auto rounded-lg border border-success px-3 py-1.5 text-xs font-medium text-success active:bg-success-soft disabled:opacity-50"
                onClick={handleExportExcel}
                disabled={exporting}
              >
                {exporting ? '导出中…' : '导出 Excel'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ProSign sticky merge button — collapses while a keyboard field is focused；已完工只能查看，不显示 */}
      {proSignSelectable && (
        <div
          className={
            'sticky bottom-0 border-t border-line bg-surface px-4 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] transition-[max-height,opacity,padding,box-shadow,border-color] duration-200 ease-out ' +
            (mergeBarHiddenForKeyboard
              ? 'max-h-0 overflow-hidden border-t-transparent py-0 opacity-0 shadow-none pointer-events-none'
              : 'py-3 opacity-100')
          }
          aria-hidden={mergeBarHiddenForKeyboard}
        >
          <button
            className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-fg active:bg-primary-hover disabled:opacity-50"
            onClick={handleMerge}
            disabled={mergeLoading || selectedRows.size === 0}
            data-voice-label={stickyMergeButtonLabel} data-voice-action="click"
          >
            {mergeLoading ? '处理中…' : stickyMergeButtonLabel}
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
        className="flex shrink-0 items-center justify-center self-stretch rounded-lg border border-line bg-surface-2 px-3 text-fg-2 active:bg-surface-2"
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

// ── ProSignStatusSegment（生产报工 Status：分段切换 + 点选即查询）──

interface ProSignStatusSegmentProps {
  field: FilterField
  value: unknown
  items: { code: string; label: string }[]
  loading?: boolean
  queryLoading?: boolean
  onSelect: (code: string) => void
  /** 手机紧凑布局：不显示标题、按钮矮一些 */
  compact?: boolean
}

function ProSignStatusSegment({
  field,
  value,
  items,
  loading,
  queryLoading,
  onSelect,
  compact,
}: ProSignStatusSegmentProps) {
  const active =
    value != null && typeof value !== 'object' ? String(value) : ''
  const isSelected = (itemCode: string) =>
    active === itemCode ||
    (parseProSignStatusCode(active) != null &&
      parseProSignStatusCode(active) === parseProSignStatusCode(itemCode))
  const label = field.label || field.name || 'Status'

  return (
    <div className="block" role="group" aria-label={label}>
      <span className={compact ? 'sr-only' : 'mb-1.5 block text-xs font-medium text-muted'}>{label}</span>
      <div className="flex w-full gap-1 rounded-lg border border-line bg-surface-2 p-1">
        {items.map((item) => {
          const selected = isSelected(item.code)
          return (
            <button
              key={item.code}
              type="button"
              disabled={loading || queryLoading}
              aria-pressed={selected}
              title={item.label}
              className={
                'flex min-w-0 flex-1 items-center justify-center rounded-md px-0.5 text-center font-medium leading-tight transition-all duration-150 ' +
                (compact ? 'min-h-[32px] py-1 text-xs ' : 'min-h-[36px] py-1.5 text-[11px] sm:min-h-[40px] sm:px-1 sm:text-xs ') +
                (selected
                  ? 'bg-surface text-primary shadow-sm ring-1 ring-line/90'
                  : 'text-fg-2 active:bg-surface-2/90') +
                (loading || queryLoading ? ' pointer-events-none opacity-60' : '')
              }
              onClick={() => onSelect(item.code)}
            >
              <span className="max-w-full truncate">
                {loading ? '…' : item.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── SegmentFilter（filter_schema segment:true：选项平铺成一排，点选即查询）──

function SegmentFilter({
  field,
  value,
  options,
  showAll,
  disabled,
  onSelect,
  compact,
}: {
  field: FilterField
  value: unknown
  options: FilterOption[]
  showAll: boolean
  disabled?: boolean
  onSelect: (code: string) => void
  compact?: boolean
}) {
  const active = value != null && typeof value !== 'object' ? String(value) : ''
  const items = [
    ...(showAll ? [{ code: '', label: field.allLabel || '全部' }] : []),
    ...options.map((op) => ({
      code: op.code != null && typeof op.code !== 'object' ? String(op.code) : '',
      label: op.name != null ? String(op.name) : '',
    })),
  ]
  const label = field.label || field.name
  return (
    <div className="block" role="group" aria-label={label}>
      <span className={compact ? 'sr-only' : 'mb-1.5 block text-xs font-medium text-muted'}>{label}</span>
      <div className="flex w-full gap-1 rounded-lg border border-line bg-surface-2 p-1">
        {items.map((item) => {
          const selected = active === item.code
          return (
            <button
              key={item.code || '__all'}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              className={
                'flex min-w-0 flex-1 items-center justify-center rounded-md px-1 text-center text-xs font-medium leading-tight transition-all duration-150 ' +
                (compact ? 'min-h-[32px] py-1 ' : 'min-h-[36px] py-1.5 ') +
                (selected ? 'bg-surface text-primary shadow-sm ring-1 ring-line/90' : 'text-fg-2 active:bg-surface-2/90') +
                (disabled ? ' pointer-events-none opacity-60' : '')
              }
              onClick={() => onSelect(item.code)}
              data-voice-label={item.label}
              data-voice-action="click"
            >
              <span className="max-w-full truncate">{item.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── FilterFieldInput ─────────────────────────────────────

interface FilterFieldInputProps {
  field: FilterField
  value: any
  onChange: (v: any) => void
  proSignMode: boolean
  /** 生产报工：输入完成（失焦/选完/扫码）后触发自动查询 */
  autoQueryOnComplete?: boolean
  onFieldComplete?: (patch?: { name: string; value: unknown }) => void
  sqlOptions?: FilterOption[]
  sqlLoading?: boolean
  sqlError?: boolean
  showToast: (msg: string, durationMs?: number) => void
  /** 手机紧凑布局：不显示上方标签，改用占位文字 */
  compact?: boolean
}

function FilterFieldInput({
  field,
  value,
  onChange,
  proSignMode,
  autoQueryOnComplete,
  onFieldComplete,
  sqlOptions,
  sqlLoading,
  sqlError,
  showToast,
  compact,
}: FilterFieldInputProps) {
  const f = field
  const t = (f.type || 'string').toLowerCase()
  const showAll = shouldShowAllOption(f, proSignMode)
  const useScan =
    f.scan === true && (t === 'string' || t === 'int' || t === 'decimal')

  const labelEl = (
    <span className={compact ? 'sr-only' : 'mb-1 block text-xs font-medium text-fg-2'}>
      {f.label || f.name}
      {f.required && <span className="ml-0.5 text-danger">*</span>}
    </span>
  )

  const inputCls =
    'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary'

  const fireComplete = (patch?: { name: string; value: unknown }) => {
    if (autoQueryOnComplete) onFieldComplete?.(patch)
  }

  const notifyChange = (v: any, complete = false) => {
    onChange(v)
    if (complete) fireComplete({ name: f.name, value: v })
  }

  const inputCompleteHandlers = autoQueryOnComplete
    ? { onBlur: () => fireComplete(undefined) }
    : {}

  const voice = { 'data-voice-label': f.label || f.name, 'data-voice-action': 'select', 'data-voice-field': f.name }
  const toPickerOptions = (list: { code?: unknown; name?: unknown }[]) =>
    list.map((op) => ({
      value: op.code != null && typeof op.code !== 'object' ? String(op.code) : '',
      label: op.name != null ? String(op.name) : '',
    }))

  if (f.optionsSql || f.optionsFromSql || (Array.isArray(f.options) && f.options.length > 0)) {
    const fromSql = !!(f.optionsSql || f.optionsFromSql)
    return (
      <label className="block">
        {labelEl}
        <SelectPicker
          className={inputCls}
          value={value == null ? '' : String(value)}
          options={toPickerOptions(fromSql ? (sqlOptions ?? []) : (f.options ?? []))}
          emptyLabel={showAll ? f.allLabel || '（全部）' : undefined}
          loading={fromSql && sqlLoading}
          error={fromSql && sqlError ? '选项加载失败' : undefined}
          title={f.label || f.name}
          onChange={(v) => notifyChange(v, true)}
          voice={voice}
        />
      </label>
    )
  }

  if (t === 'bool') {
    return (
      <label className="flex items-center gap-2 py-1">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => notifyChange(e.target.checked, true)}
          className="h-4 w-4 rounded border-line-strong"
          data-voice-label={f.label || f.name} data-voice-action="click" data-voice-field={f.name}
        />
        <span className="text-sm text-fg-2">{f.label || f.name}</span>
      </label>
    )
  }

  if (t === 'date' || t === 'datetime') {
    return (
      <label className="block">
        {labelEl}
        <DatePicker
          mode={t === 'date' ? 'date' : 'datetime'}
          className={inputCls}
          value={value == null ? '' : String(value)}
          title={f.label || f.name}
          onChange={(v) => notifyChange(v, true)}
          voice={{ ...voice, 'data-voice-action': 'fill' }}
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
          onScanSuccess={(text) => {
            onChange(text)
            fireComplete({ name: f.name, value: text })
          }}
        >
          <input
            type="number"
            step={t === 'int' ? '1' : 'any'}
            className={inputCls}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={compact ? f.label || f.name : undefined}
            {...inputCompleteHandlers}
            data-voice-label={f.label || f.name}
            data-voice-action="fill"
            data-voice-field={f.name}
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
        onScanSuccess={(text) => {
          onChange(text)
          fireComplete({ name: f.name, value: text })
        }}
      >
        <input
          type="text"
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={compact ? f.label || f.name : undefined}
          {...inputCompleteHandlers}
          data-voice-label={f.label || f.name}
          data-voice-action="fill"
          data-voice-field={f.name}
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
          <span className="text-xs text-subtle">加载失败</span>
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
            className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted hover:bg-surface-3"
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
