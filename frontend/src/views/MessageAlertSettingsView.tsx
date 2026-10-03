import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import type { AppRole, MessageAlertRule } from '../types'
import { Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { AdminPage, Badge, Button, Card, Checkbox, ChipSelect, EditorActions, EmptyState, Field, IconButton, Input, RecordRow, ResultTable, Section, Select, Skeleton, Textarea } from '../ui'
import { confirmDelete } from '../ui/confirm'

const EMPTY_RULE: MessageAlertRule = {
  id: 0,
  name: '',
  sqlTemplate: '',
  keyColumn: '',
  titleTemplate: '',
  roles: [],
  refreshSeconds: 60,
  enabled: true,
  sortOrder: 100,
}

export default function MessageAlertSettingsView() {
  const { showToast } = useStore()
  const [rules, setRules] = useState<MessageAlertRule[]>([])
  const [roles, setRoles] = useState<AppRole[]>([])
  const [editing, setEditing] = useState<MessageAlertRule | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testColumns, setTestColumns] = useState<string[]>([])
  const [testRows, setTestRows] = useState<Record<string, unknown>[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ruleData, roleData] = await Promise.all([
        apiFetch('/messages/admin/rules'),
        apiFetch('/admin/roles').catch(() => ({ items: [] })),
      ])
      setRules(Array.isArray(ruleData?.items) ? ruleData.items : [])
      setRoles(Array.isArray(roleData?.items) ? roleData.items : [])
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (rule: MessageAlertRule) => {
    setEditing({ ...rule, roles: [...rule.roles] })
    setIsNew(false)
    setTestColumns([])
    setTestRows([])
  }

  const startNew = () => {
    setEditing({ ...EMPTY_RULE })
    setIsNew(true)
    setTestColumns([])
    setTestRows([])
  }

  const runTest = async () => {
    if (!editing?.sqlTemplate.trim()) {
      showToast('请先填写 SQL 语句')
      return
    }
    setTesting(true)
    try {
      const data = await apiFetch('/messages/admin/rules/test', {
        method: 'POST',
        body: JSON.stringify({ sqlTemplate: editing.sqlTemplate }),
      })
      const cols = Array.isArray(data?.columns) ? data.columns : []
      const rows = Array.isArray(data?.rows) ? data.rows : []
      setTestColumns(cols)
      setTestRows(rows)
      if (!editing.keyColumn && cols.length > 0) {
        setEditing({ ...editing, keyColumn: cols[0] })
      }
      showToast(`试运行成功，返回 ${rows.length} 行`)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '试运行失败')
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      showToast('请填写规则名称')
      return
    }
    if (!editing.sqlTemplate.trim()) {
      showToast('请填写 SQL 语句')
      return
    }
    if (!editing.keyColumn.trim()) {
      showToast('请填写唯一键列')
      return
    }
    if (!editing.titleTemplate.trim()) {
      showToast('请填写行标题模板')
      return
    }
    if (editing.roles.length === 0) {
      showToast('请至少选择一个可见角色')
      return
    }

    setSaving(true)
    try {
      const payload = {
        name: editing.name.trim(),
        sqlTemplate: editing.sqlTemplate.trim(),
        keyColumn: editing.keyColumn.trim(),
        titleTemplate: editing.titleTemplate.trim(),
        roles: editing.roles,
        refreshSeconds: editing.refreshSeconds,
        enabled: editing.enabled,
        sortOrder: editing.sortOrder,
      }
      if (isNew) {
        await apiFetch('/messages/admin/rules', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        showToast('已创建提醒规则')
      } else {
        await apiFetch(`/messages/admin/rules/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })
        showToast('已保存提醒规则')
      }
      setEditing(null)
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number) => {
    if (!(await confirmDelete('该提醒规则'))) return
    try {
      await apiFetch(`/messages/admin/rules/${id}`, { method: 'DELETE' })
      showToast('已删除')
      if (editing?.id === id) setEditing(null)
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (editing) {
    return (
      <AdminPage title={isNew ? '新建提醒规则' : `编辑：${editing.name}`} onBack={() => setEditing(null)} withActionBar>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
          <Section
            title="查询"
            hint="SQL 返回的每一行就是一条提醒；试运行后可直接从结果列里选唯一键列。"
            actions={
              <Button size="sm" variant="soft" icon={<Play className="w-3.5 h-3.5" />} onClick={() => void runTest()} disabled={testing}>
                {testing ? '试运行中…' : '试运行 SQL'}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              <Textarea
                mono
                rows={12}
                value={editing.sqlTemplate}
                onChange={(e) => setEditing({ ...editing, sqlTemplate: e.target.value })}
                placeholder="SELECT DocNum AS 订单号, CardName AS 客户 FROM ..."
                spellCheck={false}
              />
              {testRows.length > 0 && (
                <div>
                  <p className="text-xs text-muted mb-1">试运行结果（前 {Math.min(testRows.length, 20)} 行，共 {testRows.length} 行）</p>
                  <ResultTable columns={testColumns} rows={testRows.slice(0, 20)} />
                </div>
              )}
            </div>
          </Section>

          <Section title="规则">
            <div className="flex flex-col gap-3">
              <Field label="规则名称">
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：超期订单提醒" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="唯一键列">
                  {testColumns.length > 0 ? (
                    <Select value={editing.keyColumn} onChange={(e) => setEditing({ ...editing, keyColumn: e.target.value })}>
                      <option value="">请选择</option>
                      {testColumns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={editing.keyColumn} onChange={(e) => setEditing({ ...editing, keyColumn: e.target.value })} placeholder="结果集中的列名" />
                  )}
                </Field>
                <Field label="刷新间隔（秒）">
                  <Input
                    type="number"
                    min={15}
                    value={editing.refreshSeconds}
                    onChange={(e) => setEditing({ ...editing, refreshSeconds: Number(e.target.value) || 60 })}
                  />
                </Field>
              </div>
              <Field label="行标题模板" hint={<>使用 {'{列名}'} 引用 SQL 结果列</>}>
                <Input
                  value={editing.titleTemplate}
                  onChange={(e) => setEditing({ ...editing, titleTemplate: e.target.value })}
                  placeholder="订单 {订单号} 已超期（{客户}）"
                />
              </Field>
              <Field label="可见角色">
                <ChipSelect
                  options={roles.map((r) => ({ value: r.roleKey, label: r.label }))}
                  selected={editing.roles}
                  onChange={(next) => setEditing({ ...editing, roles: next })}
                  empty="暂无角色定义"
                />
              </Field>
              <div className="flex items-center gap-4">
                <Checkbox label="启用" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                <label className="flex items-center gap-2 text-sm text-fg-2">
                  排序
                  <Input
                    type="number"
                    className="w-24"
                    value={editing.sortOrder}
                    onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) || 0 })}
                  />
                </label>
              </div>
            </div>
          </Section>
        </div>

        <EditorActions onCancel={() => setEditing(null)} onSave={() => void save()} saving={saving} />
      </AdminPage>
    )
  }

  return (
    <AdminPage
      title="消息提醒规则"
      description="按 SQL 结果生成「消息」页的提醒，并按设定频率刷新"
      actions={
        <Button icon={<Plus className="w-4 h-4" />} onClick={startNew}>
          新建规则
        </Button>
      }
    >
      {loading ? (
        <Skeleton className="h-32" />
      ) : (
        <Card className="overflow-hidden">
          {rules.length === 0 && <EmptyState title="暂无提醒规则" />}
          {rules.map((rule) => (
            <RecordRow
              key={rule.id}
              onClick={() => startEdit(rule)}
              title={rule.name}
              badges={!rule.enabled && <Badge>已停用</Badge>}
              meta={
                <span>
                  角色：{rule.roles.join('、') || '-'} · 刷新 {rule.refreshSeconds}s
                </span>
              }
              actions={
                <>
                  <IconButton label="编辑" onClick={() => startEdit(rule)}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(rule.id)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </>
              }
            />
          ))}
        </Card>
      )}
    </AdminPage>
  )
}
