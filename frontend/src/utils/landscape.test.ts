import { describe, expect, it } from 'vitest'
import { contentDelta, needsCssRotate, swipeStep } from './landscape'

describe('横屏查看', () => {
  it('视口竖着才需要 CSS 旋转', () => {
    expect(needsCssRotate(390, 844)).toBe(true)
    expect(needsCssRotate(844, 390)).toBe(false)
  })

  it('旋转 90° 时屏幕位移换算到内容坐标：屏幕下方 = 内容右方', () => {
    expect(contentDelta(10, 20, false)).toEqual({ x: 10, y: 20 })
    expect(contentDelta(10, 20, true)).toEqual({ x: 20, y: -10 })
  })

  it('翻页：手指往左 = 下一张，往右 = 上一张；距离不够或偏竖向不翻', () => {
    expect(swipeStep(-80, 5, false)).toBe(1)
    expect(swipeStep(80, 5, false)).toBe(-1)
    expect(swipeStep(-30, 0, false)).toBe(0)
    expect(swipeStep(-80, 70, false)).toBe(0)
    // 内容旋转后：手指往屏幕上方滑 = 内容往左 = 下一张
    expect(swipeStep(0, -80, true)).toBe(1)
    expect(swipeStep(0, 80, true)).toBe(-1)
    expect(swipeStep(-80, 0, true)).toBe(0)
  })
})
