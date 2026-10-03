import { useEffect, useState } from 'react'
import { Clock, History, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { apiFetch } from '../utils/api'
import { AdminPage, Badge, Button, Card, Checkbox, EditorActions, EmptyState, Field, IconButton, Input, Notice, RecordRow, Section, Skeleton, TableWrap, Textarea } from '../ui'
import { tableClass, tdClass, thClass } from '../ui/classes'
import { confirmDelete } from '../ui/confirm'

interface ScheduledReport {
  id: number
  name: string
  cron_expr: string
  skill_name: string | null
  prompt_template: string
  target_roles_json: string | null
  target_users_json: string | null
  channels_json: string
  enabled: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

interface LogEntry {
  id: number
  started_at: string
  finished_at: string | null
  status: string
  target_count: number
  sent_count: number
  error_message: string | null
}

type Mode = 'list' | 'form' | 'logs'

const EMPTY_FORM = {
  name: '',
  cron_expr: '',
  skill_name: '',
  prompt_template: '',
  target_roles_json: '',
  target_users_json: '',
  channels_json: 'dingtalk',
  enabled: true,
}

export default function ScheduledReportsView() {
  const [mode, setMode] = useState<Mode>('list')
  const [items, setItems] = useState<ScheduledReport[]>([])
  const [loading, setLoading] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logsName, setLogsName] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/admin/scheduled-reports')
      setItems(data.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const openCreate = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setError('')
    setMode('form')
  }

  const openEdit = (r: ScheduledReport) => {
    setEditId(r.id)
    const roles = safeJsonParse(r.target_roles_json)
    const users = safeJsonParse(r.target_users_json)
    const channels = safeJsonParse(r.channels_json)
    setForm({
      name: r.name,
      cron_expr: r.cron_expr,
      skill_name: r.skill_name || '',
      prompt_template: r.prompt_template,
      target_roles_json: Array.isArray(roles) ? roles.join(', ') : '',
      target_users_json: Array.isArray(users) ? users.join(', ') : '',
      channels_json: Array.isArray(channels) ? channels.join(', ') : 'dingtalk',
      enabled: !!r.enabled,
    })
    setError('')
    setMode('form')
  }

  const handleSave = async () => {
    if (!form.name || !form.cron_expr || !form.prompt_template) {
      setError('名称、cron 表达式、Prompt 为必填')
      return
    }
    setError('')
    const body: Record<string, unknown> = {
      name: form.name,
      cron_expr: form.cron_expr,
      skill_name: form.skill_name || null,
      prompt_template: form.prompt_template,
      target_roles_json: splitComma(form.target_roles_json),
      target_users_json: splitComma(form.target_users_json),
      channels_json: splitComma(form.channels_json),
      enabled: form.enabled,
    }
    setSaving(true)
    try {
      if (editId) {
        await apiFetch(`/admin/scheduled-reports/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await apiFetch('/admin/scheduled-reports', { method: 'POST', body: JSON.stringify(body) })
      }
      setMode('list')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (r: ScheduledReport) => {
    if (!(await confirmDelete(`推送任务「${r.name}」`))) return
    try {
      await apiFetch(`/admin/scheduled-reports/${r.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  const handleTrigger = async (id: number) => {
    try {
      await apiFetch(`/admin/scheduled-reports/${id}/trigger`, { method: 'POST' })
      setMsg('已触发执行')
      setTimeout(() => setMsg(''), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : '触发失败')
    }
  }

  const openLogs = async (r: ScheduledReport) => {
    setLogsName(r.name)
    try {
      const data = await apiFetch(`/admin/scheduled-reports/${r.id}/logs`)
      setLogs(data.items || [])
    } catch {
      setLogs([])
    }
    setMode('logs')
  }

  if (mode === 'form') {
    return (
      <AdminPage title={`${editId ? '编辑' : '新增'}推送任务`} onBack={() => setMode('list')} withActionBar>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
          <Section title="任务内容">
            <div className="flex flex-col gap-3">
              <Field label="任务名称 *">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：每日生产日报" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Cron 表达式 *" hint="分 时 日 月 周，如 0 8 * * 1-5 = 工作日 8 点">
                  <Input className="font-mono" value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} placeholder="0 8 * * 1-5" />
                </Field>
                <Field label="关联 Skill（可选）">
                  <Input value={form.skill_name} onChange={(e) => setForm({ ...form, skill_name: e.target.value })} placeholder="skill 名称" />
                </Field>
              </div>
              <Field label="Prompt 模板 *">
                <Textarea
                  rows={10}
                  value={form.prompt_template}
                  onChange={(e) => setForm({ ...form, prompt_template: e.target.value })}
                  placeholder="请统计昨天的生产完工数量，按工序汇总..."
                />
              </Field>
            </div>
          </Section>
          <Section title="推送" hint="多个值用逗号分隔">
            <div className="flex flex-col gap-3">
              <Field label="目标角色">
                <Input value={form.target_roles_json} onChange={(e) => setForm({ ...form, target_roles_json: e.target.value })} placeholder="production, warehouse" />
              </Field>
              <Field label="目标用户" hint="优先于角色">
                <Input value={form.target_users_json} onChange={(e) => setForm({ ...form, target_users_json: e.target.value })} placeholder="U001, U002" />
              </Field>
              <Field label="推送渠道">
                <Input value={form.channels_json} onChange={(e) => setForm({ ...form, channels_json: e.target.value })} placeholder="dingtalk, wecom, feishu" />
              </Field>
              <Checkbox label="启用" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            </div>
          </Section>
        </div>
        <EditorActions onCancel={() => setMode('list')} onSave={() => void handleSave()} saving={saving} />
      </AdminPage>
    )
  }

  if (mode === 'logs') {
    return (
      <AdminPage title={`执行日志 · ${logsName}`} onBack={() => setMode('list')}>
        {logs.length === 0 ? (
          <Card>
            <EmptyState title="暂无执行记录" />
          </Card>
        ) : (
          <TableWrap>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>开始时间</th>
                  <th className={thClass}>状态</th>
                  <th className={thClass}>推送</th>
                  <th className={thClass}>错误</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className={tdClass + ' num whitespace-nowrap'}>{fmtTime(l.started_at)}</td>
                    <td className={tdClass}>
                      <LogStatus status={l.status} />
                    </td>
                    <td className={tdClass + ' num'}>
                      {l.sent_count}/{l.target_count} 人
                    </td>
                    <td className={tdClass + ' text-xs text-danger'}>{l.error_message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </AdminPage>
    )
  }

  // list mode
  return (
    <AdminPage
      title="定时报告"
      description="按计划让 AI 生成报告，并推送到钉钉 / 企微 / 飞书"
      actions={
        <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
          新增推送任务
        </Button>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone="success">{msg}</Notice>}
      {loading ? (
        <Skeleton className="h-32" />
      ) : (
        <Card className="overflow-hidden">
          {items.length === 0 && <EmptyState title="暂无推送任务" />}
          {items.map((r) => (
            <RecordRow
              key={r.id}
              onClick={() => openEdit(r)}
              title={r.name}
              badges={<Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? '启用' : '停用'}</Badge>}
              meta={
                <span className="flex items-center gap-3 flex-wrap">
                  <span className="inline-flex items-center gap-1 font-mono">
                    <Clock className="w-3 h-3" />
                    {r.cron_expr}
                  </span>
                  <span>{safeJsonParse(r.channels_json)?.join(', ')}</span>
                  {r.skill_name && <span>Skill：{r.skill_name}</span>}
                </span>
              }
              actions={
                <>
                  <IconButton label="手动触发" onClick={() => void handleTrigger(r.id)}>
                    <Play className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="执行日志" onClick={() => void openLogs(r)}>
                    <History className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="编辑" onClick={() => openEdit(r)}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => void handleDelete(r)}>
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

function LogStatus({ status }: { status: string }) {
  if (status === 'done') return <Badge tone="success">成功</Badge>
  if (status === 'error') return <Badge tone="danger">失败</Badge>
  if (status === 'skipped') return <Badge tone="warning">跳过</Badge>
  return <Badge tone="primary">运行中</Badge>
}

function safeJsonParse(s: string | null): string[] | null {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function splitComma(s: string): string[] {
  return s.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
}

function fmtTime(s: string): string {
  if (!s) return '-'
  return s.replace('T', ' ').replace(/\.\d+$/, '').slice(0, 16)
}
