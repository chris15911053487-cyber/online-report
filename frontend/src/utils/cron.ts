/**
 * cron 表达式的中文解读与「接下来几次」——预警规则、定时报告的 Cron 输入框共用。
 *
 * 按服务端 node-cron 3 的实际语义解析（与标准 cron 有差异，解读须与真实执行一致）：
 * - 5 段「分 时 日 月 周」，或 6 段（最前面加秒）
 * - 步长按「数值能被步长整除」取值：8-18/5 = 10,15（不是 8,13,18）
 * - 「日」与「周」都写了具体值时，两者须同时满足
 * - 时间按中国时间（服务端调度 timezone: Asia/Shanghai）
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

interface FieldSpec { name: string; min: number; max: number }
const SEC: FieldSpec = { name: '秒', min: 0, max: 59 }
const FIELDS: FieldSpec[] = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
]

export interface ParsedCron {
  seconds: number[]
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
}

function replaceNames(s: string, names: string[], base: number): string {
  let out = s.toLowerCase()
  names.forEach((n, i) => { out = out.replace(new RegExp(n, 'g'), String(i + base)) })
  names.forEach((n, i) => { out = out.replace(new RegExp(n.slice(0, 3), 'g'), String(i + base)) })
  return out
}

function expandField(raw: string, spec: FieldSpec): number[] {
  const set = new Set<number>()
  for (const item of raw.split(',')) {
    const m = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!m) throw new Error(`「${spec.name}」写法不认识：${item}`)
    let lo = spec.min
    let hi = spec.max
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number)
      lo = a
      hi = b ?? a
    } else if (spec.name === '周') {
      hi = 6
    }
    if (lo < spec.min || hi > spec.max || lo > hi) throw new Error(`「${spec.name}」超出范围 ${spec.min}-${spec.max}：${item}`)
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) throw new Error(`「${spec.name}」步长须 ≥ 1：${item}`)
    for (let v = lo; v <= hi; v++) {
      if (step === 1 || v % step === 0) set.add(spec.name === '周' && v === 7 ? 0 : v)
    }
  }
  if (!set.size) throw new Error(`「${spec.name}」没有可取的值：${raw}`)
  return [...set].sort((a, b) => a - b)
}

/** 解析失败抛 Error（中文原因） */
export function parseCron(expr: string): ParsedCron {
  const parts = String(expr || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5 && parts.length !== 6) throw new Error(`须为 5 段「分 时 日 月 周」，现在是 ${parts.length} 段`)
  const seconds = parts.length === 6 ? expandField(parts.shift()!, SEC) : [0]
  const [mi, h, d, mo, w] = parts
  return {
    seconds,
    minutes: expandField(mi, FIELDS[0]),
    hours: expandField(h, FIELDS[1]),
    days: expandField(d, FIELDS[2]),
    months: expandField(replaceNames(mo, MONTHS, 1), FIELDS[3]),
    weekdays: expandField(replaceNames(w, WEEKDAYS, 0), FIELDS[4]),
  }
}

/** 1,2,3,5 → 「1–3、5」（连续 3 个以上合并） */
function listText(nums: number[]): string {
  const out: string[] = []
  for (let i = 0; i < nums.length;) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
    if (j - i >= 2) out.push(`${nums[i]}–${nums[j]}`)
    else for (let k = i; k <= j; k++) out.push(String(nums[k]))
    i = j + 1
  }
  return out.join('、')
}

/** 是否为 0、k、2k… 全部取到的步长（k > 1） */
function stepOf(nums: number[], max: number): number {
  if (nums.length < 2 || nums[0] !== 0) return 0
  const k = nums[1]
  if (k < 2) return 0
  const expect = Array.from({ length: Math.floor(max / k) + 1 }, (_, i) => i * k)
  return expect.length === nums.length && expect.every((v, i) => v === nums[i]) ? k : 0
}

function isRun(nums: number[]): boolean {
  return nums.length >= 2 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1)
}

const pad = (n: number) => String(n).padStart(2, '0')

function weekText(dow: number[]): string {
  const key = dow.join(',')
  if (key === '1,2,3,4,5') return '工作日（周一至周五）'
  if (key === '1,2,3,4,5,6') return '周一至周六'
  if (key === '0,6') return '周末'
  const mondayFirst = [...dow.filter((d) => d !== 0), ...(dow.includes(0) ? [7] : [])]
  if (mondayFirst.length >= 3 && isRun(mondayFirst)) {
    return `周${WEEK_CN[mondayFirst[0] % 7]}至周${WEEK_CN[mondayFirst[mondayFirst.length - 1] % 7]}`
  }
  return `每周${mondayFirst.map((d) => WEEK_CN[d % 7]).join('、')}`
}

function datePart(c: ParsedCron): string {
  const allDays = c.days.length === 31
  const allWeek = c.weekdays.length === 7
  const allMonths = c.months.length === 12
  let s: string
  if (allDays && allWeek) s = '每天'
  else if (!allDays && allWeek) s = allMonths ? `每月 ${listText(c.days)} 日` : `${listText(c.days)} 日`
  else if (allDays) s = weekText(c.weekdays)
  else s = `${allMonths ? '每月 ' : ''}${listText(c.days)} 日且当天是${weekText(c.weekdays).replace(/^每/, '')}`
  return allMonths ? s : `${listText(c.months)} 月${s === '每天' ? '每天' : `的 ${s}`}`
}

function timePart(c: ParsedCron): string {
  const { hours, minutes } = c
  const allH = hours.length === 24
  const allM = minutes.length === 60
  const stepM = stepOf(minutes, 59)
  const stepH = stepOf(hours, 23)
  const minOfHour = minutes.length === 1 ? (minutes[0] === 0 ? '整点' : `第 ${minutes[0]} 分`) : `第 ${listText(minutes)} 分`
  const hourRange = isRun(hours) ? `${hours[0]} 点至 ${hours[hours.length - 1]} 点` : `${listText(hours)} 点`

  if (allM) return allH ? '每分钟' : `${hourRange}每分钟`
  if (stepM) return allH ? `每 ${stepM} 分钟` : `${hourRange}每 ${stepM} 分钟`
  if (allH) return `每小时${minOfHour}`
  if (stepH && minutes.length === 1) return `每 ${stepH} 小时（${minOfHour}）`
  if (hours.length * minutes.length <= 6) return hours.flatMap((h) => minutes.map((m) => `${h}:${pad(m)}`)).join('、')
  return `${hourRange}每小时${minOfHour}`
}

/** 中文解读，如「工作日（周一至周五）8:30」；无效时 ok = false 并给出原因 */
export function describeCron(expr: string): { ok: true; text: string } | { ok: false; error: string } {
  let c: ParsedCron
  try {
    c = parseCron(expr)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const date = datePart(c)
  const time = timePart(c)
  let text = date === '每天' && time.startsWith('每') ? time : `${date} ${time}`
  if (c.seconds.length === 60) text += '，每秒都执行'
  else if (c.seconds.join() !== '0') text += `（第 ${listText(c.seconds)} 秒）`
  return { ok: true, text }
}

const HOUR = 3600_000
const CHINA_OFFSET = 8 * HOUR

/**
 * 从 from 之后（不含当前这一分钟）算接下来 count 次执行时间，返回中国时间的文字，如「10/23 周五 08:00」。
 * 只精确到分钟；最多向后找约 5 年，永不执行（如 2 月 31 日）返回空数组。表达式无效时抛错。
 */
export function nextCronRuns(expr: string, count = 3, from: Date = new Date()): string[] {
  const c = parseCron(expr)
  const minutes = new Set(c.minutes)
  const hours = new Set(c.hours)
  const days = new Set(c.days)
  const months = new Set(c.months)
  const weekdays = new Set(c.weekdays)
  // 用 UTC 字段表示中国墙钟时间，避免依赖浏览器时区
  let t = Math.floor((from.getTime() + CHINA_OFFSET) / 60_000) * 60_000 + 60_000
  const end = t + 5 * 366 * 24 * HOUR
  const out: string[] = []
  while (out.length < count && t < end) {
    const d = new Date(t)
    if (!months.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    } else if (!days.has(d.getUTCDate()) || !weekdays.has(d.getUTCDay())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    } else if (!hours.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
    } else {
      if (minutes.has(d.getUTCMinutes())) {
        out.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()} 周${WEEK_CN[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`)
      }
      t += 60_000
    }
  }
  return out
}
