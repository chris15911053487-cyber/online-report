import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import type { AppRole } from '../types'

function errMsg(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

export function RoleCheckboxGroup({
  appRoles,
  selected,
  onChange,
}: {
  appRoles: AppRole[]
  selected: string[]
  onChange: (roles: string[]) => void
}) {
  if (appRoles.length === 0) {
    return <p className="text-sm text-slate-400">暂无角色定义</p>
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {appRoles.map((r) => (
        <label key={r.roleKey} className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            className="rounded"
            checked={selected.includes(r.roleKey)}
            onChange={(e) => {
              if (e.target.checked) {
                onChange([...selected, r.roleKey])
              } else {
                onChange(selected.filter((x) => x !== r.roleKey))
              }
            }}
          />
          {r.label}
          <span className="text-xs text-slate-400">({r.roleKey})</span>
        </label>
      ))}
    </div>
  )
}

export function RolesDefinitionPanel({
  items,
  loading,
  onChanged,
  onReload,
}: {
  items: AppRole[]
  loading?: boolean
  onChanged?: () => void
  onReload: () => Promise<void>
}) {
  const showToast = useStore((s) => s.showToast)
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [saving, setSaving] = useState(false)

  const handleAdd = async () => {
    const roleKey = newKey.trim().toLowerCase()
    const label = newLabel.trim()
    if (!roleKey || !label) {
      showToast('请填写角色标识和名称')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/admin/roles', {
        method: 'POST',
        body: JSON.stringify({ roleKey, label }),
      })
      showToast('角色已添加')
      setNewKey('')
      setNewLabel('')
      await onReload()
      onChanged?.()
    } catch (e: unknown) {
      showToast(errMsg(e, '添加失败'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (role: AppRole) => {
    if (role.isBuiltin) return
    if (!confirm(`确定删除角色「${role.label}」？`)) return
    try {
      await apiFetch(`/admin/roles/${encodeURIComponent(role.roleKey)}`, { method: 'DELETE' })
      showToast('已删除')
      await onReload()
      onChanged?.()
    } catch (e: unknown) {
      showToast(errMsg(e, '删除失败'))
    }
  }

  const inputCls =
    'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none'

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        在此定义岗位角色（如 production、warehouse）。菜单「可见角色」和用户分配均引用此列表。
        管理员（admin）由环境变量 ADMIN_USER_CODES 控制，不在此分配。
      </p>

      {loading && <p className="text-slate-400 text-center py-6">加载中…</p>}

      {!loading && (
        <div className="space-y-2">
          {items.map((r) => (
            <div
              key={r.roleKey}
              className="flex items-center justify-between bg-white rounded-lg border border-slate-200 px-4 py-3"
            >
              <div>
                <span className="font-medium text-slate-800">{r.label}</span>
                <span className="ml-2 text-sm text-slate-400">{r.roleKey}</span>
                {r.isBuiltin && (
                  <span className="ml-2 text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded">内置</span>
                )}
              </div>
              {!r.isBuiltin && (
                <button
                  type="button"
                  className="text-sm text-red-500 hover:text-red-600"
                  onClick={() => handleDelete(r)}
                >
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-dashed border-sky-300 p-4 space-y-3">
        <h3 className="font-semibold text-sky-700">添加角色</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm font-medium text-slate-600 mb-1">标识（英文小写）</span>
            <input
              className={inputCls}
              value={newKey}
              placeholder="如 production"
              onChange={(e) => setNewKey(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-slate-600 mb-1">显示名称</span>
            <input
              className={inputCls}
              value={newLabel}
              placeholder="如 生产"
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          disabled={saving}
          className="px-4 py-2 bg-sky-500 text-white rounded-lg text-sm hover:bg-sky-600 disabled:opacity-50"
          onClick={handleAdd}
        >
          {saving ? '添加中…' : '添加角色'}
        </button>
      </div>
    </div>
  )
}

interface UserRoleRow {
  userCode: string
  displayName: string
  assignedRoles: string[]
  roles: string[]
  isDefaultOperator?: boolean
}

function formatRoleLabels(roleKeys: string[], appRoles: AppRole[]) {
  const labelMap = new Map(appRoles.map((r) => [r.roleKey, r.label]))
  return roleKeys.map((k) => labelMap.get(k) || k).join('、')
}

export function UserRolesPanel({ appRoles }: { appRoles: AppRole[] }) {
  const showToast = useStore((s) => s.showToast)
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [rows, setRows] = useState<UserRoleRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 50
  const [loadingList, setLoadingList] = useState(false)
  const [selectedUser, setSelectedUser] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [loadingRoles, setLoadingRoles] = useState(false)
  const [saving, setSaving] = useState(false)

  const assignableRoles = appRoles.filter((r) => r.roleKey !== 'admin')
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const loadList = useCallback(
    async (opts: { page: number; q: string }) => {
      const { page: p, q } = opts
      setLoadingList(true)
      try {
        const params = new URLSearchParams({
          page: String(p),
          pageSize: String(pageSize),
        })
        if (q.trim()) params.set('q', q.trim())
        const data = await apiFetch(`/admin/user-roles?${params.toString()}`)
        setRows(data.items || [])
        setTotal(Number(data.total) || 0)
        setPage(Number(data.page) || p)
        setQuery(q)
      } catch (e: unknown) {
        showToast(errMsg(e, '加载用户列表失败'))
      } finally {
        setLoadingList(false)
      }
    },
    [showToast],
  )

  const loadUserRoles = useCallback(
    async (userCode: string) => {
      if (!userCode) return
      setLoadingRoles(true)
      try {
        const data = await apiFetch(`/admin/user-roles/${encodeURIComponent(userCode)}`)
        const assigned = Array.isArray(data.assignedRoles) ? data.assignedRoles : []
        setSelectedRoles(assigned.filter((r: string) => r !== 'admin'))
      } catch (e: unknown) {
        showToast(errMsg(e, '加载用户角色失败'))
      } finally {
        setLoadingRoles(false)
      }
    },
    [showToast],
  )

  useEffect(() => {
    void loadList({ page: 1, q: '' })
  }, [loadList])

  const handleSearch = () => {
    const q = searchInput.trim()
    void loadList({ page: 1, q })
  }

  const handleClearSearch = () => {
    setSearchInput('')
    void loadList({ page: 1, q: '' })
  }

  const handleSelectUser = (userCode: string) => {
    setSelectedUser(userCode)
    void loadUserRoles(userCode)
  }

  const handleSave = async () => {
    if (!selectedUser) {
      showToast('请先选择用户')
      return
    }
    if (selectedRoles.length === 0) {
      if (!confirm('未选任何角色，保存后该用户登录将默认为「操作员」。继续？')) return
    }
    setSaving(true)
    try {
      await apiFetch(`/admin/user-roles/${encodeURIComponent(selectedUser)}`, {
        method: 'PUT',
        body: JSON.stringify({ roles: selectedRoles }),
      })
      showToast('用户角色已保存')
      await loadList({ page, q: query })
      void loadUserRoles(selectedUser)
    } catch (e: unknown) {
      showToast(errMsg(e, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none'

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        列表来自 OUSR 全部用户。「有效角色」含管理员（ADMIN_USER_CODES）与未分配时的默认操作员。
        点击某行可编辑其岗位角色分配。
      </p>

      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputCls} flex-1 min-w-[12rem]`}
          value={searchInput}
          placeholder="筛选用户代码或姓名"
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button
          type="button"
          className="shrink-0 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm hover:bg-slate-200"
          onClick={handleSearch}
        >
          筛选
        </button>
        {query && (
          <button
            type="button"
            className="shrink-0 px-4 py-2 text-slate-500 rounded-lg text-sm hover:bg-slate-100"
            onClick={handleClearSearch}
          >
            清除
          </button>
        )}
        <button
          type="button"
          className="shrink-0 px-4 py-2 bg-sky-50 text-sky-700 rounded-lg text-sm hover:bg-sky-100"
          onClick={() => void loadList({ page, q: query })}
        >
          {loadingList ? '刷新中…' : '刷新列表'}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr className="text-left text-slate-600">
                <th className="px-3 py-2 font-medium">用户代码</th>
                <th className="px-3 py-2 font-medium">姓名</th>
                <th className="px-3 py-2 font-medium">有效角色</th>
                <th className="px-3 py-2 font-medium">已分配</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loadingList && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                    {query ? '无匹配用户' : '暂无用户'}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={row.userCode}
                  className={`border-t border-slate-100 cursor-pointer hover:bg-sky-50/80 ${
                    selectedUser === row.userCode ? 'bg-sky-50' : ''
                  }`}
                  onClick={() => handleSelectUser(row.userCode)}
                >
                  <td className="px-3 py-2 font-mono text-xs">{row.userCode}</td>
                  <td className="px-3 py-2">{row.displayName}</td>
                  <td className="px-3 py-2">
                    {formatRoleLabels(row.roles || [], appRoles)}
                    {row.isDefaultOperator && (
                      <span className="ml-1 text-xs text-slate-400">(默认)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {(row.assignedRoles || []).length > 0
                      ? formatRoleLabels(row.assignedRoles, appRoles)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100 bg-slate-50 text-xs text-slate-600">
          <span>
            共 {total} 人
            {query ? `（筛选：${query}）` : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loadingList}
              className="px-2 py-1 rounded hover:bg-white disabled:opacity-40"
              onClick={() => void loadList({ page: page - 1, q: query })}
            >
              上一页
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages || loadingList}
              className="px-2 py-1 rounded hover:bg-white disabled:opacity-40"
              onClick={() => void loadList({ page: page + 1, q: query })}
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      {selectedUser && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
          <h3 className="font-semibold text-slate-700">编辑用户：{selectedUser}</h3>
          {loadingRoles ? (
            <p className="text-sm text-slate-400">加载角色中…</p>
          ) : (
            <RoleCheckboxGroup
              appRoles={assignableRoles}
              selected={selectedRoles}
              onChange={setSelectedRoles}
            />
          )}
          <button
            type="button"
            disabled={saving}
            className="px-4 py-2 bg-sky-500 text-white rounded-lg text-sm hover:bg-sky-600 disabled:opacity-50"
            onClick={handleSave}
          >
            {saving ? '保存中…' : '保存用户角色'}
          </button>
        </div>
      )}
    </div>
  )
}
