import { useCallback, useMemo, useRef } from 'react'

/** 发给 /ai/agent/chat 的语音标记 */
export interface VoiceSendFields {
  inputMode?: 'voice'
  voiceLogId?: number
}

/**
 * 记住输入框里的文字是否来自语音识别（按住说话 / 悬浮语音钮）。
 * 发送时 take() 取出 { inputMode: 'voice', voiceLogId }：ai-agent 据此提示模型「可能有同音字，先写明按什么条件查」，
 * 后端据 voiceLogId 记下用户实际发出的文字（与识别结果对比 = 识别错误样本）。输入框清空时 reset()。
 */
export function useVoiceDraft() {
  const ref = useRef<{ voice: boolean; logId: number | null }>({ voice: false, logId: null })

  const mark = useCallback((logId?: number | null) => {
    // 一条消息里说了几段：记第一段的识别记录（后面几段各有记录，不重复回写）
    ref.current = { voice: true, logId: ref.current.logId ?? logId ?? null }
  }, [])

  const reset = useCallback(() => {
    ref.current = { voice: false, logId: null }
  }, [])

  const take = useCallback((): VoiceSendFields => {
    const v = ref.current
    ref.current = { voice: false, logId: null }
    if (!v.voice) return {}
    return v.logId ? { inputMode: 'voice', voiceLogId: v.logId } : { inputMode: 'voice' }
  }, [])

  return useMemo(() => ({ mark, reset, take }), [mark, reset, take])
}
