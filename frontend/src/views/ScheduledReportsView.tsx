import { useEffect, useState } from 'react'
import { Clock, Eye, History, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { apiFetch } from '../utils/api'
import { AdminPage, Badge, Button, Card, Checkbox, EditorActions, EmptyState, Field, IconButton, Input, Notice, RecordRow, Section, Segmented, Select, Skeleton, TableWrap, Textarea } from '../ui'
import ChatMarkdown from '../components/ChatMarkdown'
import { tableClass, tdClass, thClass } from '../ui/classes'
import { confirmDelete } from '../ui/confirm'

interface ScheduledReport {
  id: number
  name: string
  cron_expr: string
  skill_name: string | null
  prompt_template: string
  /** 看板要点：关联了看板的 Agent */
  agent_key: string | null
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

interface DashboardAgent {
  agentKey: string
  label: string
  dashboardKey: string
  roles: string[]
}

const EMPTY_FORM = {
  /** prompt：让 Agent 按指令写报告；digest：把关联看板的数据写成 3~5 条要点 */
  kind: 'prompt' as 'prompt' | 'digest',
  agent_key: '',
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
  const [agents, setAgents] = useState<DashboardAgent[]>([])

  // 关联了看板的 Agent（看板要点用）；进入表单时取一次
  const loadAgents = () => {
    apiFetch('/admin/agents')
      .then((d) => setAgents((Array.isArray(d?.items) ? d.items : []).filter((a: DashboardAgent) => a.dashboardKey)))
      .catch(() => setAgents([]))
  }

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
    loadAgents()
    setEditId(null)
    setForm(EMPTY_FORM)
    setError('')
    setMode('form')
  }

  const openEdit = (r: ScheduledReport) => {
    loadAgents()
    setEditId(r.id)
    const roles = safeJsonParse(r.target_roles_json)
    const users = safeJsonParse(r.target_users_json)
    const channels = safeJsonParse(r.channels_json)
    setForm({
      kind: r.agent_key ? 'digest' : 'prompt',
      agent_key: r.agent_key || '',
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
    const digest = form.kind === 'digest'
    if (!form.name || !form.cron_expr || (digest ? !form.agent_key : !form.prompt_template)) {
      setError(digest ? '名称、cron 表达式、关联看板的 Agent 为必填' : '名称、cron 表达式、Prompt 为必填')
      return
    }
    setError('')
    const body: Record<string, unknown> = {
      name: form.name,
      cron_expr: form.cron_expr,
      skill_name: digest ? null : form.skill_name || null,
      prompt_template: form.prompt_template,
      agent_key: digest ? form.agent_key : null,
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
              <Field label="报告方式">
                <Segmented
                  value={form.kind}
                  onChange={(kind) => setForm({ ...form, kind })}
                  options={[
                    { value: 'prompt', label: 'AI 按指令写报告' },
                    { value: 'digest', label: '看板每日要点' },
                  ]}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Cron 表达式 *" hint="分 时 日 月 周，如 0 8 * * 1-5 = 工作日 8 点">
                  <Input className="font-mono" value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} placeholder="0 8 * * 1-5" />
                </Field>
                {form.kind === 'digest' ? (
                  <Field label="看板（关联看板的 Agent）*">
                    <Select value={form.agent_key} onChange={(e) => setForm({ ...form, agent_key: e.target.value })}>
                      <option value="">请选择</option>
                      {agents.map((a) => (
                        <option key={a.agentKey} value={a.agentKey}>
                          {a.label}（看板 {a.dashboardKey}）
                        </option>
                      ))}
                      {form.agent_key && !agents.some((a) => a.agentKey === form.agent_key) && <option value={form.agent_key}>{form.agent_key}</option>}
                    </Select>
                  </Field>
                ) : (
                  <Field label="关联 Skill（可选）">
                    <Input value={form.skill_name} onChange={(e) => setForm({ ...form, skill_name: e.target.value })} placeholder="skill 名称" />
                  </Field>
                )}
              </div>
              {form.kind === 'digest' ? (
                <>
                  <Field
                    label="关注点（可选）"
                    hint="按看板筛选默认值（如本月）取各卡片数据，AI 写 3~5 条带数字的要点，附看板链接；每组推送对象按自己的角色取数，看不到的卡片不会写进去"
                  >
                    <Textarea
                      rows={3}
                      value={form.prompt_template}
                      onChange={(e) => setForm({ ...form, prompt_template: e.target.value })}
                      placeholder="如：重点关注大客户变化和退货"
                    />
                  </Field>
                  {form.agent_key && (
                    <DigestPreview
                      agentKey={form.agent_key}
                      name={form.name}
                      focus={form.prompt_template}
                      roles={agents.find((a) => a.agentKey === form.agent_key)?.roles || []}
                    />
                  )}
                </>
              ) : (
                <Field label="Prompt 模板 *">
                  <Textarea
                    rows={10}
                    value={form.prompt_template}
                    onChange={(e) => setForm({ ...form, prompt_template: e.target.value })}
                    placeholder="请统计昨天的生产完工数量，按工序汇总..."
                  />
                </Field>
              )}
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
                      <span title="进消息收件箱的人数 · 其中 IM（钉钉等）发送成功的人数">
                        消息 {l.target_count} 人 · IM {l.sent_count}
                      </span>
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
              badges={
                <>
                  <Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? '启用' : '停用'}</Badge>
                  {r.agent_key && <Badge tone="info">看板要点 · {r.agent_key}</Badge>}
                </>
              }
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

/** 预览看板要点（不推送）：选一个角色视角，生成将要发出的正文 */
function DigestPreview({ agentKey, name, focus, roles }: { agentKey: string; name: string; focus: string; roles: string[] }) {
  const [role, setRole] = useState('')
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    setErr('')
    setText('')
    try {
      const r = await apiFetch('/admin/scheduled-reports/digest-preview', {
        method: 'POST',
        body: JSON.stringify({ agent_key: agentKey, name: name || '看板要点', prompt_template: focus, role }),
      })
      setText(r.text || '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Select className="w-48" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">按管理员视角</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              按角色 {r}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" icon={<Eye className="w-3.5 h-3.5" />} disabled={busy} onClick={() => void run()}>
          {busy ? '取数并生成中…' : '预览要点（不推送）'}
        </Button>
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
      {text && (
        <div className="text-[13px] bg-surface-2 rounded-lg p-3">
          <ChatMarkdown content={text} />
        </div>
      )}
    </div>
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
