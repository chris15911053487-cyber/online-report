// 对话框「按住说话」：浏览器录音 → 16k 单声道 WAV → POST /speech/recognize（百度短语音）
// 录音与 WAV 编码逻辑与 public/js/voice.js 一致

import { apiFetch } from './api'

/** 百度短语音识别上限 60 秒 */
export const MAX_RECORD_MS = 60_000

export interface Recording {
  /** 停止录音并返回采集到的 PCM */
  stop(): { chunks: Float32Array[]; sampleRate: number }
  /** 放弃本次录音 */
  cancel(): void
  /** 最近一帧的音量（0~1），给按住时的音量条用 */
  level(): number
}

/** App 壳内由原生语音钮负责（结果经 voice.js 填入输入框），这里不显示 */
export function voiceInputSupported(): boolean {
  if (typeof window === 'undefined') return false
  if ((window as Window & { ReactNativeWebView?: unknown }).ReactNativeWebView) return false
  return !!navigator.mediaDevices?.getUserMedia
}

export async function startRecording(): Promise<Recording> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    throw new Error('请允许使用麦克风', { cause: e })
  }
  const Ctor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let ctx: AudioContext
  try {
    // 百度 ASR 只支持 8000/16000 采样率
    ctx = new Ctor({ sampleRate: 16000 })
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('录音启动失败: ' + ((e as Error).message || 'unknown'), { cause: e })
  }
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let lastLevel = 0

  processor.onaudioprocess = (e) => {
    const inCh = e.inputBuffer.getChannelData(0)
    const outCh = e.outputBuffer.getChannelData(0)
    let peak = 0
    for (let i = 0; i < inCh.length; i++) {
      // 数据直通：部分浏览器需要此通路才产生真实数据
      outCh[i] = inCh[i]
      const a = Math.abs(inCh[i])
      if (a > peak) peak = a
    }
    lastLevel = peak
    chunks.push(new Float32Array(inCh))
  }

  source.connect(processor)
  // 连到静音 GainNode 而非直接到 destination，避免回声
  const silence = ctx.createGain()
  silence.gain.value = 0
  processor.connect(silence)
  silence.connect(ctx.destination)

  const release = () => {
    source.disconnect()
    processor.disconnect()
    silence.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }

  return {
    stop() {
      release()
      return { chunks, sampleRate: ctx.sampleRate }
    },
    cancel: release,
    level: () => lastLevel,
  }
}

export function pcmChunksToWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  let len = 0
  for (const c of chunks) len += c.length
  const buf = new ArrayBuffer(44 + len * 2)
  const v = new DataView(buf)
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  v.setUint32(4, 36 + len * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  v.setUint32(16, 16, true) // chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  v.setUint32(40, len * 2, true)
  let off = 44
  for (const c of chunks) {
    for (let j = 0; j < c.length; j++) {
      const s = Math.max(-1, Math.min(1, c[j]))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return buf
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // 分段拼接，避免长录音时 apply 参数过多
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export async function recognizeSpeech(chunks: Float32Array[], sampleRate: number): Promise<string> {
  const audio = arrayBufferToBase64(pcmChunksToWav(chunks, sampleRate))
  const data = await apiFetch('/speech/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio, format: 'wav', rate: sampleRate }),
  })
  return String(data?.text || '').trim()
}
