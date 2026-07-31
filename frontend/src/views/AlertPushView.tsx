import { useEffect, useState } from 'react'
import { apiFetch } from '../utils/api'

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
    <div className="p-4 max-w-2xl mx-auto">
      {/* Tab 切换 */}
      <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1">
        {(['rules', 'webhooks', 'logs'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm rounded-md font-medium transition ${
              tab === t ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'rules' ? '警报规则' : t === 'webhooks' ? 'Webhook' : '推送日志'}
          </button>
        ))}
      </div>

      {tab === 'rules' && <RulesTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
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
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此警报规则？')) return
    try {
      await apiFetch(`/admin/alert-rules/${id}`, { method: 'DELETE' })
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
    return <RuleForm form={form} setForm={setForm} error={error} editId={editId} onSave={handleSave} onCancel={() => setMode('list')} />
  }

  return (
    <div>
      {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}
      {msg && <div className="mb-3 p-2 bg-green-50 text-green-600 text-sm rounded">{msg}</div>}
      <button onClick={openCreate} className="w-full py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600 mb-4">
        ＋ 新增警报规则
      </button>
      {loading ? (
        <p className="text-sm text-slate-500 text-center">加载中...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500 text-center">暂无警报规则</p>
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <div key={r.id} className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm">{r.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${r.enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                  {r.enabled ? '启用' : '禁用'}
                </span>
              </div>
              <div className="text-xs text-slate-500 mb-2">
                <span className="mr-3">{r.trigger_type === 'cron' ? `⏰ ${r.cron_expr}` : `⚡ ${r.event_name}`}</span>
                {r.description && <span className="text-slate-400">· {r.description}</span>}
              </div>
              <div className="flex gap-2 flex-wrap">
                <Btn onClick={() => openEdit(r)}>编辑</Btn>
                <Btn onClick={() => handleTest(r.id)}>测试</Btn>
                <Btn onClick={() => handleDelete(r.id)} danger>删除</Btn>
              </div>
            </div>
          ))}
        </div>
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

function RuleForm({ form, setForm, error, editId, onSave, onCancel }: {
  form: RuleFormData
  setForm: (f: RuleFormData) => void
  error: string
  editId: number | null
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">{editId ? '编辑' : '新增'}警报规则</h2>
      {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}
      <div className="space-y-3">
        <Field label="规则名称 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如：库存低于安全库存" />
        <Field label="描述" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="规则用途说明" />

        {/* 触发方式 */}
        <div>
          <label className="block text-sm text-slate-600 mb-1">触发方式 *</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1 text-sm">
              <input type="radio" checked={form.trigger_type === 'cron'} onChange={() => setForm({ ...form, trigger_type: 'cron' })} />
              定时检查
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input type="radio" checked={form.trigger_type === 'event'} onChange={() => setForm({ ...form, trigger_type: 'event' })} />
              事件触发
            </label>
          </div>
        </div>

        {form.trigger_type === 'cron' && (
          <>
            <Field label="Cron 表达式 *" value={form.cron_expr} onChange={(v) => setForm({ ...form, cron_expr: v })} placeholder="如：*/5 * * * *（每5分钟）" />
            <div>
              <label className="block text-sm text-slate-600 mb-1">检查 SQL *（返回行数&gt;0 即触发）</label>
              <textarea value={form.sql_template} onChange={(e) => setForm({ ...form, sql_template: e.target.value })} rows={4}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:border-sky-500"
                placeholder="SELECT * FROM ... WHERE ..." />
            </div>
          </>
        )}

        {form.trigger_type === 'event' && (
          <Field label="事件名称 *" value={form.event_name} onChange={(v) => setForm({ ...form, event_name: v })} placeholder="如：pro-sign-save" />
        )}

        <Field label="去重键列名" value={form.key_column} onChange={(v) => setForm({ ...form, key_column: v })} placeholder="如：DocEntry（避免重复告警）" />
        <Field label="冷却时间（分钟）" value={form.cooldown_minutes} onChange={(v) => setForm({ ...form, cooldown_minutes: v })} placeholder="60" />

        <hr className="border-slate-200" />
        <p className="text-xs text-slate-400">推送目标（用户优先于角色）</p>
        <Field label="目标用户（逗号分隔）" value={form.target_users_json} onChange={(v) => setForm({ ...form, target_users_json: v })} placeholder="U001, U002" />
        <Field label="目标角色（逗号分隔）" value={form.target_roles_json} onChange={(v) => setForm({ ...form, target_roles_json: v })} placeholder="production, warehouse" />
        <Field label="群 Webhook ID（逗号分隔）" value={form.target_webhooks_json} onChange={(v) => setForm({ ...form, target_webhooks_json: v })} placeholder="1, 2" />

        <hr className="border-slate-200" />
        <p className="text-xs text-slate-400">卡片消息模板（支持 {'{ 列名 }'} 占位符）</p>
        <Field label="卡片标题" value={form.card_title_template} onChange={(v) => setForm({ ...form, card_title_template: v })} placeholder="⚠️ {ItemName} 库存不足" />
        <div>
          <label className="block text-sm text-slate-600 mb-1">卡片正文（Markdown）</label>
          <textarea value={form.card_body_template} onChange={(e) => setForm({ ...form, card_body_template: e.target.value })} rows={4}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
            placeholder="- 物料：{ItemName}&#10;- 当前库存：{OnHand}&#10;- 安全库存：{MinLevel}" />
        </div>
        <Field label="按钮文字" value={form.card_btn_title} onChange={(v) => setForm({ ...form, card_btn_title: v })} placeholder="查看详情" />
        <Field label="按钮链接" value={form.card_btn_url} onChange={(v) => setForm({ ...form, card_btn_url: v })} placeholder="https://your-domain.com/" />

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          启用
        </label>
      </div>
      <div className="flex gap-3 mt-4">
        <button onClick={onCancel} className="flex-1 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm hover:bg-slate-50">取消</button>
        <button onClick={onSave} className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600">保存</button>
      </div>
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
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此 Webhook？')) return
    try {
      await apiFetch(`/admin/alert-webhooks/${id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (mode === 'form') {
    return (
      <div>
        <h2 className="text-lg font-semibold mb-4">{editId ? '编辑' : '新增'} Webhook</h2>
        {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}
        <div className="space-y-3">
          <Field label="名称 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如：生产报警群" />
          <Field label="Webhook URL *" value={form.webhook_url} onChange={(v) => setForm({ ...form, webhook_url: v })} placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
          <Field label="加签密钥（可选）" value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} placeholder="SEC..." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            启用
          </label>
        </div>
        <div className="flex gap-3 mt-4">
          <button onClick={() => setMode('list')} className="flex-1 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm hover:bg-slate-50">取消</button>
          <button onClick={handleSave} className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600">保存</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}
      <button onClick={openCreate} className="w-full py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600 mb-4">
        ＋ 新增 Webhook
      </button>
      {loading ? (
        <p className="text-sm text-slate-500 text-center">加载中...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500 text-center">暂无 Webhook</p>
      ) : (
        <div className="space-y-3">
          {items.map((w) => (
            <div key={w.id} className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm">{w.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${w.enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                  {w.enabled ? '启用' : '禁用'}
                </span>
              </div>
              <div className="text-xs text-slate-400 mb-2 truncate">{w.webhook_url_masked}</div>
              <div className="flex gap-2">
                <Btn onClick={() => openEdit(w)}>编辑</Btn>
                <Btn onClick={() => handleDelete(w.id)} danger>删除</Btn>
              </div>
            </div>
          ))}
        </div>
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

  return (
    <div>
      {loading ? (
        <p className="text-sm text-slate-500 text-center">加载中...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500 text-center">暂无推送记录</p>
      ) : (
        <>
          <div className="space-y-2">
            {items.map((l) => (
              <div key={l.id} className="bg-white rounded-lg shadow p-3 text-sm">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="font-medium">{l.rule_name || `规则#${l.rule_id}`}</span>
                    <span className="ml-2 text-xs text-slate-400">{l.trigger_type === 'cron' ? '⏰定时' : `⚡${l.event_name}`}</span>
                  </div>
                  <StatusBadge status={l.status} />
                </div>
                <div className="text-slate-500 mt-1 text-xs">
                  <span>{fmtTime(l.triggered_at)}</span>
                  <span className="ml-3">个人 {l.sent_count} · 群 {l.webhook_count}</span>
                </div>
                {l.card_title && <div className="text-slate-600 mt-1 text-xs truncate">📋 {l.card_title}</div>}
                {l.error_message && <div className="text-red-500 mt-1 text-xs truncate">❌ {l.error_message}</div>}
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-3 mt-4 text-sm">
              <button onClick={() => goPage(page - 1)} disabled={page <= 1} className="px-3 py-1 border rounded disabled:opacity-30">上一页</button>
              <span className="text-slate-500">{page} / {totalPages}</span>
              <button onClick={() => goPage(page + 1)} disabled={page >= totalPages} className="px-3 py-1 border rounded disabled:opacity-30">下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ==================== Shared Components ====================

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm text-slate-600 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
        placeholder={placeholder}
      />
    </div>
  )
}

function Btn({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-xs rounded ${danger ? 'text-red-500 border border-red-200 hover:bg-red-50' : 'text-sky-600 border border-sky-200 hover:bg-sky-50'}`}
    >
      {children}
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    sent: { label: '✓ 已发送', cls: 'text-green-600' },
    failed: { label: '✗ 失败', cls: 'text-red-600' },
    skipped: { label: '⊘ 跳过', cls: 'text-amber-600' },
    pending: { label: '⋯ 进行中', cls: 'text-blue-500' },
  }
  const s = map[status] || { label: status, cls: 'text-slate-500' }
  return <span className={`text-xs font-medium ${s.cls}`}>{s.label}</span>
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
