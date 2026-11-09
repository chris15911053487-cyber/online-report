// 对话框「按住说话」：浏览器录音 → 16k 单声道 WAV → POST /speech/recognize（百度短语音）
// 录音与 WAV 编码逻辑与 public/js/voice.js 一致

import { apiFetch } from './api'

/** 百度短语音识别上限 60 秒 */
export const MAX_RECORD_MS = 60_000

/** 百度只认 8k / 16k，统一按 16k 上传 */
export const ASR_SAMPLE_RATE = 16000
/** 松开后再多录一会儿：人常常最后一个字没说完就松手 */
const TAIL_MS = 300

export interface Recording {
  /** 停止录音（含松开后的尾巴），返回处理好的 16k 单声道采样（已降采样、裁掉首尾静音） */
  stop(): Promise<Float32Array>
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

/**
 * 开始录音。等麦克风真正出数据才 resolve，界面据此提示「请说话」，避免开头吞字。
 */
export async function startRecording(): Promise<Recording> {
  let stream: MediaStream
  try {
    // 浏览器自带降噪 / 回声消除 / 自动增益：车间噪音、离麦远时识别率差别很大
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (e) {
    throw new Error('请允许使用麦克风', { cause: e })
  }
  const Ctor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let ctx: AudioContext
  try {
    ctx = new Ctor({ sampleRate: ASR_SAMPLE_RATE })
  } catch {
    // 部分内核不支持指定采样率：按设备默认（44.1k / 48k）录，结束后再降采样
    try {
      ctx = new Ctor()
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('录音启动失败: ' + ((e as Error).message || 'unknown'), { cause: e })
    }
  }
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(2048, 1, 1)
  const chunks: Float32Array[] = []
  let lastLevel = 0
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => { markReady = resolve })

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
    markReady()
  }

  source.connect(processor)
  // 连到静音 GainNode 而非直接到 destination，避免回声
  const silence = ctx.createGain()
  silence.gain.value = 0
  processor.connect(silence)
  silence.connect(ctx.destination)

  let released = false
  const release = () => {
    if (released) return
    released = true
    source.disconnect()
    processor.disconnect()
    silence.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }

  // 有的浏览器 AudioContext 起来是 suspended，要手动恢复
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  // 最多等 1.5 秒，拿不到数据也放行（至少不卡住界面）
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))])

  return {
    async stop() {
      await new Promise((r) => setTimeout(r, TAIL_MS))
      const rate = ctx.sampleRate
      release()
      return trimSilence(resampleTo16k(mergeChunks(chunks), rate), ASR_SAMPLE_RATE)
    },
    cancel: release,
    level: () => lastLevel,
  }
}

export function mergeChunks(chunks: Float32Array[]): Float32Array {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Float32Array(len)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * 降采样到 16k：每个输出点取对应输入区间的平均值（同时起低通作用，避免混叠）。
 * 已是 16k 原样返回。
 */
export function resampleTo16k(samples: Float32Array, rate: number): Float32Array {
  if (!rate || rate === ASR_SAMPLE_RATE) return samples
  const ratio = rate / ASR_SAMPLE_RATE
  const outLen = Math.floor(samples.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const from = Math.floor(i * ratio)
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = from; j < to; j++) sum += samples[j]
    out[i] = sum / (to - from)
  }
  return out
}

/**
 * 裁掉首尾静音（各留 200ms 余量）。按 20ms 帧算 RMS，高于「最响帧的 10%」且高于底噪门限的算有声；
 * 找不到有声帧时原样返回，交给识别服务判断。
 */
export function trimSilence(samples: Float32Array, rate: number, keepMs = 200): Float32Array {
  const frame = Math.max(1, Math.round(rate * 0.02))
  const frames = Math.floor(samples.length / frame)
  if (frames === 0) return samples
  const rms = new Float32Array(frames)
  let max = 0
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i]
    rms[f] = Math.sqrt(sum / frame)
    if (rms[f] > max) max = rms[f]
  }
  const threshold = Math.max(0.01, max * 0.1)
  let first = -1
  let last = -1
  for (let f = 0; f < frames; f++) {
    if (rms[f] >= threshold) {
      if (first < 0) first = f
      last = f
    }
  }
  if (first < 0) return samples
  const keep = Math.round((rate * keepMs) / 1000)
  const start = Math.max(0, first * frame - keep)
  const end = Math.min(samples.length, (last + 1) * frame + keep)
  return samples.subarray(start, end)
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

export async function recognizeSpeech(samples: Float32Array): Promise<string> {
  const audio = arrayBufferToBase64(pcmChunksToWav([samples], ASR_SAMPLE_RATE))
  const data = await apiFetch('/speech/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio, format: 'wav', rate: ASR_SAMPLE_RATE }),
  })
  return String(data?.text || '').trim()
}
