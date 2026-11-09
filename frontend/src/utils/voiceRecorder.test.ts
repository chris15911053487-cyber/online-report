import { describe, expect, it } from 'vitest'
import { pcmChunksToWav } from './voiceRecorder'

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
