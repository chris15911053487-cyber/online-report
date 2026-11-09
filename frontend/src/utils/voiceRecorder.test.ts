import { describe, expect, it } from 'vitest'
import { mergeChunks, pcmChunksToWav, resampleTo16k, trimSilence } from './voiceRecorder'

describe('pcmChunksToWav', () => {
  it('写出 16k 单声道 16bit WAV 头，数据长度等于采样数 × 2', () => {
    const buf = pcmChunksToWav([new Float32Array([0, 0.5]), new Float32Array([-1, 2])], 16000)
    const v = new DataView(buf)
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n))
    expect(buf.byteLength).toBe(44 + 8)
    expect(str(0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 8)
    expect(str(8, 4)).toBe('WAVE')
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(8)
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(48, true)).toBe(-0x8000)
    // 超出 [-1, 1] 的样本被截断
    expect(v.getInt16(50, true)).toBe(0x7fff)
  })
})

describe('resampleTo16k', () => {
  it('48k → 16k 长度为三分之一，直流信号保持', () => {
    const out = resampleTo16k(new Float32Array(4800).fill(0.25), 48000)
    expect(out.length).toBe(1600)
    expect(out.every((x) => Math.abs(x - 0.25) < 1e-6)).toBe(true)
  })
  it('44.1k → 16k 长度按比例', () => {
    expect(resampleTo16k(new Float32Array(44100), 44100).length).toBe(16000)
  })
  it('已是 16k 原样返回', () => {
    const a = new Float32Array(10)
    expect(resampleTo16k(a, 16000)).toBe(a)
  })
})

describe('trimSilence', () => {
  const rate = 16000
  it('裁掉首尾静音，各留 200ms', () => {
    // 1 秒静音 + 0.5 秒有声 + 1 秒静音
    const a = new Float32Array(rate * 2.5)
    for (let i = rate; i < rate * 1.5; i++) a[i] = i % 2 ? 0.3 : -0.3
    const out = trimSilence(a, rate)
    expect(out.length).toBe(rate * 0.5 + rate * 0.4)
  })
  it('全是静音时原样返回', () => {
    const a = new Float32Array(rate)
    expect(trimSilence(a, rate).length).toBe(rate)
  })
})

describe('mergeChunks', () => {
  it('按顺序拼接', () => {
    expect(Array.from(mergeChunks([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })
})
