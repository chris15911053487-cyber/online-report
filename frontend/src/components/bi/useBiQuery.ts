/**
 * 看板取数（POST /bi/query，走服务端缓存）：卡片与下钻明细面板共用。
 * 查询或参数变化即重取；refresh() 跳过缓存。只在 Promise 回调里 setState。
 */
import { useEffect, useState } from 'react'
import { apiFetch } from '../../utils/api'
import type { BiQueryResult, BiValue } from '../../utils/bi'

type LoadState = { key: string; data?: BiQueryResult; error?: string }

function fetchQuery(queryKey: string, params: unknown, refresh: boolean): Promise<BiQueryResult> {
  return apiFetch('/bi/query', { method: 'POST', body: JSON.stringify({ queryKey, params, refresh }) }) as Promise<BiQueryResult>
}

export function useBiQuery(queryKey: string, params: Record<string, BiValue>) {
  const reqKey = JSON.stringify([queryKey, params])
  const [state, setState] = useState<LoadState | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let alive = true
    const [k, p] = JSON.parse(reqKey) as [string, unknown]
    fetchQuery(k, p, false)
      .then((data) => alive && setState({ key: reqKey, data }))
      .catch((err: unknown) => alive && setState({ key: reqKey, error: err instanceof Error ? err.message : '加载失败' }))
    return () => {
      alive = false
    }
  }, [reqKey])

  const refresh = () => {
    setRefreshing(true)
    const [k, p] = JSON.parse(reqKey) as [string, unknown]
    fetchQuery(k, p, true)
      .then((data) => setState({ key: reqKey, data }))
      .catch((err: unknown) => setState({ key: reqKey, error: err instanceof Error ? err.message : '加载失败' }))
      .finally(() => setRefreshing(false))
  }

  const loading = !state || state.key !== reqKey
  return {
    /** 查询 + 参数的稳定表示（依赖它而不是每次渲染新建的 params 对象） */
    reqKey,
    loading,
    /** 上一次的结果（切换参数时先保留旧数据，变淡显示） */
    data: state?.data,
    error: !loading ? state?.error : undefined,
    refreshing,
    refresh,
  }
}
