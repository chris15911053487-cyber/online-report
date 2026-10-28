/**
 * 手机上的卡片全屏：横屏查看，左右滑动切换看板里的图表 / 表格卡片（KPI 不参与）。
 * 能真正横屏时（钉钉、安卓浏览器）直接铺满；转不了时把内容 CSS 旋转 90°，手机横过来看。
 * 占一条历史：返回键先关查看器。宽表格还能往滑动方向滚时先滚表格，滚到头再翻页。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { openHistoryOverlay, type OverlayHandle } from '../../router'
import type { BiCard } from '../../utils/bi'
import { canScrollInside, contentDelta, exitLandscape, needsCssRotate, swipeStep } from '../../utils/landscape'

interface Props {
  cards: BiCard[]
  startId: string
  /** 渲染一张卡片（嵌入模式，退出按钮由上层接到 onClose） */
  renderCard: (card: BiCard) => React.ReactNode
  /** 关闭（上层卸载查看器即可；退横屏、退历史条目在卸载时完成） */
  onClose: () => void
}

const MAX_DOTS = 12

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const on = () => setSize(read())
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    return () => {
      window.removeEventListener('resize', on)
      window.removeEventListener('orientationchange', on)
    }
  }, [])
  return size
}

export default function LandscapeViewer({ cards, startId, renderCard, onClose }: Props) {
  const [index, setIndex] = useState(() => Math.max(0, cards.findIndex((c) => c.id === startId)))
  // 看过的卡片保持挂载（保留下钻、不重复取数）；首次只挂当前与相邻两张
  const [visited, setVisited] = useState<Set<number>>(() => new Set([index]))
  const [drag, setDrag] = useState(0)
  const { w, h } = useViewport()
  const rotated = needsCssRotate(w, h)
  const rootRef = useRef<HTMLDivElement>(null)
  const touch = useRef<{ x: number; y: number; axis: 'x' | 'y' | null; blocked: boolean } | null>(null)

  // ── 关闭：退横屏 + 退历史条目 ──
  const handleRef = useRef<OverlayHandle | null>(null)
  const closedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  const finish = useCallback((fromHistory: boolean) => {
    if (closedRef.current) return
    closedRef.current = true
    if (!fromHistory) handleRef.current?.close()
    handleRef.current = null
    exitLandscape()
    onCloseRef.current()
  }, [])
  const close = useCallback(() => finish(false), [finish])

  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (!handleRef.current) handleRef.current = openHistoryOverlay(window.location.search, () => finish(true))
    // 浏览器全屏被系统手势退出（安卓返回键先退全屏）时，一并关闭
    let wasFull = !!document.fullscreenElement
    const onFs = () => {
      if (wasFull && !document.fullscreenElement) finish(false)
      wasFull = !!document.fullscreenElement
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      mounted.current = false
      // 卸载（上层关闭、换页面）时收尾；推迟一拍，StrictMode 的「卸载 → 立即重新挂载」不算
      setTimeout(() => {
        if (!mounted.current) finish(false)
      }, 0)
    }
  }, [finish])

  const go = useCallback(
    (to: number) => {
      const next = Math.max(0, Math.min(cards.length - 1, to))
      setIndex(next)
      setVisited((s) => (s.has(next) ? s : new Set(s).add(next)))
    },
    [cards.length],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight') go(index + 1)
      else if (e.key === 'ArrowLeft') go(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, go, index])

  // ── 滑动：跟手拖动，松手过阈值翻页 ──
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      touch.current = null
      return
    }
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, axis: null, blocked: false }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const t = touch.current
    if (!t || t.blocked) return
    const d = contentDelta(e.touches[0].clientX - t.x, e.touches[0].clientY - t.y, rotated)
    if (!t.axis) {
      if (Math.abs(d.x) < 8 && Math.abs(d.y) < 8) return
      t.axis = Math.abs(d.x) > Math.abs(d.y) ? 'x' : 'y'
      // 表格还能往这边滚：交给表格
      if (t.axis === 'x' && canScrollInside(e.target, rootRef.current!, d.x < 0 ? 1 : -1)) t.blocked = true
    }
    if (t.axis !== 'x' || t.blocked) return
    // 第一张往右、最后一张往左：阻尼
    const edge = (index === 0 && d.x > 0) || (index === cards.length - 1 && d.x < 0)
    setDrag(edge ? d.x / 3 : d.x)
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const t = touch.current
    touch.current = null
    setDrag(0)
    if (!t || t.blocked || t.axis !== 'x') return
    const p = e.changedTouches[0]
    const step = swipeStep(p.clientX - t.x, p.clientY - t.y, rotated)
    if (step) go(index + step)
  }

  // 竖屏视口：内容宽高互换，顺时针转 90°
  const frame: React.CSSProperties = rotated
    ? { width: h, height: w, transform: `translate(${w}px, 0) rotate(90deg)`, transformOrigin: 'top left' }
    : { width: w, height: h }

  return createPortal(
    <div className="fixed inset-0 z-[95] bg-surface overflow-hidden" role="dialog" aria-modal aria-label="横屏查看卡片">
      <div ref={rootRef} className="absolute top-0 left-0 flex flex-col overscroll-contain" style={frame}>
        <div className="flex-1 min-h-0 overflow-hidden" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={() => { touch.current = null; setDrag(0) }}>
          <div
            className={`flex h-full w-full ${drag ? '' : 'transition-transform duration-300 ease-out'}`}
            style={{ transform: `translateX(calc(${-index * 100}% + ${drag}px))` }}
          >
            {cards.map((card, i) => (
              <div key={card.id} className="w-full h-full shrink-0 min-w-0" aria-hidden={i !== index || undefined}>
                {(visited.has(i) || Math.abs(i - index) <= 1) && renderCard(card)}
              </div>
            ))}
          </div>
        </div>

        {cards.length > 1 && (
          <nav className="shrink-0 flex items-center justify-center gap-3 py-1.5 text-[11.5px] text-subtle safe-bottom" aria-label="切换卡片">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0} className="p-1 rounded hover:bg-surface-2 disabled:opacity-30" aria-label="上一张">
              <ChevronLeft className="w-4 h-4" />
            </button>
            {cards.length <= MAX_DOTS ? (
              <span className="flex items-center gap-1.5">
                {cards.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => go(i)}
                    className={`h-1.5 rounded-full transition-all ${i === index ? 'w-4 bg-primary' : 'w-1.5 bg-line-strong'}`}
                    aria-label={`第 ${i + 1} 张：${c.title}`}
                    aria-current={i === index || undefined}
                  />
                ))}
              </span>
            ) : null}
            <span className="num">
              {index + 1} / {cards.length}
            </span>
            <span>左右滑动切换</span>
            <button type="button" onClick={() => go(index + 1)} disabled={index === cards.length - 1} className="p-1 rounded hover:bg-surface-2 disabled:opacity-30" aria-label="下一张">
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        )}
      </div>
    </div>,
    document.body,
  )
}
