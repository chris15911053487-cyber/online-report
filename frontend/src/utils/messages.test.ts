import { describe, expect, it } from 'vitest'
import { fmtWallClock } from './messages'

describe('fmtWallClock', () => {
  const now = new Date(2026, 9, 10, 15, 0) // 本地 2026-10-10 15:00

  it('按字符串取墙钟时间，不做时区换算', () => {
    expect(fmtWallClock('2026-10-10T09:05:00.000Z', now)).toBe('今天 09:05')
    expect(fmtWallClock('2026-10-09T23:59:59.000Z', now)).toBe('10-09 23:59')
    expect(fmtWallClock('2025-12-31 08:00:00', now)).toBe('2025-12-31 08:00')
  })

  it('空值或格式不对返回空串', () => {
    expect(fmtWallClock(null, now)).toBe('')
    expect(fmtWallClock('abc', now)).toBe('')
  })
})
