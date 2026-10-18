/**
 * 「选项来自查询」：POST /bi/options（权限同 /bi/query），同一来源在本页只取一次。
 * 参数的 optionsQuery 与看板下拉筛选的 optionsQuery 共用。
 */
import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import type { BiFilter, BiOption, BiOptionsQuery } from './bi'

export interface LoadedOptions {
  options: BiOption[]
  truncated: boolean
}

const cache = new Map<string, Promise<LoadedOptions>>()
const keyOf = (q: BiOptionsQuery) => `${q.queryKey}|${q.valueColumn}|${q.labelColumn || ''}`

export function fetchQueryOptions(q: BiOptionsQuery): Promise<LoadedOptions> {
  const key = keyOf(q)
  let p = cache.get(key)
  if (!p) {
    p = apiFetch('/bi/options', { method: 'POST', body: JSON.stringify(q) }) as Promise<LoadedOptions>
    // 失败不缓存，下次再试
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

/** 固定选项直接返回；来自查询的异步取（取不到时 error 有值，调用方退回文本输入） */
export function useBiOptions(fixed?: BiOption[], query?: BiOptionsQuery): { options?: BiOption[]; loading: boolean; error: string; truncated: boolean } {
  const key = query?.queryKey && query.valueColumn ? keyOf(query) : ''
  const [state, setState] = useState<{ key: string; data?: LoadedOptions; error?: string }>({ key: '' })
  useEffect(() => {
    if (!key || !query) return
    let alive = true
    fetchQueryOptions(query)
      .then((data) => alive && setState({ key, data }))
      .catch((err: unknown) => alive && setState({ key, error: err instanceof Error ? err.message : '选项加载失败' }))
    return () => {
      alive = false
    }
    // query 由 key 唯一确定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (fixed?.length) return { options: fixed, loading: false, error: '', truncated: false }
  if (!key) return { options: undefined, loading: false, error: '', truncated: false }
  if (state.key !== key) return { options: undefined, loading: true, error: '', truncated: false }
  return { options: state.data?.options, loading: false, error: state.error || '', truncated: !!state.data?.truncated }
}

/** 看板里所有「选项来自查询」的筛选：一次取齐，返回 { 筛选名: 选项 }；取不到的不在结果里 */
export function useFilterOptions(filters: BiFilter[]): { loaded: Record<string, BiOption[]>; errors: Record<string, string> } {
  const sources = filters.filter((f) => f.type === 'select' && !f.options?.length && f.optionsQuery?.queryKey)
  const sig = sources.map((f) => `${f.name}=${keyOf(f.optionsQuery!)}`).join(';')
  const [state, setState] = useState<{ sig: string; loaded: Record<string, BiOption[]>; errors: Record<string, string> }>({ sig: '', loaded: {}, errors: {} })
  useEffect(() => {
    if (!sig) return
    let alive = true
    Promise.allSettled(sources.map((f) => fetchQueryOptions(f.optionsQuery!))).then((rs) => {
      if (!alive) return
      const loaded: Record<string, BiOption[]> = {}
      const errors: Record<string, string> = {}
      rs.forEach((r, i) => {
        if (r.status === 'fulfilled') loaded[sources[i].name] = r.value.options
        else errors[sources[i].name] = r.reason instanceof Error ? r.reason.message : '选项加载失败'
      })
      setState({ sig, loaded, errors })
    })
    return () => {
      alive = false
    }
    // sources 由 sig 唯一确定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return state.sig === sig ? state : { loaded: {}, errors: {} }
}
