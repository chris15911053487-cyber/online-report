import { describe, expect, it } from 'vitest'
import { addDays, dueLabel, dueTone, snoozeChoices } from './tasks'

describe('待办日期', () => {
  const today = '2026-10-22' // 周四

  it('dueLabel 与后端一致', () => {
    expect(dueLabel('2026-10-19', today)).toBe('超期 3 天')
    expect(dueLabel(today, today)).toBe('今天到期')
    expect(dueLabel('2026-10-23', today)).toBe('明天到期')
    expect(dueLabel('2026-10-30', today)).toBe('10-30 到期')
    expect(dueLabel(null, today)).toBe('')
  })

  it('dueTone：超期红、今天黄', () => {
    expect(dueTone('2026-10-21', today)).toBe('danger')
    expect(dueTone(today, today)).toBe('warning')
    expect(dueTone('2026-10-25', today)).toBe('neutral')
  })

  it('snoozeChoices：明天 / 3 天后 / 下周一；跨年', () => {
    expect(snoozeChoices(today).map((c) => c.value)).toEqual(['2026-10-23', '2026-10-25', '2026-10-26'])
    expect(snoozeChoices('2026-10-26')[2].value).toBe('2026-11-02')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})
