import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import type { AppRole } from '../types'
import { Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Badge, Button, Card, ChipSelect, Code, EmptyState, Field, IconButton, Input, Pager, RecordRow, Section, Skeleton } from '../ui'
import { tableClass, tdClass, thClass } from '../ui/classes'
import { confirmAsync, confirmDelete } from '../ui/confirm'

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
  return (
    <ChipSelect
      options={appRoles.map((r) => ({ value: r.roleKey, label: r.label, hint: r.roleKey !== r.label ? r.roleKey : undefined }))}
      selected={selected}
      onChange={onChange}
      empty="暂无角色定义"
    />
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
    if (!(await confirmDelete(`角色「${role.label}」`))) return
    try {
      await apiFetch(`/admin/roles/${encodeURIComponent(role.roleKey)}`, { method: 'DELETE' })
      showToast('已删除')
      await onReload()
      onChanged?.()
    } catch (e: unknown) {
      showToast(errMsg(e, '删除失败'))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        在此定义岗位角色（如 production、warehouse）。菜单「可见角色」和用户分配均引用此列表。
        管理员（admin）由环境变量 ADMIN_USER_CODES 控制，不在此分配。
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] items-start">
        {loading ? (
          <Skeleton className="h-40" />
        ) : (
          <Card className="overflow-hidden">
            {items.length === 0 && <EmptyState title="暂无角色" />}
            {items.map((r) => (
              <RecordRow
                key={r.roleKey}
                title={r.label}
                badges={
                  <>
                    <Code>{r.roleKey}</Code>
                    {r.isBuiltin && <Badge>内置</Badge>}
                  </>
                }
                actions={
                  !r.isBuiltin && (
                    <IconButton label="删除" className="hover:text-danger" onClick={() => void handleDelete(r)}>
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  )
                }
              />
            ))}
          </Card>
        )}

        <Section title="添加角色" className="lg:sticky lg:top-20">
          <div className="flex flex-col gap-3">
            <Field label="标识（英文小写）">
              <Input className="font-mono" value={newKey} placeholder="如 production" onChange={(e) => setNewKey(e.target.value)} />
            </Field>
            <Field label="显示名称">
              <Input value={newLabel} placeholder="如 生产" onChange={(e) => setNewLabel(e.target.value)} />
            </Field>
            <Button icon={<Plus className="w-4 h-4" />} disabled={saving} onClick={() => void handleAdd()}>
              {saving ? '添加中…' : '添加角色'}
            </Button>
          </div>
        </Section>
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
      if (!(await confirmAsync('未选任何角色，保存后该用户登录将默认为「操作员」。继续？'))) return
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

  const selectedRow = rows.find((r) => r.userCode === selectedUser)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        列表来自 OUSR 全部用户。「有效角色」含管理员（ADMIN_USER_CODES）与未分配时的默认操作员。点击某行可编辑其岗位角色分配。
      </p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] items-start">
        <div className="flex flex-col gap-3 min-w-0">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                className="pl-8"
                value={searchInput}
                placeholder="筛选用户代码或姓名，回车确认"
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <Button variant="secondary" onClick={handleSearch}>
              筛选
            </Button>
            {query && (
              <Button variant="ghost" onClick={handleClearSearch}>
                清除
              </Button>
            )}
            <Button variant="ghost" icon={<RefreshCw className="w-4 h-4" />} onClick={() => void loadList({ page, q: query })}>
              {loadingList ? '刷新中…' : '刷新'}
            </Button>
          </div>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto max-h-[calc(100vh-20rem)] min-h-[16rem] overflow-y-auto">
              <table className={tableClass}>
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className={thClass}>用户代码</th>
                    <th className={thClass}>姓名</th>
                    <th className={thClass}>有效角色</th>
                    <th className={thClass}>已分配</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && !loadingList && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-subtle">
                        {query ? '无匹配用户' : '暂无用户'}
                      </td>
                    </tr>
                  )}
                  {rows.map((row) => (
                    <tr
                      key={row.userCode}
                      className={`cursor-pointer transition-colors ${selectedUser === row.userCode ? 'bg-primary-soft' : 'hover:bg-surface-2'}`}
                      onClick={() => handleSelectUser(row.userCode)}
                    >
                      <td className={tdClass + ' font-mono text-xs'}>{row.userCode}</td>
                      <td className={tdClass}>{row.displayName}</td>
                      <td className={tdClass}>
                        {formatRoleLabels(row.roles || [], appRoles)}
                        {row.isDefaultOperator && <span className="ml-1 text-xs text-subtle">(默认)</span>}
                      </td>
                      <td className={tdClass + ' text-muted'}>
                        {(row.assignedRoles || []).length > 0 ? formatRoleLabels(row.assignedRoles, appRoles) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line bg-surface-2">
              <Pager
                page={page}
                totalPages={totalPages}
                disabled={loadingList}
                onChange={(p) => void loadList({ page: p, q: query })}
                summary={`共 ${total} 人${query ? `（筛选：${query}）` : ''}`}
              />
            </div>
          </Card>
        </div>

        <Section
          className="lg:sticky lg:top-20"
          title={selectedUser ? `编辑用户：${selectedRow?.displayName || selectedUser}` : '编辑用户角色'}
          hint={selectedUser ? <span className="font-mono">{selectedUser}</span> : '在左侧列表点选一个用户'}
        >
          {!selectedUser ? (
            <p className="text-[13px] text-subtle">未选择用户</p>
          ) : loadingRoles ? (
            <Skeleton className="h-16" />
          ) : (
            <div className="flex flex-col gap-3">
              <RoleCheckboxGroup appRoles={assignableRoles} selected={selectedRoles} onChange={setSelectedRoles} />
              <Button disabled={saving} onClick={() => void handleSave()}>
                {saving ? '保存中…' : '保存用户角色'}
              </Button>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
