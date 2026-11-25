import { useEffect, useRef, useState } from 'react'
import { useHoldToTalk } from '../hooks/useHoldToTalk'
import { cn } from '../ui/classes'

/** 按住超过此时长才开始录音，更短算轻点（打字） */
const LONG_PRESS_MS = 300
/** 长按判定前手指移动超过此距离，视为滑动 / 选字，不录音 */
const MOVE_TOLERANCE = 10

/**
 * 手机对话输入框的按住说话（学微信），两种用法：
 * - 默认「可按住 转文字」：盖在空输入框上，轻点 → onTap（页面聚焦输入框、弹键盘）；按住 → 录音，松开识别，上滑取消。
 *   只在输入框为空且未聚焦时渲染（打了字 / 键盘弹出后按住恢复系统的选字、粘贴）。
 *   用一层 div 盖住而不直接给 input 挂事件：避免长按弹出系统「粘贴 / 全选」菜单、一按就弹键盘。
 *   父元素须 position: relative；输入框自己的 placeholder 由页面在此期间置空。
 * - instant：语音模式下顶替输入框的「按住 说话」长条，一按就录（页面在 onText 里直接发送）。
 */
export default function HoldToTalkPad({
  onText,
  onTap,
  instant,
  disabled,
  className = 'absolute inset-0',
}: {
  onText: (text: string, logId: number | null) => void
  onTap?: () => void
  /** 一按就开始录音（语音模式长条），没有轻点 */
  instant?: boolean
  disabled?: boolean
  /** 位置（覆盖范围）、内边距、圆角、字号；默认 absolute inset-0 */
  className?: string
}) {
  const hold = useHoldToTalk(onText)
  const { phase } = hold
  const [pressing, setPressing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const startRef = useRef({ x: 0, y: 0 })
  /** 本次按下已进入录音 / 已滑开：松开后的 click 不当作轻点 */
  const noTapRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }
  useEffect(() => clearTimer, [])

  if (!hold.supported) return null

  const label =
    phase === 'recognizing' ? '识别中…'
      : phase === 'recording' ? (hold.cancelArmed ? '松开 取消' : '松开 结束')
        : instant ? '按住 说话' : '可按住 转文字'

  return (
    <>
      <div
        role="button"
        tabIndex={-1}
        aria-label={instant ? '按住说话，松开发送' : '轻点输入，按住说话转文字'}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => {
          if (disabled || phase !== 'idle') return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          startRef.current = { x: e.clientX, y: e.clientY }
          if (instant) {
            noTapRef.current = true
            void hold.begin(e.clientY)
            return
          }
          noTapRef.current = false
          setPressing(true)
          const y = e.clientY
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            noTapRef.current = true
            void hold.begin(y)
          }, LONG_PRESS_MS)
        }}
        onPointerMove={(e) => {
          if (timerRef.current != null) {
            const dx = e.clientX - startRef.current.x
            const dy = e.clientY - startRef.current.y
            if (Math.hypot(dx, dy) > MOVE_TOLERANCE) {
              clearTimer()
              noTapRef.current = true
              setPressing(false)
            }
            return
          }
          hold.move(e.clientY)
        }}
        onPointerUp={() => {
          clearTimer()
          setPressing(false)
          hold.end()
        }}
        onPointerCancel={() => {
          clearTimer()
          noTapRef.current = true
          setPressing(false)
          hold.abort()
        }}
        // 聚焦放在 click 里：iOS 只在点击类手势里允许 focus() 弹出键盘
        onClick={() => {
          if (noTapRef.current || phase !== 'idle') return
          onTap?.()
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'flex items-center select-none touch-none transition-colors',
          instant ? 'cursor-pointer' : 'cursor-text',
          disabled && 'opacity-50',
          phase === 'recording'
            ? hold.cancelArmed ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary'
            : pressing ? 'bg-surface-2 text-muted' : instant ? 'text-fg' : 'text-subtle',
          className,
        )}
        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
      >
        {phase === 'recognizing' && (
          <span className="w-3.5 h-3.5 mr-2 rounded-full border-2 border-current border-t-transparent animate-spin" />
        )}
        {label}
      </div>
      {hold.overlay}
    </>
  )
}
