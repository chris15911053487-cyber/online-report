import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport } from '../utils/api'
import type { AppRole } from '../types'

type SqlType = 'nvarchar' | 'int' | 'decimal' | 'datetime' | 'bit'

interface FieldDef {
  name: string
  label: string
  sqlType: SqlType
  required: boolean
  maxLen: number
}

type TargetKind = 'table' | 'action'

interface WriteTarget {
  name: string
  label: string
  targetKind?: TargetKind
  targetTable: string
  fields: FieldDef[]
  roles: string[]
  enabled: boolean
}

interface AgentAction {
  name: string
  label: string
  payloadHint: string
}

const EMPTY_TARGET: WriteTarget = {
  name: '',
  label: '',
  targetKind: 'table',
  targetTable: '',
  fields: [],
  roles: ['admin'],
  enabled: true,
}

const SQL_TYPES: SqlType[] = ['nvarchar', 'int', 'decimal', 'datetime', 'bit']

export default function AiWriteTargetsPanel({ roles }: { roles: AppRole[] }) {
  const { showToast } = useStore()
  const [targets, setTargets] = useState<WriteTarget[]>([])
  const [actions, setActions] = useState<AgentAction[]>([])
  const [editing, setEditing] = useState<WriteTarget | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showAIDialog, setShowAIDialog] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [data, actionData] = await Promise.all([
        apiFetch('/ai/agent/write-targets-admin'),
        apiFetch('/ai/agent/actions-admin').catch(() => ({ items: [] })),
      ])
      setTargets(Array.isArray(data?.items) ? data.items : [])
      setActions(Array.isArray(actionData?.items) ? actionData.items : [])
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const startNew = () => {
    setEditing({ ...EMPTY_TARGET, fields: [] })
    setIsNew(true)
  }
  const startEdit = (t: WriteTarget) => {
    setEditing({ ...t, fields: t.fields.map((f) => ({ ...f })), roles: [...t.roles] })
    setIsNew(false)
  }

  const handleAIGenerate = async (requirement: string) => {
    setShowAIDialog(false)
    setAiGenerating(true)
    showToast('AI 正在生成写入目标配置…', 95000)
    try {
      const data = await apiFetchReport(
        '/ai/generate-write-target',
        { method: 'POST', body: JSON.stringify({ requirement }) },
        120000,
      ) as { success?: boolean; target?: { name: string; label: string; targetTable: string; fields: FieldDef[] }; error?: string }
      if (data.success && data.target) {
        setEditing({
          ...EMPTY_TARGET,
          name: data.target.name,
          label: data.target.label,
          targetTable: data.target.targetTable,
          fields: data.target.fields,
        })
        setIsNew(true)
        showToast('AI 生成成功！请检查内容后保存。')
      } else {
        showToast('生成失败：' + (data.error || '未知错误'))
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '网络错误'
      showToast('AI 生成失败：' + (/abort|超时|timeout/i.test(msg) ? '请求超时，请重试' : msg))
    } finally {
      setAiGenerating(false)
    }
  }

  const addField = () => {
    if (!editing) return
    setEditing({
      ...editing,
      fields: [...editing.fields, { name: '', label: '', sqlType: 'nvarchar', required: false, maxLen: 255 }],
    })
  }
  const updateField = (idx: number, patch: Partial<FieldDef>) => {
    if (!editing) return
    setEditing({ ...editing, fields: editing.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) })
  }
  const removeField = (idx: number) => {
    if (!editing) return
    setEditing({ ...editing, fields: editing.fields.filter((_, i) => i !== idx) })
  }
  const toggleRole = (key: string) => {
    if (!editing) return
    const has = editing.roles.includes(key)
    setEditing({ ...editing, roles: has ? editing.roles.filter((r) => r !== key) : [...editing.roles, key] })
  }

  const save = async () => {
    if (!editing) return
    const kind: TargetKind = editing.targetKind === 'action' ? 'action' : 'table'
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(editing.name)) return showToast('实体名须为小写字母开头的标识')
    if (!editing.label.trim()) return showToast('请填写显示名')
    if (kind === 'action') {
      if (!editing.targetTable) return showToast('请选择 API 动作')
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(editing.targetTable)) return showToast('目标表名不合法')
      if (editing.fields.length === 0) return showToast('至少配置一个字段')
    }
    setSaving(true)
    try {
      await apiFetch('/ai/agent/write-targets-admin', { method: 'POST', body: JSON.stringify(editing) })
      showToast('已保存')
      setEditing(null)
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (name: string) => {
    if (!confirm(`确认删除写入目标「${name}」？`)) return
    try {
      await apiFetch(`/ai/agent/write-targets-admin/${name}`, { method: 'DELETE' })
      showToast('已删除')
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (editing) {
    return (
      <div className="pb-24">
        <h3 className="text-base font-semibold mb-3">{isNew ? '新建写入目标' : `编辑：${editing.name}`}</h3>
        <div className="space-y-3 bg-white rounded-lg shadow p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">实体名（小写连字符）</label>
              <input
                value={editing.name}
                disabled={!isNew}
                onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })}
                placeholder="order-note"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">显示名</label>
              <input
                value={editing.label}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">类型</label>
            <div className="flex gap-2">
              {([
                { kind: 'table' as TargetKind, label: '表写入（白名单 INSERT）' },
                { kind: 'action' as TargetKind, label: 'API 动作（调业务接口）' },
              ]).map((opt) => (
                <button
                  key={opt.kind}
                  type="button"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      targetKind: opt.kind,
                      targetTable: '',
                      fields: opt.kind === 'action' ? [] : editing.fields,
                    })
                  }
                  className={`text-xs px-3 py-1.5 rounded-full border ${
                    (editing.targetKind === 'action' ? 'action' : 'table') === opt.kind
                      ? 'border-sky-500 bg-sky-50 text-sky-700'
                      : 'border-slate-200 text-slate-500'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {editing.targetKind === 'action' ? (
            <div>
              <label className="block text-xs text-slate-500 mb-1">API 动作（仅可选代码注册的动作）</label>
              <select
                value={editing.targetTable}
                onChange={(e) => setEditing({ ...editing, targetTable: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                <option value="">请选择动作…</option>
                {actions.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.label}（{a.name}）
                  </option>
                ))}
              </select>
              {(() => {
                const act = actions.find((a) => a.name === editing.targetTable)
                return act?.payloadHint ? (
                  <p className="text-[11px] text-slate-400 mt-1 font-mono break-all">
                    payload 格式：{act.payloadHint}
                  </p>
                ) : null
              })()}
            </div>
          ) : (
          <div>
            <label className="block text-xs text-slate-500 mb-1">目标表名（仅字母/数字/下划线）</label>
            <input
              value={editing.targetTable}
              onChange={(e) => setEditing({ ...editing, targetTable: e.target.value })}
              placeholder="X_ORDER_NOTE"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
            />
          </div>
          )}

          {editing.targetKind !== 'action' && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-slate-500">字段白名单</label>
              <button onClick={addField} className="text-xs text-sky-600">+ 添加字段</button>
            </div>
            <div className="space-y-2">
              {editing.fields.map((f, idx) => (
                <div key={idx} className="flex flex-wrap gap-2 items-center bg-slate-50 p-2 rounded-lg">
                  <input
                    value={f.name}
                    onChange={(e) => updateField(idx, { name: e.target.value })}
                    placeholder="列名"
                    className="w-28 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                  />
                  <input
                    value={f.label}
                    onChange={(e) => updateField(idx, { label: e.target.value })}
                    placeholder="标签"
                    className="w-24 px-2 py-1 border border-slate-300 rounded text-xs"
                  />
                  <select
                    value={f.sqlType}
                    onChange={(e) => updateField(idx, { sqlType: e.target.value as SqlType })}
                    className="px-2 py-1 border border-slate-300 rounded text-xs"
                  >
                    {SQL_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {f.sqlType === 'nvarchar' && (
                    <input
                      type="number"
                      value={f.maxLen}
                      onChange={(e) => updateField(idx, { maxLen: Number(e.target.value) || 255 })}
                      className="w-16 px-2 py-1 border border-slate-300 rounded text-xs"
                      title="最大长度"
                    />
                  )}
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => updateField(idx, { required: e.target.checked })}
                    />
                    必填
                  </label>
                  <button onClick={() => removeField(idx)} className="text-xs text-red-500 ml-auto">删除</button>
                </div>
              ))}
              {editing.fields.length === 0 && <p className="text-xs text-slate-400">尚未添加字段</p>}
            </div>
          </div>
          )}

          <div>
            <label className="block text-xs text-slate-500 mb-1">允许写入的角色</label>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <button
                  key={r.roleKey}
                  type="button"
                  onClick={() => toggleRole(r.roleKey)}
                  className={`text-xs px-3 py-1.5 rounded-full border ${
                    editing.roles.includes(r.roleKey)
                      ? 'border-sky-500 bg-sky-50 text-sky-700'
                      : 'border-slate-200 text-slate-500'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            启用
          </label>
        </div>

        <div className="flex gap-3 mt-4">
          <button onClick={() => setEditing(null)} className="flex-1 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm">
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-500">
          定义 AI 可写入的实体与字段白名单。写入经人工确认 + 参数化 + 审计。
        </p>
        <div className="flex gap-2 shrink-0 ml-2">
          <button
            onClick={() => setShowAIDialog(true)}
            disabled={aiGenerating}
            className="text-sm px-3 py-1.5 bg-purple-500 text-white rounded-lg disabled:opacity-50"
          >
            {aiGenerating ? '生成中…' : 'AI 辅助生成'}
          </button>
          <button onClick={startNew} className="text-sm px-3 py-1.5 bg-sky-500 text-white rounded-lg">
            + 新建
          </button>
        </div>
      </div>

      {showAIDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAIDialog(false) }}
        >
          <div className="bg-white rounded-xl shadow-xl w-[90%] max-w-lg p-5">
            <p className="font-semibold text-slate-800 mb-3">描述你想要的写入目标：</p>
            <div className="text-xs text-slate-500 mb-1">示例：</div>
            <div className="text-xs text-slate-600 bg-slate-50 rounded p-2 mb-3 leading-relaxed">
              创建一个 AI 备注表，包含备注内容（必填，最长500字）、关联单据号（可选）和填写人字段。
            </div>
            <textarea
              id="ai-write-target-requirement"
              className="w-full border border-slate-300 rounded-lg p-2 text-sm min-h-[100px] focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none"
              autoFocus
              placeholder="描述写入目标的用途、需要哪些字段…"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600"
                onClick={() => setShowAIDialog(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg bg-purple-500 text-white disabled:opacity-50"
                onClick={() => {
                  const el = document.getElementById('ai-write-target-requirement') as HTMLTextAreaElement | null
                  const v = el?.value.trim()
                  if (v) void handleAIGenerate(v)
                }}
              >
                生成
              </button>
            </div>
          </div>
        </div>
      )}
      {loading && <p className="text-sm text-slate-400 py-6 text-center">加载中…</p>}
      {!loading && targets.length === 0 && (
        <p className="text-sm text-slate-400 py-6 text-center">暂无写入目标</p>
      )}
      <div className="space-y-2">
        {targets.map((t) => (
          <div key={t.name} className="bg-white rounded-lg shadow p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{t.label}</span>
                <span className="text-[10px] text-slate-400 font-mono">{t.name} → {t.targetTable}</span>
                {t.targetKind === 'action' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">API 动作</span>
                )}
                {!t.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">停用</span>}
              </div>
              <div className="flex gap-3">
                <button onClick={() => startEdit(t)} className="text-xs text-sky-600">编辑</button>
                <button onClick={() => void remove(t.name)} className="text-xs text-red-500">删除</button>
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              {t.targetKind === 'action'
                ? `动作：${t.targetTable}`
                : `字段：${t.fields.map((f) => f.name).join('、') || '—'}`}
              {' · 角色：'}
              {t.roles.join('、') || '仅管理员'}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
