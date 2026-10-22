import { describe, expect, it } from 'vitest'
import { describeCron, nextCronRuns, parseCron } from './cron'

const text = (e: string) => {
  const r = describeCron(e)
  return r.ok ? r.text : `ERR ${r.error}`
}

describe('describeCron', () => {
  it('常见写法', () => {
    expect(text('0 8 * * 1-5')).toBe('工作日（周一至周五） 8:00')
    expect(text('30 8 * * *')).toBe('每天 8:30')
    expect(text('*/5 * * * *')).toBe('每 5 分钟')
    expect(text('0 */2 * * *')).toBe('每 2 小时（整点）')
    expect(text('0 * * * *')).toBe('每小时整点')
    expect(text('* * * * *')).toBe('每分钟')
    expect(text('0 9 1 * *')).toBe('每月 1 日 9:00')
    expect(text('0 9,18 * * 1')).toBe('每周一 9:00、18:00')
    expect(text('0 8 * * 0,6')).toBe('周末 8:00')
    expect(text('0 8 1 1,4,7,10 *')).toBe('1、4、7、10 月的 1 日 8:00')
    expect(text('*/10 8-18 * * 1-5')).toBe('工作日（周一至周五） 8 点至 18 点每 10 分钟')
    expect(text('0 8 * * MON-FRI')).toBe('工作日（周一至周五） 8:00')
  })

  it('node-cron 特有语义：日与周同时满足、步长按整除', () => {
    expect(text('0 8 1 * 1')).toBe('每月 1 日且当天是周一 8:00')
    expect(parseCron('0 8-18/5 * * *').hours).toEqual([10, 15])
    expect(parseCron('0 8 * * 7').weekdays).toEqual([0])
  })

  it('6 段带秒', () => {
    expect(text('30 0 8 * * *')).toBe('每天 8:00（第 30 秒）')
    expect(text('0 0 8 * * *')).toBe('每天 8:00')
  })

  it('无效表达式给原因', () => {
    expect(text('0 25 * * *')).toMatch(/「时」超出范围/)
    expect(text('0 8 * *')).toMatch(/5 段/)
    expect(text('0 8 L * *')).toMatch(/「日」写法不认识/)
  })
})

describe('nextCronRuns', () => {
  // 2026-10-22（周四）10:00 中国时间
  const from = new Date('2026-10-22T02:00:00Z')
  it('按中国时间算', () => {
    expect(nextCronRuns('0 8 * * 1-5', 3, from)).toEqual(['10/23 周五 08:00', '10/26 周一 08:00', '10/27 周二 08:00'])
    expect(nextCronRuns('*/15 * * * *', 2, from)).toEqual(['10/22 周四 10:15', '10/22 周四 10:30'])
    expect(nextCronRuns('0 9 1 * *', 2, from)).toEqual(['11/1 周日 09:00', '12/1 周二 09:00'])
  })
  it('永不执行返回空', () => {
    expect(nextCronRuns('0 8 31 2 *', 3, from)).toEqual([])
  })
})
