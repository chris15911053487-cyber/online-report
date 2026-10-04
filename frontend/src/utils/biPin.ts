/**
 * 对话结果「📌 收藏到看板」：从一轮的工具步骤里找出 Agent 临时写的 SQL（run_sql），
 * 交给 BI 管理页（新标签页打开）走「AI 整理成命名查询 → 确认查询 → 确认图表」。
 * 跨标签页用 localStorage 传一次性的待收藏项，读到后即清除。
 */
import type { AgentToolStep } from '../components/AgentTracePanel'

export interface PendingPin {
  sql: string
  question: string
  at: number
}

const KEY = 'bi_pending_pin'
const MAX_AGE_MS = 10 * 60 * 1000

/** 本轮成功执行过的 run_sql（去重，保持顺序） */
export function pinnableSqls(steps?: AgentToolStep[]): string[] {
  const out: string[] = []
  for (const s of steps || []) {
    if (s.tool !== 'run_sql' || s.status === 'error') continue
    const sql = typeof s.args?.sql === 'string' ? s.args.sql.trim() : ''
    if (sql && !out.includes(sql)) out.push(sql)
  }
  return out
}

export function savePendingPin(sql: string, question: string, now = Date.now()) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sql, question, at: now }))
  } catch {
    /* 存不了就算了：BI 页不会自动打开收藏 */
  }
}

/** 读待收藏项（不清除；过期或格式不对返回 null） */
export function readPendingPin(now = Date.now()): PendingPin | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!v || typeof v.sql !== 'string' || !v.sql.trim() || typeof v.at !== 'number' || now - v.at > MAX_AGE_MS) return null
    return { sql: v.sql, question: typeof v.question === 'string' ? v.question : '', at: v.at }
  } catch {
    return null
  }
}

export function clearPendingPin() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
