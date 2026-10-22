/** 待办日期与文案（与 server/src/tasks.js 的 dueLabel / addDays 一致；日期都是 'YYYY-MM-DD' 中国日期） */

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** b - a 的天数 */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/** 到期提示：超期 3 天 / 今天到期 / 明天到期 / 10-25 到期 */
export function dueLabel(dueDate: string | null | undefined, today: string): string {
  if (!dueDate) return ''
  const diff = daysBetween(today, dueDate)
  if (diff < 0) return `超期 ${-diff} 天`
  if (diff === 0) return '今天到期'
  if (diff === 1) return '明天到期'
  return `${dueDate.slice(5)} 到期`
}

export function dueTone(dueDate: string | null | undefined, today: string): 'danger' | 'warning' | 'neutral' {
  if (!dueDate) return 'neutral'
  const diff = daysBetween(today, dueDate)
  return diff < 0 ? 'danger' : diff === 0 ? 'warning' : 'neutral'
}

/** 延后的快捷选项：明天、3 天后、下周一 */
export function snoozeChoices(today: string): { label: string; value: string }[] {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7 // 周一 = 0
  return [
    { label: '明天', value: addDays(today, 1) },
    { label: '3 天后', value: addDays(today, 3) },
    { label: '下周一', value: addDays(today, 7 - dow) },
  ]
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  snoozed: '已延后',
  done: '已处理',
  closed: '已关闭',
}

export const TASK_EVENT_LABELS: Record<string, string> = {
  create: '生成',
  done: '标为已处理',
  reopen: '重新打开',
  snooze: '延后',
  wake: '恢复待处理',
  transfer: '转交',
  note: '备注',
  close: '关闭',
  escalate: '升级给主管',
}
