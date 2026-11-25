import { Keyboard, Mic } from 'lucide-react'
import { cn } from '../ui/classes'

/** 对话输入框左侧的「语音 / 键盘」切换钮（学微信） */
export default function VoiceModeToggle({
  voiceMode,
  onChange,
  className,
}: {
  voiceMode: boolean
  onChange: (voiceMode: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={voiceMode ? '切换到键盘输入' : '切换到语音发送'}
      title={voiceMode ? '键盘' : '语音'}
      onClick={() => onChange(!voiceMode)}
      className={cn(
        'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-fg-2 active:bg-surface-2 transition-colors',
        className,
      )}
    >
      {voiceMode ? <Keyboard size={20} /> : <Mic size={20} />}
    </button>
  )
}
