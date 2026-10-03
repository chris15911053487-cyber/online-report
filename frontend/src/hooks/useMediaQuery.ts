import { useSyncExternalStore } from 'react'

/** 响应式媒体查询（窗口尺寸变化时自动更新） */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** PC 布局断点：与 Tailwind 的 lg（1024px）一致 */
export const PC_QUERY = '(min-width: 1024px)'
export const useIsPc = () => useMediaQuery(PC_QUERY)
