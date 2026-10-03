import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport } from '../utils/api'
import type { AppRole } from '../types'
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import AiGenerateDialog from '../components/AiGenerateDialog'
import { Badge, Button, Card, Checkbox, ChipSelect, Code, EditorActions, EmptyState, Field, IconButton, Input, RecordRow, Section, Segmented, Select, Skeleton } from '../ui'
import { confirmDelete } from '../ui/confirm'

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
    if (!(await confirmDelete(`写入目标「${name}」`))) return
    try {
      await apiFetch(`/ai/agent/write-targets-admin/${name}`, { method: 'DELETE' })
      showToast('已删除')
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  const aiDialog = (
    <AiGenerateDialog
      open={showAIDialog}
      title="AI 辅助生成写入目标"
      label="描述你想要的写入目标"
      example="创建一个 AI 备注表，包含备注内容（必填，最长500字）、关联单据号（可选）和填写人字段。"
      placeholder="描述写入目标的用途、需要哪些字段…"
      onConfirm={(v) => void handleAIGenerate(v)}
      onClose={() => setShowAIDialog(false)}
    />
  )

  if (editing) {
    const kind: TargetKind = editing.targetKind === 'action' ? 'action' : 'table'
    const act = actions.find((a) => a.name === editing.targetTable)
    return (
      <div className="flex flex-col gap-4">
        <h3 className="font-display text-base font-semibold text-fg">{isNew ? '新建写入目标' : `编辑：${editing.name}`}</h3>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
          <Section title="基本信息">
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="实体名（小写连字符）">
                  <Input
                    value={editing.name}
                    disabled={!isNew}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })}
                    placeholder="order-note"
                  />
                </Field>
                <Field label="显示名">
                  <Input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
                </Field>
              </div>
              <Field label="类型">
                <Segmented
                  value={kind}
                  onChange={(k) =>
                    setEditing({ ...editing, targetKind: k, targetTable: '', fields: k === 'action' ? [] : editing.fields })
                  }
                  options={[
                    { value: 'table', label: '表写入（白名单 INSERT）' },
                    { value: 'action', label: 'API 动作（调业务接口）' },
                  ]}
                />
              </Field>
              {kind === 'action' ? (
                <Field
                  label="API 动作（仅可选代码注册的动作）"
                  hint={act?.payloadHint ? <span className="font-mono break-all">payload 格式：{act.payloadHint}</span> : undefined}
                >
                  <Select value={editing.targetTable} onChange={(e) => setEditing({ ...editing, targetTable: e.target.value })}>
                    <option value="">请选择动作…</option>
                    {actions.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.label}（{a.name}）
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label="目标表名（仅字母/数字/下划线）">
                  <Input
                    className="font-mono"
                    value={editing.targetTable}
                    onChange={(e) => setEditing({ ...editing, targetTable: e.target.value })}
                    placeholder="X_ORDER_NOTE"
                  />
                </Field>
              )}
              <Field label="允许写入的角色">
                <ChipSelect
                  options={roles.map((r) => ({ value: r.roleKey, label: r.label }))}
                  selected={editing.roles}
                  onChange={(next) => setEditing({ ...editing, roles: next })}
                  empty="暂无角色定义"
                />
              </Field>
              <Checkbox label="启用" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
            </div>
          </Section>

          {kind === 'table' && (
            <Section
              title="字段白名单"
              actions={
                <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} onClick={addField}>
                  添加字段
                </Button>
              }
            >
              {editing.fields.length === 0 ? (
                <p className="text-xs text-subtle">尚未添加字段</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="hidden sm:grid grid-cols-[1fr_1fr_8rem_5rem_4rem_2rem] gap-2 text-xs text-muted px-1">
                    <span>列名</span>
                    <span>标签</span>
                    <span>类型</span>
                    <span>最大长度</span>
                    <span>必填</span>
                    <span />
                  </div>
                  {editing.fields.map((f, idx) => (
                    <div key={idx} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_8rem_5rem_4rem_2rem] gap-2 items-center">
                      <Input className="font-mono" value={f.name} onChange={(e) => updateField(idx, { name: e.target.value })} placeholder="列名" />
                      <Input value={f.label} onChange={(e) => updateField(idx, { label: e.target.value })} placeholder="标签" />
                      <Select value={f.sqlType} onChange={(e) => updateField(idx, { sqlType: e.target.value as SqlType })}>
                        {SQL_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                      <Input
                        type="number"
                        disabled={f.sqlType !== 'nvarchar'}
                        value={f.sqlType === 'nvarchar' ? f.maxLen : ''}
                        onChange={(e) => updateField(idx, { maxLen: Number(e.target.value) || 255 })}
                        title="最大长度"
                      />
                      <Checkbox checked={f.required} onChange={(e) => updateField(idx, { required: e.target.checked })} label="必填" />
                      <IconButton label="删除字段" className="hover:text-danger" onClick={() => removeField(idx)}>
                        <Trash2 className="w-4 h-4" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>

        <EditorActions onCancel={() => setEditing(null)} onSave={() => void save()} saving={saving} />
        <div className="h-16" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-muted">定义 AI 可写入的实体与字段白名单。写入经人工确认 + 参数化 + 审计。</p>
        <div className="flex gap-2">
          <Button variant="soft" icon={<Sparkles className="w-4 h-4" />} onClick={() => setShowAIDialog(true)} disabled={aiGenerating}>
            {aiGenerating ? '生成中…' : 'AI 辅助生成'}
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={startNew}>
            新建写入目标
          </Button>
        </div>
      </div>

      {loading && <Skeleton className="h-32" />}
      {!loading && (
        <Card className="overflow-hidden">
          {targets.length === 0 && <EmptyState title="暂无写入目标" />}
          {targets.map((t) => (
            <RecordRow
              key={t.name}
              onClick={() => startEdit(t)}
              title={t.label}
              badges={
                <>
                  <Code>
                    {t.name} → {t.targetTable}
                  </Code>
                  {t.targetKind === 'action' && <Badge tone="accent">API 动作</Badge>}
                  {!t.enabled && <Badge>已停用</Badge>}
                </>
              }
              meta={
                <span>
                  {t.targetKind === 'action' ? `动作：${t.targetTable}` : `字段：${t.fields.map((f) => f.name).join('、') || '—'}`}
                  {' · 角色：'}
                  {t.roles.join('、') || '仅管理员'}
                </span>
              }
              actions={
                <>
                  <IconButton label="编辑" onClick={() => startEdit(t)}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(t.name)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </>
              }
            />
          ))}
        </Card>
      )}
      {aiDialog}
    </div>
  )
}
