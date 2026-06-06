import { useCallback, useState } from 'react'
import { apiFetch } from '../utils/api'
import { useStore } from '../store'
import type { AppRole } from '../types'

function errMsg(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

export async function fetchAppRoles(): Promise<AppRole[]> {
  const data = await apiFetch('/admin/roles')
  return data.items || []
}

export function useAppRoles() {
  const showToast = useStore((s) => s.showToast)
  const [appRoles, setAppRoles] = useState<AppRole[]>([])
  const [loading, setLoading] = useState(false)

  const reloadAppRoles = useCallback(async () => {
    setLoading(true)
    try {
      setAppRoles(await fetchAppRoles())
    } catch (e: unknown) {
      showToast(errMsg(e, '加载角色失败'))
    } finally {
      setLoading(false)
    }
  }, [showToast])

  return { appRoles, loading, reloadAppRoles, setAppRoles }
}
