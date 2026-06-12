import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import type { AppRole, MessageAlertRule } from '../types'

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

  const toggleRole = (key: string) => {
    if (!editing) return
    const has = editing.roles.includes(key)
    setEditing({
      ...editing,
      roles: has ? editing.roles.filter((r) => r !== key) : [...editing.roles, key],
    })
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
    if (!window.confirm('确定删除该提醒规则？')) return
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
      <div className="p-4 max-w-2xl mx-auto space-y-4">
        <h2 className="text-lg font-semibold">{isNew ? '新建提醒规则' : '编辑提醒规则'}</h2>

        <div className="bg-white rounded-lg shadow p-4 space-y-3">
          <div>
            <label className="block text-sm text-slate-600 mb-1">规则名称</label>
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="如：超期订单提醒"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-600 mb-1">SQL 查询语句</label>
            <textarea
              value={editing.sqlTemplate}
              onChange={(e) => setEditing({ ...editing, sqlTemplate: e.target.value })}
              rows={6}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
              placeholder="SELECT DocNum AS 订单号, CardName AS 客户 FROM ..."
            />
            <button
              onClick={() => void runTest()}
              disabled={testing}
              className="mt-2 text-sm text-sky-600 hover:underline disabled:opacity-50"
            >
              {testing ? '试运行中...' : '试运行 SQL'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">唯一键列</label>
              {testColumns.length > 0 ? (
                <select
                  value={editing.keyColumn}
                  onChange={(e) => setEditing({ ...editing, keyColumn: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                >
                  <option value="">请选择</option>
                  {testColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={editing.keyColumn}
                  onChange={(e) => setEditing({ ...editing, keyColumn: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                  placeholder="结果集中的列名"
                />
              )}
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">刷新间隔（秒）</label>
              <input
                type="number"
                min={15}
                value={editing.refreshSeconds}
                onChange={(e) =>
                  setEditing({ ...editing, refreshSeconds: Number(e.target.value) || 60 })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-600 mb-1">行标题模板</label>
            <input
              value={editing.titleTemplate}
              onChange={(e) => setEditing({ ...editing, titleTemplate: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="订单 {订单号} 已超期（{客户}）"
            />
            <p className="text-xs text-slate-400 mt-1">使用 {'{列名}'} 引用 SQL 结果列</p>
          </div>

          <div>
            <label className="block text-sm text-slate-600 mb-1">可见角色</label>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <button
                  key={r.roleKey}
                  type="button"
                  onClick={() => toggleRole(r.roleKey)}
                  className={`px-3 py-1 rounded-full text-xs border ${
                    editing.roles.includes(r.roleKey)
                      ? 'bg-sky-500 text-white border-sky-500'
                      : 'bg-white text-slate-600 border-slate-300'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              启用
            </label>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">排序</span>
              <input
                type="number"
                value={editing.sortOrder}
                onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) || 0 })}
                className="w-20 px-2 py-1 border border-slate-300 rounded text-sm"
              />
            </div>
          </div>

          {testRows.length > 0 && (
            <div className="border border-slate-200 rounded-lg p-3 overflow-x-auto">
              <p className="text-xs text-slate-500 mb-2">试运行结果（前 {testRows.length} 行）</p>
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-slate-500">
                    {testColumns.map((c) => (
                      <th key={c} className="pr-3 pb-1">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {testRows.slice(0, 5).map((row, i) => (
                    <tr key={i}>
                      {testColumns.map((c) => (
                        <td key={c} className="pr-3 py-0.5">
                          {row[c] == null ? '-' : String(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => setEditing(null)}
            className="flex-1 py-2 border border-slate-300 rounded-lg text-sm"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">消息提醒规则</h2>
        <button
          onClick={startNew}
          className="px-3 py-1.5 bg-sky-500 text-white rounded-lg text-sm"
        >
          新建规则
        </button>
      </div>

      {loading ? (
        <div className="text-center text-slate-400 py-8">加载中...</div>
      ) : rules.length === 0 ? (
        <div className="text-center text-slate-400 py-8">暂无提醒规则</div>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="bg-white rounded-lg shadow p-4 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="font-medium text-slate-800 flex items-center gap-2">
                  {rule.name}
                  {!rule.enabled && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                      已禁用
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  角色：{rule.roles.join('、') || '-'} · 刷新 {rule.refreshSeconds}s
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => startEdit(rule)}
                  className="text-sm text-sky-600 hover:underline"
                >
                  编辑
                </button>
                <button
                  onClick={() => void remove(rule.id)}
                  className="text-sm text-rose-500 hover:underline"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
