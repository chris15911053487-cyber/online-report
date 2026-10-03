/**
 * 看板点击浮层：所有元素通用的三个动作。
 *   ✨ AI 解读（默认，快模型）/ ⤵ 下钻到 xx（有下一级时）/ 问点别的…（上下文带进输入框）
 * Esc 或点外部关闭；打开时焦点落在第一个按钮。
 */
import { useEffect, useRef } from 'react'
import { CornerRightDown, MessageSquarePlus, Sparkles } from 'lucide-react'

interface Props {
  x: number
  y: number
  title: string
  drillLabel: string | null
  onExplain: () => void
  onDrill: () => void
  onAsk: () => void
  onClose: () => void
}

const W = 220
const TITLE_H = 30
const ITEM_H = 37

/** 贴边时翻到另一侧，保证完整显示在视口内（高度按条目数计算，无需测量 DOM） */
function place(x: number, y: number, items: number) {
  const h = TITLE_H + ITEM_H * items + 12
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight
  const left = Math.max(8, Math.min(x + 8, vw - W - 8))
  const top = y + 8 + h > vh - 8 ? Math.max(8, y - h - 8) : y + 8
  return { left, top }
}

export default function BiPickPopover({ x, y, title, drillLabel, onExplain, onDrill, onAsk, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const pos = place(x, y, drillLabel ? 3 : 2)

  useEffect(() => {
    firstRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    // 延后注册，避免触发本次打开的那次点击立即把浮层关掉
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('touchstart', onDown)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [onClose])

  const item = 'w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] rounded-lg hover:bg-primary-soft/60 focus:bg-primary-soft/60 focus:outline-none'

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${title} 的操作`}
      className="fixed z-[1000] bg-surface rounded-xl border border-line shadow-lg p-1.5"
      style={{ left: pos.left, top: pos.top, width: W }}
    >
      <div className="px-3 pt-1 pb-1.5 text-[11px] text-subtle truncate" title={title}>{title}</div>
      <button ref={firstRef} role="menuitem" className={`${item} text-primary`} onClick={onExplain}>
        <Sparkles className="w-4 h-4 shrink-0" />
        <span className="font-medium">AI 解读</span>
      </button>
      {drillLabel && (
        <button role="menuitem" className={`${item} text-fg`} onClick={onDrill}>
          <CornerRightDown className="w-4 h-4 shrink-0 text-subtle" />
          下钻到「{drillLabel}」
        </button>
      )}
      <button role="menuitem" className={`${item} text-fg`} onClick={onAsk}>
        <MessageSquarePlus className="w-4 h-4 shrink-0 text-subtle" />
        问点别的…
      </button>
    </div>
  )
}
