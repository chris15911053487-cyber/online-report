/**
 * 通知时间显示。库里存的是中国墙钟时间（DATETIME2），接口原样返回成 "2026-10-10T09:00:00.000Z"，
 * 末尾的 Z 并不代表 UTC——按字符串取年月日时分，不经 Date 换算时区。
 */
export function fmtWallClock(s: string | null | undefined, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''))
  if (!m) return ''
  const [, y, mo, d, h, mi] = m
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (`${y}-${mo}-${d}` === today) return `今天 ${h}:${mi}`
  if (Number(y) === now.getFullYear()) return `${mo}-${d} ${h}:${mi}`
  return `${y}-${mo}-${d} ${h}:${mi}`
}

/** 通知来源 → 标签 */
export const SOURCE_LABELS: Record<string, string> = {
  alert: '警报',
  report: '报告',
}
