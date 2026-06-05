/** Column naming convention: _img / _image / _pic / _photo suffix = image column */
const IMAGE_COLUMN_PATTERN = /_(img|image|pic|photo)$/i

export function isImageColumn(colName: string): boolean {
  return IMAGE_COLUMN_PATTERN.test(String(colName))
}

export function buildImageSrc(filePath: string): string {
  if (!filePath) return ''
  const s = String(filePath).trim()
  if (s.startsWith('\\\\') || s.indexOf('\\\\') !== -1) {
    return '/files/image?path=' + encodeURIComponent(s)
  }
  return '/images/' + encodeURI(s.replace(/\\/g, '/').replace(/^\/+/, ''))
}

export function getRowValue(row: Record<string, any>, colName: string): any {
  if (!row || !colName) return undefined
  if (Object.prototype.hasOwnProperty.call(row, colName)) return row[colName]
  const lower = colName.toLowerCase()
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key]
  }
  return undefined
}

export function reportColumnHeaderText(
  colName: string,
  labelMap: Record<string, string> = {},
): string {
  if (!colName?.trim()) return '—'
  const s = String(colName)
  if (labelMap[s]) return labelMap[s]
  const lower = s.toLowerCase()
  for (const k of Object.keys(labelMap)) {
    if (k.toLowerCase() === lower) return labelMap[k]
  }
  return s
}

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return h + ':' + pad2(m) + ':' + pad2(sec)
  return m + ':' + pad2(sec)
}

export function formatZhDateMinute(d: Date): string {
  if (!d || isNaN(d.getTime())) return '—'
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  )
}

export function statusLabel(s: string): string {
  const map: Record<string, string> = {
    open: '待开工',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
  }
  return map[s] || s
}

export function batchStatusLabel(st: string): string {
  const map: Record<string, string> = {
    pending: '待接单',
    received: '已接单',
    in_progress: '进行中',
    paused: '已暂停',
    completed: '已完工',
  }
  return map[st] || st || '—'
}

export function collectFilterParams(
  schema: Array<{ name: string; type?: string; required?: boolean }>,
  formValues: Record<string, any>,
): Record<string, any> {
  const params: Record<string, any> = {}
  for (const f of schema) {
    const v = formValues[f.name]
    if (v === '' || v == null || v === undefined) {
      if (!f.required) params[f.name] = null
      continue
    }
    const t = (f.type || 'string').toLowerCase()
    if (t === 'int') params[f.name] = parseInt(String(v), 10)
    else if (t === 'decimal') params[f.name] = Number(v)
    else if (t === 'bool') {
      if (typeof v === 'boolean') params[f.name] = v
      else if (v === 'true' || v === '1') params[f.name] = true
      else if (v === 'false' || v === '0') params[f.name] = false
      else params[f.name] = v
    } else params[f.name] = v
  }
  return params
}

export function formatAIResult(obj: any): string {
  if (!obj || typeof obj !== 'object') return String(obj || '')
  const lines: string[] = []
  if (obj.overview) lines.push('📋 概览\n' + obj.overview + '\n')
  if (Array.isArray(obj.keyMetrics)) {
    lines.push('📊 关键指标')
    for (const m of obj.keyMetrics) {
      const change = m.change ? ' ' + m.change : ''
      lines.push('  • ' + m.label + ': ' + m.value + change)
    }
    lines.push('')
  }
  if (Array.isArray(obj.insights)) {
    lines.push('💡 主要洞察')
    for (const item of obj.insights) lines.push('  • ' + item)
    lines.push('')
  }
  if (Array.isArray(obj.anomalies)) {
    lines.push('⚠️ 异常发现')
    for (const item of obj.anomalies) lines.push('  • ' + item)
    lines.push('')
  }
  if (Array.isArray(obj.recommendations)) {
    lines.push('🎯 行动建议')
    for (const item of obj.recommendations) lines.push('  • ' + item)
    lines.push('')
  }
  if (Array.isArray(obj.suggestedHighlights)) {
    lines.push('🔍 建议重点关注')
    for (const item of obj.suggestedHighlights) lines.push('  • ' + item)
  }
  return lines.join('\n').trim() || JSON.stringify(obj, null, 2)
}

export function formatApiErrorDetail(label: string, e: any, timeoutSec = 90): string {
  const head = label?.trim() || '请求'
  const tSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.floor(timeoutSec) : 90
  if (!e) return head + ' 失败：未知错误'
  if (e.name === 'AbortError') {
    return `${head} 已中断（可能超过约 ${tSec} 秒超时或网络中断）。\n可稍后重试，或先缩小当前筛选条件后再点「AI 分析」。`
  }
  const m = (e.message || '').trim() || '请求失败'
  const d = e.data
  if (!d) return `${head} 失败：\n${m}`
  const segs = [`${head} 失败`, `—— ${m} ——`]
  if (d.detail != null && String(d.detail).trim() !== '') {
    segs.push('【服务端详细】\n' + String(d.detail))
  }
  if (d.error != null && d.message != null) {
    const ex = (d.error || '') + (d.message ? ' — ' + d.message : '')
    if (!m.includes(String(d.error))) segs.push('【其他】\n' + ex)
  } else if (d.message != null && !m.includes(String(d.message))) {
    segs.push('【message】\n' + String(d.message))
  }
  return segs.join('\n\n')
}

const PRO_SIGN_ROW_QTY_COLS = [
  'Quantity', 'Qty', '数量', 'PlannedQty', 'PlanQty',
  'GoodQty', 'ReportQty', 'ReportedQty',
]

export function proSignQuantityFromRow(row: Record<string, any>): number | null {
  if (!row) return null
  for (const col of PRO_SIGN_ROW_QTY_COLS) {
    const raw = getRowValue(row, col)
    if (raw == null || raw === '') continue
    const p = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''))
    if (Number.isFinite(p)) return p
  }
  return null
}

/** 从 Z_ONLINE_TOOWORSIGN_DETAIL 解析结果中取上一环节操作员编码（支持逗号/分号分隔） */
export function proSignPrevStepOperatorCodes(lineResults: any[] | null | undefined): string[] {
  if (!lineResults?.length) return []
  for (const lr of lineResults) {
    const raw = lr?.display?.lastStepOperator
    if (raw == null) continue
    const s = String(raw).trim()
    if (!s) continue
    const parts = s
      .split(/[,，、;；]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (parts.length) return [...new Set(parts)]
  }
  return []
}

/** 合并报工页默认操作员：优先上一环节，否则当前登录人 */
export function proSignDefaultOperatorCodes(
  lineResults: any[] | null | undefined,
  fallbackUsername?: string,
): string[] {
  const fromPrev = proSignPrevStepOperatorCodes(lineResults)
  if (fromPrev.length > 0) return fromPrev
  const u = fallbackUsername?.trim()
  return u ? [u] : []
}

export function proSignLineDisplay(mergeItem: any, lineResult: any) {
  const d = lineResult?.display || {}
  const row = mergeItem?.row || {}
  const oi = mergeItem?.orderId
  const oop = mergeItem?.operationId

  let stv = getRowValue(row, 'StepCode')
  if (stv == null || stv === '') stv = oop

  let qNum: number | null = null
  if (d.quantity != null) {
    const pq = typeof d.quantity === 'number' ? d.quantity : parseFloat(String(d.quantity).replace(/,/g, ''))
    if (Number.isFinite(pq)) qNum = pq
  }
  if (qNum == null) qNum = proSignQuantityFromRow(row)
  if (qNum == null) qNum = 0

  const stepCodeDisp = d.setupCode?.trim() || (stv != null && stv !== '' ? String(stv) : '—')
  
  const stepNameDisp = d.setupName?.trim() || (() => {
    for (const col of ['StepName', 'SetupName', 'operationName']) {
      const v = getRowValue(row, col)
      if (v != null && v !== '') return String(v)
    }
    return '—'
  })()

  let rawLastCode = d.lastStepCode?.trim() || ''
  if (!rawLastCode) {
    const lc = getRowValue(row, 'LastStepCode')
    if (lc != null && lc !== '') rawLastCode = String(lc).trim()
  }

  let rawLastName = d.lastStepName?.trim() || ''
  if (!rawLastName) {
    const ln = getRowValue(row, 'LastStepName')
    if (ln != null && ln !== '') rawLastName = String(ln).trim()
  }

  let rawLastTime = d.lastStepTime?.trim() || ''
  if (!rawLastTime) {
    const lt = getRowValue(row, 'LastStepTime')
    if (lt != null && lt !== '') rawLastTime = String(lt).trim()
  }

  let lastIso: string | null = null
  if (rawLastTime) {
    const dt = new Date(rawLastTime)
    if (!isNaN(dt.getTime())) lastIso = dt.toISOString()
  }

  let lastTimeLabel = '—'
  if (lastIso) lastTimeLabel = formatZhDateMinute(new Date(lastIso))
  else if (rawLastTime) lastTimeLabel = rawLastTime

  let rawPc = ''
  if (d.pc != null && String(d.pc).trim() !== '') {
    rawPc = String(d.pc).trim()
  } else {
    for (const col of ['PC', 'Pc', '批次', 'BatchNo', 'batchNo', 'Batch', 'Lot', 'LotNo']) {
      const pcv = getRowValue(row, col)
      if (pcv != null && String(pcv).trim() !== '') { rawPc = String(pcv).trim(); break }
    }
  }

  let itemNameDisp = '—'
  if (d.itemName?.trim()) {
    itemNameDisp = d.itemName.trim()
  } else {
    for (const col of ['ItemName', '物料名称', '产品名称', 'MaterialName', 'materialName', 'ProductName', 'ItemDesc']) {
      const inv = getRowValue(row, col)
      if (inv != null && String(inv).trim() !== '') { itemNameDisp = String(inv).trim(); break }
    }
  }

  const baseEntry = d.baseEntry?.trim() || (() => {
    const b = getRowValue(row, 'BaseEntry')
    if (b != null && b !== '') return String(b)
    if (oi != null && oi !== '') return String(oi)
    return '—'
  })()

  const pickMergeOrRowField = (mergeKey: string, rowCol: string) => {
    const fromMerge = mergeItem?.[mergeKey]
    if (fromMerge != null && String(fromMerge).trim() !== '') return String(fromMerge).trim()
    const fromRow = getRowValue(row, rowCol)
    if (fromRow != null && fromRow !== '') return String(fromRow).trim()
    return ''
  }

  const baseOType = pickMergeOrRowField('baseOType', 'BaseOType')
  const baseOEntry = pickMergeOrRowField('baseOEntry', 'BaseOEntry')
  const baseOLine = pickMergeOrRowField('baseOLine', 'BaseOLine')

  return {
    baseEntry,
    baseOType: baseOType || '—',
    baseOEntry: baseOEntry || '—',
    baseOLine: baseOLine || '—',
    stepCode: stepCodeDisp,
    stepName: stepNameDisp,
    quantity: qNum,
    lastStepCode: rawLastCode || '—',
    lastStepName: rawLastName || '—',
    lastStepTimeLabel: lastTimeLabel,
    lastStepTimeIso: lastIso,
    pc: rawPc,
    itemName: itemNameDisp,
  }
}
