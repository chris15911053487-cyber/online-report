import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../utils/api'
import { useStore } from '../store'
import type { AppRole } from '../types'

function errMsg(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

/** 角色定义的模块级缓存：管理页之间共用，角色有改动时由 fetchAppRoles 刷新 */
let cached: Promise<AppRole[]> | null = null

export async function fetchAppRoles(): Promise<AppRole[]> {
  const p = apiFetch('/admin/roles').then((data) => (data.items || []) as AppRole[])
  cached = p
  p.catch(() => {
    if (cached === p) cached = null
  })
  return p
}

/** 逗号分隔的角色编码（推送目标等旧格式字段）→ 数组 */
export function splitRoles(text: string | null | undefined): string[] {
  return String(text || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
}

/** 多选的候选角色：已定义的角色 + 字段里已有但未定义的编码（不丢旧值） */
export function rolePickKeys(appRoles: AppRole[], selectedText: string | null | undefined): string[] {
  const keys = appRoles.map((r) => r.roleKey)
  for (const k of splitRoles(selectedText)) if (!keys.includes(k)) keys.push(k)
  return keys
}

/**
 * 角色编码 → 中文名（仅管理员可用，依赖 /admin/roles）。
 * 列表 / 多选里一律显示中文名；未定义的编码原样显示。
 */
export function useRoleLabels() {
  const [appRoles, setAppRoles] = useState<AppRole[]>([])
  useEffect(() => {
    let alive = true
    ;(cached ?? fetchAppRoles())
      .then((items) => alive && setAppRoles(items))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return useMemo(() => {
    const map = new Map(appRoles.map((r) => [r.roleKey, r.label]))
    const roleLabel = (key: string) => map.get(key) || key
    /** 编码列表 → 「中文名、中文名」；空列表返回 empty */
    const formatRoles = (keys: string[], empty = '') => (keys.length ? keys.map(roleLabel).join('、') : empty)
    /** ChipSelect 选项：显示中文名 */
    const roleOptions = (keys: string[]) => keys.map((k) => ({ value: k, label: roleLabel(k) }))
    return { appRoles, roleLabel, formatRoles, roleOptions }
  }, [appRoles])
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
