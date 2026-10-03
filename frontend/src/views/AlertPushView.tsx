import { useEffect, useState } from 'react'
import { Clock, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react'
import { apiFetch } from '../utils/api'
import { AdminPage, Badge, Button, Card, Checkbox, EditorActions, EmptyState, Field, IconButton, Input, Notice, Pager, RecordRow, Section, Segmented, Skeleton, Tabs, Textarea, TableWrap } from '../ui'
import { tableClass, tdClass, thClass } from '../ui/classes'
import { confirmDelete } from '../ui/confirm'

// ==================== Types ====================

interface AlertRule {
  id: number
  name: string
  description: string | null
  trigger_type: 'cron' | 'event'
  cron_expr: string | null
  sql_template: string | null
  key_column: string | null
  event_name: string | null
  target_users_json: string | null
  target_roles_json: string | null
  target_webhooks_json: string | null
  card_title_template: string
  card_body_template: string | null
  card_btn_title: string | null
  card_btn_url: string | null
  cooldown_minutes: number
  enabled: boolean
  sort_order: number
  created_at: string
}

interface AlertWebhook {
  id: number
  name: string
  webhook_url: string
  webhook_url_masked: string
  secret_masked: string
  enabled: boolean
  created_at: string
}

interface AlertLog {
  id: number
  rule_id: number
  rule_name: string | null
  trigger_type: string
  event_name: string | null
  triggered_at: string
  status: string
  target_count: number
  sent_count: number
  webhook_count: number
  card_title: string | null
  error_message: string | null
  finished_at: string | null
}

type Tab = 'rules' | 'webhooks' | 'logs'

// ==================== Main Component ====================

export default function AlertPushView() {
  const [tab, setTab] = useState<Tab>('rules')

  return (
    <AdminPage title="警报推送" description="按规则检查业务数据或响应事件，推送给个人与钉钉群">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'rules', label: '警报规则' },
          { value: 'webhooks', label: '群 Webhook' },
          { value: 'logs', label: '推送日志' },
        ]}
      />
      {tab === 'rules' && <RulesTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'logs' && <LogsTab />}
    </AdminPage>
  )
}

function TriggerLabel({ type, cron, event }: { type: string; cron?: string | null; event?: string | null }) {
  return type === 'cron' ? (
    <span className="inline-flex items-center gap-1">
      <Clock className="w-3 h-3" />
      {cron || '定时'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1">
      <Zap className="w-3 h-3" />
      {event}
    </span>
  )
}

// ==================== Rules Tab ====================

function RulesTab() {
  const [items, setItems] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_RULE_FORM)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/admin/alert-rules')
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
    setForm(EMPTY_RULE_FORM)
    setError('')
    setMode('form')
  }

  const openEdit = (r: AlertRule) => {
    setEditId(r.id)
    setForm({
      name: r.name,
      description: r.description || '',
      trigger_type: r.trigger_type,
      cron_expr: r.cron_expr || '',
      sql_template: r.sql_template || '',
      key_column: r.key_column || '',
      event_name: r.event_name || '',
      target_users_json: arrToComma(r.target_users_json),
      target_roles_json: arrToComma(r.target_roles_json),
      target_webhooks_json: arrToComma(r.target_webhooks_json),
      card_title_template: r.card_title_template || '',
      card_body_template: r.card_body_template || '',
      card_btn_title: r.card_btn_title || '',
      card_btn_url: r.card_btn_url || '',
      cooldown_minutes: String(r.cooldown_minutes || 60),
      enabled: !!r.enabled,
    })
    setError('')
    setMode('form')
  }

  const handleSave = async () => {
    if (!form.name) { setError('名称必填'); return }
    if (form.trigger_type === 'cron' && (!form.cron_expr || !form.sql_template)) {
      setError('定时规则须填写 cron 表达式和检查 SQL'); return
    }
    if (form.trigger_type === 'event' && !form.event_name) {
      setError('事件规则须填写事件名称'); return
    }
    setError('')
    const body: Record<string, unknown> = {
      name: form.name,
      description: form.description || null,
      trigger_type: form.trigger_type,
      cron_expr: form.cron_expr || null,
      sql_template: form.sql_template || null,
      key_column: form.key_column || null,
      event_name: form.event_name || null,
      target_users_json: splitComma(form.target_users_json),
      target_roles_json: splitComma(form.target_roles_json),
      target_webhooks_json: splitComma(form.target_webhooks_json).map(Number).filter(Boolean),
      card_title_template: form.card_title_template || '⚠️ 警报通知',
      card_body_template: form.card_body_template || null,
      card_btn_title: form.card_btn_title || null,
      card_btn_url: form.card_btn_url || null,
      cooldown_minutes: Number(form.cooldown_minutes) || 60,
      enabled: form.enabled,
    }
    setSaving(true)
    try {
      if (editId) {
        await apiFetch(`/admin/alert-rules/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await apiFetch('/admin/alert-rules', { method: 'POST', body: JSON.stringify(body) })
      }
      setMode('list')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (r: AlertRule) => {
    if (!(await confirmDelete(`警报规则「${r.name}」`))) return
    try {
      await apiFetch(`/admin/alert-rules/${r.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  const handleTest = async (id: number) => {
    try {
      await apiFetch(`/admin/alert-rules/${id}/test`, { method: 'POST' })
      setMsg('已触发测试')
      setTimeout(() => setMsg(''), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : '触发失败')
    }
  }

  if (mode === 'form') {
    return <RuleForm form={form} setForm={setForm} error={error} editId={editId} saving={saving} onSave={handleSave} onCancel={() => setMode('list')} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>新增警报规则</Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone="success">{msg}</Notice>}
      {loading ? (
        <Skeleton className="h-32" />
      ) : (
        <Card className="overflow-hidden">
          {items.length === 0 && <EmptyState title="暂无警报规则" />}
          {items.map((r) => (
            <RecordRow
              key={r.id}
              onClick={() => openEdit(r)}
              title={r.name}
              badges={<Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? '启用' : '停用'}</Badge>}
              meta={
                <span className="flex items-center gap-2 flex-wrap">
                  <TriggerLabel type={r.trigger_type} cron={r.cron_expr} event={r.event_name} />
                  {r.description && <span className="text-subtle">· {r.description}</span>}
                </span>
              }
              actions={
                <>
                  <IconButton label="测试触发" onClick={() => void handleTest(r.id)}>
                    <Play className="w-4 h-4" />
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
    </div>
  )
}

// ==================== Rule Form ====================

const EMPTY_RULE_FORM = {
  name: '',
  description: '',
  trigger_type: 'cron' as 'cron' | 'event',
  cron_expr: '',
  sql_template: '',
  key_column: '',
  event_name: '',
  target_users_json: '',
  target_roles_json: '',
  target_webhooks_json: '',
  card_title_template: '⚠️ 警报通知',
  card_body_template: '',
  card_btn_title: '查看详情',
  card_btn_url: '',
  cooldown_minutes: '60',
  enabled: true,
}

type RuleFormData = typeof EMPTY_RULE_FORM

function RuleForm({ form, setForm, error, editId, saving, onSave, onCancel }: {
  form: RuleFormData
  setForm: (f: RuleFormData) => void
  error: string
  editId: number | null
  saving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const set = (p: Partial<RuleFormData>) => setForm({ ...form, ...p })
  return (
    <div className="flex flex-col gap-4 pb-20">
      <h3 className="font-display text-base font-semibold text-fg">{editId ? '编辑' : '新增'}警报规则</h3>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <div className="flex flex-col gap-4">
          <Section title="规则与触发">
            <div className="flex flex-col gap-3">
              <Field label="规则名称 *">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="如：库存低于安全库存" />
              </Field>
              <Field label="描述">
                <Input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="规则用途说明" />
              </Field>
              <Field label="触发方式 *">
                <Segmented
                  value={form.trigger_type}
                  onChange={(v) => set({ trigger_type: v })}
                  options={[
                    { value: 'cron', label: '定时检查' },
                    { value: 'event', label: '事件触发' },
                  ]}
                />
              </Field>
              {form.trigger_type === 'cron' ? (
                <>
                  <Field label="Cron 表达式 *">
                    <Input className="font-mono" value={form.cron_expr} onChange={(e) => set({ cron_expr: e.target.value })} placeholder="如：*/5 * * * *（每5分钟）" />
                  </Field>
                  <Field label="检查 SQL *" hint="返回行数 > 0 即触发">
                    <Textarea mono rows={8} value={form.sql_template} onChange={(e) => set({ sql_template: e.target.value })} placeholder="SELECT * FROM ... WHERE ..." spellCheck={false} />
                  </Field>
                </>
              ) : (
                <Field label="事件名称 *">
                  <Input className="font-mono" value={form.event_name} onChange={(e) => set({ event_name: e.target.value })} placeholder="如：pro-sign-save" />
                </Field>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="去重键列名" hint="避免同一行重复告警">
                  <Input value={form.key_column} onChange={(e) => set({ key_column: e.target.value })} placeholder="如：DocEntry" />
                </Field>
                <Field label="冷却时间（分钟）">
                  <Input type="number" value={form.cooldown_minutes} onChange={(e) => set({ cooldown_minutes: e.target.value })} placeholder="60" />
                </Field>
              </div>
              <Checkbox label="启用" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            </div>
          </Section>
        </div>

        <div className="flex flex-col gap-4">
          <Section title="推送目标" hint="用户优先于角色；多个值用逗号分隔">
            <div className="flex flex-col gap-3">
              <Field label="目标用户">
                <Input value={form.target_users_json} onChange={(e) => set({ target_users_json: e.target.value })} placeholder="U001, U002" />
              </Field>
              <Field label="目标角色">
                <Input value={form.target_roles_json} onChange={(e) => set({ target_roles_json: e.target.value })} placeholder="production, warehouse" />
              </Field>
              <Field label="群 Webhook ID" hint="见「群 Webhook」页签">
                <Input value={form.target_webhooks_json} onChange={(e) => set({ target_webhooks_json: e.target.value })} placeholder="1, 2" />
              </Field>
            </div>
          </Section>

          <Section title="卡片消息模板" hint={<>支持 {'{列名}'} 占位符</>}>
            <div className="flex flex-col gap-3">
              <Field label="卡片标题">
                <Input value={form.card_title_template} onChange={(e) => set({ card_title_template: e.target.value })} placeholder="{ItemName} 库存不足" />
              </Field>
              <Field label="卡片正文（Markdown）">
                <Textarea
                  rows={5}
                  value={form.card_body_template}
                  onChange={(e) => set({ card_body_template: e.target.value })}
                  placeholder={'- 物料：{ItemName}\n- 当前库存：{OnHand}\n- 安全库存：{MinLevel}'}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <Field label="按钮文字">
                  <Input value={form.card_btn_title} onChange={(e) => set({ card_btn_title: e.target.value })} placeholder="查看详情" />
                </Field>
                <Field label="按钮链接">
                  <Input value={form.card_btn_url} onChange={(e) => set({ card_btn_url: e.target.value })} placeholder="https://your-domain.com/" />
                </Field>
              </div>
            </div>
          </Section>
        </div>
      </div>
      <EditorActions onCancel={onCancel} onSave={onSave} saving={saving} />
    </div>
  )
}

// ==================== Webhooks Tab ====================

function WebhooksTab() {
  const [items, setItems] = useState<AlertWebhook[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState({ name: '', webhook_url: '', secret: '', enabled: true })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/admin/alert-webhooks')
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
    setForm({ name: '', webhook_url: '', secret: '', enabled: true })
    setError('')
    setMode('form')
  }

  const openEdit = (w: AlertWebhook) => {
    setEditId(w.id)
    setForm({ name: w.name, webhook_url: w.webhook_url || '', secret: '', enabled: !!w.enabled })
    setError('')
    setMode('form')
  }

  const handleSave = async () => {
    if (!form.name || !form.webhook_url) { setError('名称和 Webhook URL 必填'); return }
    setError('')
    const body: Record<string, unknown> = { name: form.name, webhook_url: form.webhook_url, enabled: form.enabled }
    if (form.secret) body.secret = form.secret
    setSaving(true)
    try {
      if (editId) {
        await apiFetch(`/admin/alert-webhooks/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await apiFetch('/admin/alert-webhooks', { method: 'POST', body: JSON.stringify(body) })
      }
      setMode('list')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (w: AlertWebhook) => {
    if (!(await confirmDelete(`Webhook「${w.name}」`))) return
    try {
      await apiFetch(`/admin/alert-webhooks/${w.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (mode === 'form') {
    return (
      <div className="flex flex-col gap-4 pb-20">
        <h3 className="font-display text-base font-semibold text-fg">{editId ? '编辑' : '新增'} Webhook</h3>
        {error && <Notice tone="danger">{error}</Notice>}
        <Section className="max-w-3xl">
          <div className="flex flex-col gap-3">
            <Field label="名称 *">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：生产报警群" />
            </Field>
            <Field label="Webhook URL *">
              <Input value={form.webhook_url} onChange={(e) => setForm({ ...form, webhook_url: e.target.value })} placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
            </Field>
            <Field label="加签密钥（可选）" hint={editId ? '留空表示不修改' : undefined}>
              <Input value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="SEC..." />
            </Field>
            <Checkbox label="启用" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          </div>
        </Section>
        <EditorActions onCancel={() => setMode('list')} onSave={handleSave} saving={saving} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>新增 Webhook</Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {loading ? (
        <Skeleton className="h-32" />
      ) : (
        <Card className="overflow-hidden">
          {items.length === 0 && <EmptyState title="暂无 Webhook" />}
          {items.map((w) => (
            <RecordRow
              key={w.id}
              onClick={() => openEdit(w)}
              title={w.name}
              badges={
                <>
                  <Badge>ID {w.id}</Badge>
                  <Badge tone={w.enabled ? 'success' : 'neutral'}>{w.enabled ? '启用' : '停用'}</Badge>
                </>
              }
              meta={<span className="truncate font-mono">{w.webhook_url_masked}</span>}
              actions={
                <>
                  <IconButton label="编辑" onClick={() => openEdit(w)}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => void handleDelete(w)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </>
              }
            />
          ))}
        </Card>
      )}
    </div>
  )
}

// ==================== Logs Tab ====================

function LogsTab() {
  const [items, setItems] = useState<AlertLog[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20

  const load = async (p = page) => {
    setLoading(true)
    try {
      const data = await apiFetch(`/admin/alert-logs?page=${p}&pageSize=${pageSize}`)
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const goPage = (p: number) => {
    setPage(p)
    load(p)
  }

  const totalPages = Math.ceil(total / pageSize)

  if (loading && items.length === 0) return <Skeleton className="h-40" />
  if (items.length === 0) return <Card><EmptyState title="暂无推送记录" /></Card>

  return (
    <TableWrap>
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>时间</th>
            <th className={thClass}>规则</th>
            <th className={thClass}>触发</th>
            <th className={thClass}>状态</th>
            <th className={thClass}>个人 / 群</th>
            <th className={thClass}>卡片标题 / 错误</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id}>
              <td className={tdClass + ' num whitespace-nowrap'}>{fmtTime(l.triggered_at)}</td>
              <td className={tdClass}>{l.rule_name || `规则#${l.rule_id}`}</td>
              <td className={tdClass + ' text-xs text-muted whitespace-nowrap'}>
                <TriggerLabel type={l.trigger_type} event={l.event_name} />
              </td>
              <td className={tdClass}><StatusBadge status={l.status} /></td>
              <td className={tdClass + ' num'}>{l.sent_count} / {l.webhook_count}</td>
              <td className={tdClass + ' text-xs max-w-[28rem]'}>
                {l.card_title && <div className="truncate">{l.card_title}</div>}
                {l.error_message && <div className="text-danger truncate" title={l.error_message}>{l.error_message}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} totalPages={totalPages} onChange={goPage} disabled={loading} summary={`共 ${total} 条`} />
    </TableWrap>
  )
}

// ==================== Shared Components ====================

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' | 'primary' }> = {
    sent: { label: '已发送', tone: 'success' },
    failed: { label: '失败', tone: 'danger' },
    skipped: { label: '跳过', tone: 'warning' },
    pending: { label: '进行中', tone: 'primary' },
  }
  const s = map[status]
  return s ? <Badge tone={s.tone}>{s.label}</Badge> : <Badge>{status}</Badge>
}

// ==================== Utilities ====================

function splitComma(s: string): string[] {
  return s.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
}

function arrToComma(s: string | null): string {
  if (!s) return ''
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr.join(', ') : ''
  } catch {
    return ''
  }
}

function fmtTime(s: string): string {
  if (!s) return '-'
  return s.replace('T', ' ').replace(/\.\d+$/, '').slice(0, 16)
}
