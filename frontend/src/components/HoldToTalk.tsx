import { useHoldToTalk } from '../hooks/useHoldToTalk'
import { cn } from '../ui/classes'

/**
 * 对话输入框旁的「按住说话」按钮（PC 用；手机改为按住输入框本身，见 HoldToTalkPad）：
 * 按住录音，松开识别，上滑取消。识别出的文字交给 onText（由页面填进输入框，不自动发送）。
 */
export default function HoldToTalk({
  onText,
  disabled,
  prominent,
  className = 'w-8 h-8 rounded-full',
}: {
  /** logId：后端识别记录 id（发送时带回，记下实际发出的文字） */
  onText: (text: string, logId: number | null) => void
  disabled?: boolean
  /** 主按钮样式（输入框为空时顶替发送钮，学微信） */
  prominent?: boolean
  /** 尺寸与圆角 */
  className?: string
}) {
  const hold = useHoldToTalk(onText)
  const { phase } = hold

  if (!hold.supported) return null

  return (
    <>
      <button
        type="button"
        aria-label="按住说话"
        title="按住说话"
        disabled={disabled || phase === 'recognizing'}
        onPointerDown={(e) => {
          if (disabled || phase !== 'idle') return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          void hold.begin(e.clientY)
        }}
        onPointerMove={(e) => hold.move(e.clientY)}
        onPointerUp={hold.end}
        onPointerCancel={hold.abort}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'flex items-center justify-center flex-shrink-0 select-none touch-none transition-colors disabled:opacity-40',
          phase === 'recording'
            ? 'bg-primary-hover text-primary-fg'
            : prominent ? 'bg-primary text-primary-fg' : 'text-muted active:bg-surface-2',
          className,
        )}
        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
      >
        {phase === 'recognizing' ? (
          <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        )}
      </button>
      {hold.overlay}
    </>
  )
}
