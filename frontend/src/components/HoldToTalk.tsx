import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { cn } from '../ui/classes'
import {
  MAX_RECORD_MS,
  recognizeSpeech,
  startRecording,
  voiceInputSupported,
  type Recording,
} from '../utils/voiceRecorder'

/** 短于此时长视为误触 */
const MIN_RECORD_MS = 500
/** 手指上滑超过此距离，松开即取消 */
const CANCEL_DISTANCE = 60

type Phase = 'idle' | 'recording' | 'recognizing'

/**
 * 对话输入框旁的「按住说话」按钮：按住录音，松开识别，上滑取消。
 * 识别出的文字交给 onText（由页面填进输入框，不自动发送）。
 */
export default function HoldToTalk({
  onText,
  disabled,
  className,
}: {
  onText: (text: string) => void
  disabled?: boolean
  className?: string
}) {
  const showToast = useStore((s) => s.showToast)
  const [supported] = useState(voiceInputSupported)
  const [phase, setPhase] = useState<Phase>('idle')
  const [cancelArmed, setCancelArmed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)

  const recRef = useRef<Recording | null>(null)
  const holdingRef = useRef(false)
  const startYRef = useRef(0)
  const startAtRef = useRef(0)
  const cancelArmedRef = useRef(false)
  const tickRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)

  const clearTimers = () => {
    if (tickRef.current != null) window.clearInterval(tickRef.current)
    if (maxTimerRef.current != null) window.clearTimeout(maxTimerRef.current)
    tickRef.current = null
    maxTimerRef.current = null
  }

  // 卸载时释放麦克风
  useEffect(() => () => {
    clearTimers()
    recRef.current?.cancel()
    recRef.current = null
  }, [])

  const finish = async (cancel: boolean) => {
    holdingRef.current = false
    clearTimers()
    const rec = recRef.current
    recRef.current = null
    setCancelArmed(false)
    cancelArmedRef.current = false
    if (!rec) {
      setPhase('idle')
      return
    }
    const duration = Date.now() - startAtRef.current
    if (cancel || duration < MIN_RECORD_MS) {
      rec.cancel()
      setPhase('idle')
      if (!cancel) showToast('说话时间太短')
      return
    }
    const { chunks, sampleRate } = rec.stop()
    setPhase('recognizing')
    try {
      const text = await recognizeSpeech(chunks, sampleRate)
      if (text) onText(text)
      else showToast('没听清，请再说一遍')
    } catch (e) {
      showToast((e as Error).message || '语音识别失败')
    } finally {
      setPhase('idle')
    }
  }

  const onPointerDown = async (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || phase !== 'idle') return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    holdingRef.current = true
    startYRef.current = e.clientY
    cancelArmedRef.current = false
    setCancelArmed(false)
    setElapsed(0)
    setLevel(0)
    setPhase('recording')
    let rec: Recording
    try {
      rec = await startRecording()
    } catch (err) {
      holdingRef.current = false
      setPhase('idle')
      showToast((err as Error).message)
      return
    }
    // 首次授权弹窗期间手指已松开：本次作废
    if (!holdingRef.current) {
      rec.cancel()
      setPhase('idle')
      return
    }
    recRef.current = rec
    startAtRef.current = Date.now()
    tickRef.current = window.setInterval(() => {
      setElapsed(Date.now() - startAtRef.current)
      setLevel(rec.level())
    }, 100)
    maxTimerRef.current = window.setTimeout(() => void finish(false), MAX_RECORD_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!holdingRef.current) return
    const armed = startYRef.current - e.clientY > CANCEL_DISTANCE
    if (armed !== cancelArmedRef.current) {
      cancelArmedRef.current = armed
      setCancelArmed(armed)
    }
  }

  const onPointerUp = () => {
    if (!holdingRef.current) return
    void finish(cancelArmedRef.current)
  }

  if (!supported) return null

  const secondsLeft = Math.ceil((MAX_RECORD_MS - elapsed) / 1000)
  const bars = [0.5, 0.8, 1, 0.8, 0.5]

  return (
    <>
      <button
        type="button"
        aria-label="按住说话"
        title="按住说话"
        disabled={disabled || phase === 'recognizing'}
        onPointerDown={(e) => void onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => holdingRef.current && void finish(true)}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 select-none touch-none transition-colors disabled:opacity-40',
          phase === 'recording' ? 'bg-primary text-primary-fg' : 'text-muted active:bg-surface-2',
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

      {phase === 'recording' &&
        createPortal(
          <div className="fixed inset-x-0 bottom-36 z-[60] flex justify-center pointer-events-none px-4">
            <div
              className={cn(
                'rounded-2xl px-6 py-4 shadow-lg flex flex-col items-center gap-2 min-w-[180px] transition-colors',
                cancelArmed ? 'bg-danger text-primary-fg' : 'bg-inverse text-inverse-fg',
              )}
            >
              <div className="flex items-end gap-1 h-8">
                {bars.map((w, i) => (
                  <span
                    key={i}
                    className="w-1.5 rounded-full bg-current transition-all duration-100"
                    style={{ height: `${Math.max(15, Math.min(100, level * 260 * w))}%`, opacity: cancelArmed ? 0.6 : 0.9 }}
                  />
                ))}
              </div>
              <div className="text-sm font-medium">
                {cancelArmed ? '松开 取消' : '松开 结束 · 上滑 取消'}
              </div>
              <div className="text-xs opacity-75 num">
                {secondsLeft <= 5 ? `${secondsLeft} 秒后自动结束` : `${Math.floor(elapsed / 1000)}″`}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
