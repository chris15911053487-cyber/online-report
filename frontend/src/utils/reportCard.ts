/**
 * 报表手机卡片布局（菜单 mobile_card_json → MenuItem.mobileCard）。
 *
 * 每个位置配一组候选列名，按顺序取本次结果里第一个存在的列（列名不区分大小写），
 * 一个都没有就不显示该位置。同一报表在不同筛选下返回的列可以不同。
 * 没被固定位置用掉、也不在 hidden 里的列，按返回顺序放进卡片下半部分（空值不显示）。
 * 结构须与后端 server/src/routes/menus.js 的 normalizeMobileCard 保持一致。
 */

export interface ReportCardConfig {
  /** 标题；值为空或 0 视为没有，继续找下一个候选 */
  title?: string[]
  /** 右上角状态标签 */
  badge?: string[]
  /** 状态标签配色：值 → neutral | info | warning | success | danger；未配置按关键字推断 */
  badgeTones?: Record<string, BadgeTone>
  /** 副标题（最多两行） */
  subtitle?: string[]
  /** 副标题后的小字 */
  subNote?: string[]
  /** 右侧大号数字；优先取有值的候选，都为空时取第一个存在的列并显示「—」 */
  metric?: string[]
  /** 一行小字，每组取一个，用「·」连接 */
  meta?: string[][]
  /** 进度条：done ÷ total，两列都存在且 total > 0 时显示 */
  progress?: { done: string[]; total: string[] }
  /** 不在卡片上显示的列 */
  hidden?: string[]
  /** 下半部分默认显示几个字段，其余折叠；默认 4 */
  maxRest?: number
}

export type BadgeTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger'

export interface CardField {
  col: string
  value: unknown
}

export interface ResolvedCard {
  title: CardField | null
  badge: (CardField & { tone: BadgeTone }) | null
  subtitle: CardField | null
  subNote: CardField | null
  metric: CardField | null
  meta: CardField[]
  progress: { done: number; total: number; doneCol: string; totalCol: string } | null
  rest: CardField[]
}

const BADGE_TONES: BadgeTone[] = ['neutral', 'info', 'warning', 'success', 'danger']

function strList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  return arr.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean)
}

/** 宽松解析配置：单个字符串当作只有一个候选；结构不对返回 null（报表照旧显示表格） */
export function normalizeCardConfig(raw: unknown): ReportCardConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const cfg: ReportCardConfig = {
    title: strList(r.title),
    badge: strList(r.badge),
    subtitle: strList(r.subtitle),
    subNote: strList(r.subNote),
    metric: strList(r.metric),
    meta: Array.isArray(r.meta) ? r.meta.map(strList).filter((g) => g.length > 0) : [],
    hidden: strList(r.hidden),
  }
  if (r.progress && typeof r.progress === 'object') {
    const p = r.progress as Record<string, unknown>
    const done = strList(p.done)
    const total = strList(p.total)
    if (done.length && total.length) cfg.progress = { done, total }
  }
  if (r.badgeTones && typeof r.badgeTones === 'object' && !Array.isArray(r.badgeTones)) {
    const tones: Record<string, BadgeTone> = {}
    for (const [k, v] of Object.entries(r.badgeTones as Record<string, unknown>)) {
      if (BADGE_TONES.includes(v as BadgeTone)) tones[k] = v as BadgeTone
    }
    cfg.badgeTones = tones
  }
  const mr = Number(r.maxRest)
  if (Number.isFinite(mr) && mr >= 0) cfg.maxRest = Math.trunc(mr)
  const hasSlot =
    cfg.title!.length || cfg.subtitle!.length || cfg.metric!.length || cfg.badge!.length || cfg.meta!.length
  return hasSlot ? cfg : null
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === ''
}

/** 行里实际的列名（不区分大小写匹配） */
function findKey(row: Record<string, unknown>, col: string): string | null {
  if (Object.prototype.hasOwnProperty.call(row, col)) return col
  const lower = col.toLowerCase()
  for (const k of Object.keys(row)) if (k.toLowerCase() === lower) return k
  return null
}

function pick(
  row: Record<string, unknown>,
  cands: string[] | undefined,
  opts: { needValue?: boolean; skipZero?: boolean } = {},
): CardField | null {
  for (const c of cands ?? []) {
    const key = findKey(row, c)
    if (!key) continue
    const v = row[key]
    if (opts.needValue && isEmpty(v)) continue
    if (opts.skipZero && (v === 0 || String(v).trim() === '0')) continue
    return { col: key, value: v }
  }
  return null
}

export function toCardNumber(v: unknown): number | null {
  if (isEmpty(v)) return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** 数字去掉多余小数位（1.000000 → 1，8.50 → 8.5）；group 时整数加千分位（只用于数量，单号/编码不加）；其余原样 */
export function formatCardValue(v: unknown, group = false): string {
  if (isEmpty(v)) return ''
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v)
    if (!Number.isFinite(n)) return String(v)
    if (!Number.isInteger(n)) return String(Number(n.toFixed(4)))
    return group ? n.toLocaleString('zh-CN') : String(n)
  }
  return String(v).trim()
}

/** 未配置 badgeTones 时按关键字推断 */
export function inferBadgeTone(v: unknown): BadgeTone {
  const s = String(v ?? '')
  if (/失败|异常|超期|驳回/.test(s)) return 'danger'
  if (/未完工|进行/.test(s)) return 'info'
  if (/完工|完成|已报/.test(s)) return 'success'
  if (/暂停|恢复|返工/.test(s)) return 'warning'
  return 'neutral'
}

export function resolveCard(row: Record<string, unknown>, cfg: ReportCardConfig): ResolvedCard {
  const title = pick(row, cfg.title, { needValue: true, skipZero: true })
  const badgeField = pick(row, cfg.badge, { needValue: true })
  const subtitle = pick(row, cfg.subtitle, { needValue: true })
  const subNote = pick(row, cfg.subNote, { needValue: true })
  const metric = pick(row, cfg.metric, { needValue: true }) ?? pick(row, cfg.metric)

  const meta: CardField[] = []
  for (const group of cfg.meta ?? []) {
    const f = pick(row, group, { needValue: true })
    if (f && f.col !== title?.col) meta.push(f)
  }

  let progress: ResolvedCard['progress'] = null
  if (cfg.progress) {
    const d = pick(row, cfg.progress.done)
    const t = pick(row, cfg.progress.total)
    const total = t ? toCardNumber(t.value) : null
    if (d && t && total && total > 0) {
      progress = { done: toCardNumber(d.value) ?? 0, total, doneCol: d.col, totalCol: t.col }
    }
  }

  const used = new Set<string>()
  for (const f of [title, badgeField, subtitle, subNote, metric, ...meta]) if (f) used.add(f.col.toLowerCase())
  if (progress) {
    used.add(progress.doneCol.toLowerCase())
    used.add(progress.totalCol.toLowerCase())
  }
  // 排在选中标题之前、被跳过的候选列（如单号为 0）也不再出现在下半部分
  for (const c of cfg.title ?? []) {
    if (title && c.toLowerCase() === title.col.toLowerCase()) break
    used.add(c.toLowerCase())
  }
  for (const c of cfg.hidden ?? []) used.add(c.toLowerCase())

  const rest: CardField[] = []
  for (const [col, value] of Object.entries(row)) {
    if (used.has(col.toLowerCase()) || isEmpty(value)) continue
    rest.push({ col, value })
  }

  const badge = badgeField
    ? { ...badgeField, tone: cfg.badgeTones?.[String(badgeField.value).trim()] ?? inferBadgeTone(badgeField.value) }
    : null

  return { title, badge, subtitle, subNote, metric, meta, progress, rest }
}
