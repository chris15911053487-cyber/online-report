import { beforeEach, describe, expect, it } from 'vitest'
import { clearPendingPin, pinnableSqls, readPendingPin, savePendingPin } from './biPin'

describe('pinnableSqls', () => {
  it('只取成功的 run_sql，去重保持顺序', () => {
    expect(
      pinnableSqls([
        { tool: 'run_sql', args: { sql: ' SELECT 1 ' }, status: 'ok' },
        { tool: 'run_named_query', args: { queryKey: 'x' } },
        { tool: 'run_sql', args: { sql: 'SELECT 2' }, status: 'error' },
        { tool: 'run_sql', args: { sql: 'SELECT 1' } },
        { tool: 'run_sql', args: { sql: 'SELECT 3' } },
        { tool: 'run_sql', args: {} },
      ]),
    ).toEqual(['SELECT 1', 'SELECT 3'])
    expect(pinnableSqls(undefined)).toEqual([])
  })
})

describe('待收藏项', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage
  })

  it('存取、过期、清除', () => {
    savePendingPin('SELECT 1', '谁最多', 1000)
    expect(readPendingPin(2000)).toEqual({ sql: 'SELECT 1', question: '谁最多', at: 1000 })
    expect(readPendingPin(1000 + 11 * 60 * 1000)).toBeNull()
    clearPendingPin()
    expect(readPendingPin(2000)).toBeNull()
  })

  it('内容损坏返回 null', () => {
    store.set('bi_pending_pin', '{bad')
    expect(readPendingPin()).toBeNull()
  })
})
