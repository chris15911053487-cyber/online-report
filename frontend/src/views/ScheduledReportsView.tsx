import { useEffect, useState } from 'react'
import { apiFetch } from '../utils/api'

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
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此推送任务？')) return
    try {
      await apiFetch(`/admin/scheduled-reports/${id}`, { method: 'DELETE' })
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
      <div className="p-4 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold mb-4">{editId ? '编辑' : '新增'}推送任务</h2>
        {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}
        <div className="space-y-3">
          <Field label="任务名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如：每日生产日报" />
          <Field label="Cron 表达式" value={form.cron_expr} onChange={(v) => setForm({ ...form, cron_expr: v })} placeholder="如：0 8 * * 1-5（工作日8点）" />
          <Field label="关联 Skill（可选）" value={form.skill_name} onChange={(v) => setForm({ ...form, skill_name: v })} placeholder="skill 名称" />
          <div>
            <label className="block text-sm text-slate-600 mb-1">Prompt 模板</label>
            <textarea
              value={form.prompt_template}
              onChange={(e) => setForm({ ...form, prompt_template: e.target.value })}
              rows={4}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
              placeholder="请统计昨天的生产完工数量，按工序汇总..."
            />
          </div>
          <Field label="目标角色（逗号分隔）" value={form.target_roles_json} onChange={(v) => setForm({ ...form, target_roles_json: v })} placeholder="production, warehouse" />
          <Field label="目标用户（逗号分隔，优先于角色）" value={form.target_users_json} onChange={(v) => setForm({ ...form, target_users_json: v })} placeholder="U001, U002" />
          <Field label="推送渠道（逗号分隔）" value={form.channels_json} onChange={(v) => setForm({ ...form, channels_json: v })} placeholder="dingtalk, wecom, feishu" />
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

  if (mode === 'logs') {
    return (
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">执行日志 · {logsName}</h2>
          <button onClick={() => setMode('list')} className="text-sm text-sky-500">返回</button>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-slate-500">暂无执行记录</p>
        ) : (
          <div className="space-y-2">
            {logs.map((l) => (
              <div key={l.id} className="bg-white rounded-lg shadow p-3 text-sm">
                <div className="flex justify-between">
                  <span className={l.status === 'done' ? 'text-green-600' : l.status === 'error' ? 'text-red-600' : 'text-amber-600'}>
                    {l.status === 'done' ? '✓ 成功' : l.status === 'error' ? '✗ 失败' : l.status === 'skipped' ? '⊘ 跳过' : '⋯ 运行中'}
                  </span>
                  <span className="text-slate-400">{fmtTime(l.started_at)}</span>
                </div>
                <div className="text-slate-600 mt-1">推送 {l.sent_count}/{l.target_count} 人</div>
                {l.error_message && <div className="text-red-500 mt-1 text-xs">{l.error_message}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // list mode
  return (
    <div className="p-4 max-w-lg mx-auto">
      {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}
      {msg && <div className="mb-3 p-2 bg-green-50 text-green-600 text-sm rounded">{msg}</div>}
      <button onClick={openCreate} className="w-full py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600 mb-4">
        ＋ 新增推送任务
      </button>
      {loading ? (
        <p className="text-sm text-slate-500 text-center">加载中...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500 text-center">暂无推送任务</p>
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
                <span className="mr-3">⏰ {r.cron_expr}</span>
                <span>{safeJsonParse(r.channels_json)?.join(', ')}</span>
              </div>
              <div className="flex gap-2 flex-wrap">
                <Btn onClick={() => openEdit(r)}>编辑</Btn>
                <Btn onClick={() => handleTrigger(r.id)}>手动触发</Btn>
                <Btn onClick={() => openLogs(r)}>日志</Btn>
                <Btn onClick={() => handleDelete(r.id)} danger>删除</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
