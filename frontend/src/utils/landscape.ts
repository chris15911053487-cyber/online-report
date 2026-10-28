/**
 * 手机横屏查看（看板卡片全屏）：
 * - 钉钉：JSAPI dd.device.screen.rotateView 旋转界面
 * - 安卓浏览器：进入浏览器全屏后 screen.orientation.lock('landscape')
 * - 都转不了（iOS、微信、App 壳锁定竖屏）：视口仍是竖的，由查看器把内容用 CSS 旋转 90°
 * 是否需要 CSS 旋转只看视口宽高（needsCssRotate），所以手机自己转过来时也不会转两次。
 */
import { isDingTalkEnv } from './dingtalk'

interface ScreenOrientationLock {
  lock?: (o: string) => Promise<void>
  unlock?: () => void
}

function ddScreen() {
  return isDingTalkEnv() ? window.dd?.device?.screen : undefined
}

/** 进入横屏；须在点击回调里同步调用（浏览器全屏要求用户手势）。转不了不报错 */
export function enterLandscape(): void {
  const screenApi = ddScreen()
  if (screenApi?.rotateView) {
    try {
      screenApi.rotateView({ showStatusBar: false, clockwise: true })
    } catch {
      /* 旧版钉钉没有这个接口：退回 CSS 旋转 */
    }
    return
  }
  const el = document.documentElement
  if (document.fullscreenElement || !el.requestFullscreen) return
  el.requestFullscreen()
    .then(() => (screen.orientation as ScreenOrientationLock | undefined)?.lock?.('landscape'))
    .catch(() => {})
}

/** 退出横屏：解锁方向、退出浏览器全屏、钉钉恢复竖屏 */
export function exitLandscape(): void {
  const screenApi = ddScreen()
  if (screenApi?.resetView) {
    try {
      screenApi.resetView({})
    } catch {
      /* 忽略 */
    }
  }
  try {
    ;(screen.orientation as ScreenOrientationLock | undefined)?.unlock?.()
  } catch {
    /* 未锁定时部分浏览器会抛错 */
  }
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
}

/** 视口还是竖的（没能真正横过来）：内容需要 CSS 旋转 90° */
export function needsCssRotate(width: number, height: number): boolean {
  return height > width
}

/**
 * 手指在屏幕上的位移 → 内容坐标系里的位移。
 * CSS 旋转为顺时针 90°（translate(W, 0) rotate(90deg)）：内容的 +x 朝屏幕下方、+y 朝屏幕左方。
 */
export function contentDelta(dx: number, dy: number, rotated: boolean): { x: number; y: number } {
  return rotated ? { x: dy, y: -dx } : { x: dx, y: dy }
}

/** 至少滑这么远（px）才翻页 */
export const SWIPE_MIN = 50

/** 一次滑动是否翻页：1 下一张（手指往左）、-1 上一张、0 不翻（距离不够或偏竖向） */
export function swipeStep(dx: number, dy: number, rotated: boolean): -1 | 0 | 1 {
  const d = contentDelta(dx, dy, rotated)
  if (Math.abs(d.x) < SWIPE_MIN || Math.abs(d.x) < Math.abs(d.y) * 1.5) return 0
  return d.x < 0 ? 1 : -1
}

/**
 * 手指下面有能横向滚动、且还能往这个方向滚的区域（宽表格）时，先让它滚，不翻页。
 * step：1 = 想看右边（scrollLeft 增大）、-1 = 想看左边。
 */
export function canScrollInside(target: EventTarget | null, root: HTMLElement, step: -1 | 1): boolean {
  let el = target instanceof HTMLElement ? target : null
  while (el && el !== root) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') {
        if (step === 1 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true
      }
    }
    el = el.parentElement
  }
  return false
}
