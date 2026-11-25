import { useCallback, useState } from 'react'

const STORAGE_KEY = 'online_report_chat_voice_mode'

function readPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 手机对话输入框左侧的「语音 / 键盘」切换（学微信）：语音模式下输入框换成「按住 说话」长条，松开识别后直接发送。
 * 选择记在本机，AI 助手与 Agent 对话共用。
 */
export function useChatVoiceMode() {
  const [voiceMode, setVoiceModeState] = useState(readPref)
  const setVoiceMode = useCallback((on: boolean) => {
    setVoiceModeState(on)
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
    } catch {
      // 无痕模式等：只在本页生效
    }
  }, [])
  return [voiceMode, setVoiceMode] as const
}
