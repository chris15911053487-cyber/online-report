import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, ChevronLeft } from 'lucide-react'
import { useStore } from '../store'
import { tokenHex } from '../theme'
import { apiFetch } from '../utils/api'
import { AGENT_ICON_NAMES } from './AgentHubView'
import type { AgentAdmin, AgentQuickPrompt, AgentSkillOption } from '../types'

const EMPTY_AGENT: AgentAdmin = {
  agentKey: '',
  label: '',
  subtitle: '',
  description: '',
  icon: 'Bot',
  themeColor: '',
  welcomeMd: '',
  layoutMode: 'canvas',
  quickPrompts: [],
  defaultPrompt: '',
  defaultEnabled: false,
  defaultCacheSecs: 300,
  skills: [],
  systemPromptExtra: '',
  roles: [],
  enabled: true,
  sortOrder: 100,
  dashboardKey: '',
}

const inputCls =
  'w-full px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:border-primary'
const labelCls = 'block text-[13px] font-medium text-fg-2 mb-1'

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-lg border border-line p-4 mb-3">
      <h3 className="text-sm font-semibold text-fg mb-0.5">{title}</h3>
      {hint && <p className="text-[12px] text-subtle mb-3">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </div>
  )
}

export default function AgentsAdminView() {
  const { showToast } = useStore()
  const [items, setItems] = useState<AgentAdmin[]>([])
  const [availableSkills, setAvailableSkills] = useState<AgentSkillOption[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [availableDashboards, setAvailableDashboards] = useState<{ dashboardKey: string; label: string; enabled: boolean }[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  /** null = 列表模式；非 null = 编辑中 */
  const [editing, setEditing] = useState<AgentAdmin | null>(null)
  const [isNew, setIsNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/admin/agents')
      setItems(Array.isArray(data?.items) ? data.items : [])
      setAvailableSkills(Array.isArray(data?.availableSkills) ? data.availableSkills : [])
      setAvailableRoles(Array.isArray(data?.availableRoles) ? data.availableRoles : [])
      // 看板列表单独取；失败（如尚未迁移）不影响 Agent 配置本身
      apiFetch('/admin/bi/dashboards')
        .then((d) => setAvailableDashboards(Array.isArray(d?.items) ? d.items : []))
        .catch(() => setAvailableDashboards([]))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agent 配置加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = (p: Partial<AgentAdmin>) => setEditing((cur) => (cur ? { ...cur, ...p } : cur))

  const toggleInList = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value]

  const handleSave = async () => {
    if (!editing) return
    if (!editing.agentKey.trim()) return showToast('请填写 Agent 标识')
    if (!editing.label.trim()) return showToast('请填写显示名称')

    setSaving(true)
    try {
      await apiFetch('/admin/agents', {
        method: 'POST',
        body: JSON.stringify(editing),
      })
      showToast('已保存')
      setEditing(null)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (agent: AgentAdmin) => {
    if (!window.confirm(`确定删除「${agent.label}」？此操作不可恢复。`)) return
    try {
      await apiFetch(`/admin/agents/${encodeURIComponent(agent.agentKey)}`, { method: 'DELETE' })
      showToast('已删除')
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败')
    }
  }

  // ---------- 快捷提问编辑 ----------
  const patchQuickPrompt = (idx: number, p: Partial<AgentQuickPrompt>) => {
    if (!editing) return
    const next = editing.quickPrompts.map((q, i) => (i === idx ? { ...q, ...p } : q))
    patch({ quickPrompts: next })
  }
  const addQuickPrompt = () => {
    if (!editing) return
    patch({ quickPrompts: [...editing.quickPrompts, { icon: '', label: '', prompt: '' }] })
  }
  const removeQuickPrompt = (idx: number) => {
    if (!editing) return
    patch({ quickPrompts: editing.quickPrompts.filter((_, i) => i !== idx) })
  }

  // ================= 列表模式 =================
  if (!editing) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Agent 配置</h2>
            <p className="text-[12px] text-muted mt-0.5">
              配置可在「Agent」页选择的智能体，能力由关联的 Skill 决定
            </p>
          </div>
          <button
            onClick={() => {
              setEditing({ ...EMPTY_AGENT })
              setIsNew(true)
            }}
            className="flex items-center gap-1 px-3 py-2 bg-primary text-primary-fg rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
            新增
          </button>
        </div>

        {loading && <p className="text-sm text-subtle">加载中…</p>}
        {!loading && error && (
          <div className="bg-danger-soft border border-danger/25 text-danger text-sm rounded-lg p-3">
            {error}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="text-sm text-subtle">暂无 Agent，点「新增」创建第一个。</p>
        )}

        <div className="space-y-2">
          {items.map((agent) => (
            <div
              key={agent.agentKey}
              className="bg-surface rounded-lg border border-line p-3.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[15px] font-semibold text-fg">{agent.label}</span>
                    <code className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-muted">
                      {agent.agentKey}
                    </code>
                    {!agent.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-muted">
                        已停用
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-soft text-primary">
                      {agent.layoutMode === 'canvas' ? '画布式' : '纯聊天'}
                    </span>
                  </div>
                  {agent.subtitle && (
                    <p className="text-[12px] text-subtle mt-1">{agent.subtitle}</p>
                  )}
                  <p className="text-[12px] text-muted mt-1.5">
                    关联 Skill：
                    {agent.skills.length > 0 ? (
                      agent.skills.join('、')
                    ) : (
                      <span className="text-warning">未关联（该 Agent 暂无数据查询能力）</span>
                    )}
                  </p>
                  {agent.dashboardKey && (
                    <p className="text-[12px] text-muted mt-0.5">关联看板：{agent.dashboardKey}</p>
                  )}
                  <p className="text-[12px] text-muted mt-0.5">
                    可见角色：
                    {agent.roles.length > 0 ? agent.roles.join('、') : '仅管理员'}
                  </p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => {
                      setEditing({ ...EMPTY_AGENT, ...agent })
                      setIsNew(false)
                    }}
                    className="p-2 text-subtle hover:text-primary hover:bg-primary-soft rounded-lg transition-colors"
                    aria-label="编辑"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(agent)}
                    className="p-2 text-subtle hover:text-danger hover:bg-danger-soft rounded-lg transition-colors"
                    aria-label="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

      </div>
    )
  }

  // ================= 编辑模式 =================
  return (
    <div className="p-4 pb-24">
      <button
        onClick={() => setEditing(null)}
        className="flex items-center gap-1 text-sm text-muted hover:text-fg-2 mb-3"
      >
        <ChevronLeft className="w-4 h-4" />
        返回列表
      </button>

      <h2 className="text-lg font-semibold text-fg mb-3">
        {isNew ? '新增 Agent' : `编辑：${editing.label || editing.agentKey}`}
      </h2>

      <Section title="基本信息">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Agent 标识（agentKey）</label>
            <input
              className={inputCls}
              value={editing.agentKey}
              disabled={!isNew}
              onChange={(e) => patch({ agentKey: e.target.value })}
              placeholder="sales-analysis"
            />
            <p className="text-[11px] text-subtle mt-1">
              小写字母开头，仅小写字母/数字/连字符；创建后不可修改
            </p>
          </div>
          <div>
            <label className={labelCls}>显示名称</label>
            <input
              className={inputCls}
              value={editing.label}
              onChange={(e) => patch({ label: e.target.value })}
              placeholder="销售分析 Agent"
            />
          </div>
          <div>
            <label className={labelCls}>副标题</label>
            <input
              className={inputCls}
              value={editing.subtitle || ''}
              onChange={(e) => patch({ subtitle: e.target.value })}
              placeholder="自然语言交互 · 预置报表 · 智能探索"
            />
          </div>
          <div>
            <label className={labelCls}>卡片描述</label>
            <textarea
              className={inputCls}
              rows={2}
              value={editing.description || ''}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="用一句话说明这个 Agent 能做什么"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelCls}>图标</label>
              <select
                className={inputCls}
                value={editing.icon || 'Bot'}
                onChange={(e) => patch({ icon: e.target.value })}
              >
                {AGENT_ICON_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-28">
              <label className={labelCls}>主题色</label>
              <input
                type="color"
                className="w-full h-[38px] border border-line-strong rounded-lg"
                value={editing.themeColor || tokenHex('primary')}
                onChange={(e) => patch({ themeColor: e.target.value })}
              />
              {editing.themeColor ? (
                <button type="button" className="mt-1 text-[11px] text-muted hover:text-fg" onClick={() => patch({ themeColor: '' })}>
                  跟随主题
                </button>
              ) : (
                <p className="mt-1 text-[11px] text-subtle">未设置：跟随主题</p>
              )}
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="关联 Skill（能力来源）"
        hint="Agent 本身不带查询能力：勾选的 Skill 决定它能查什么表、走什么流程。未勾选则只能做一般性问答。"
      >
        {availableSkills.length === 0 ? (
          <p className="text-[13px] text-subtle">
            暂无可用 Skill，请先到「AI Skill 管理」创建。
          </p>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {availableSkills.map((s) => (
              <label
                key={s.name}
                className="flex items-start gap-2.5 p-2.5 rounded-lg border border-line hover:bg-surface-2 cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 w-4 h-4"
                  checked={editing.skills.includes(s.name)}
                  onChange={() => patch({ skills: toggleInList(editing.skills, s.name) })}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <code className="text-[12px] font-medium text-fg">{s.name}</code>
                    {!s.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-muted">
                        已停用
                      </span>
                    )}
                  </span>
                  {s.description && (
                    <span className="block text-[12px] text-muted mt-0.5 leading-relaxed">
                      {s.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="对话配置">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>欢迎语</label>
            <textarea
              className={inputCls}
              rows={3}
              value={editing.welcomeMd || ''}
              onChange={(e) => patch({ welcomeMd: e.target.value })}
              placeholder="我是销售分析 Agent。你可以直接问我销售情况…"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className={labelCls + ' mb-0'}>快捷提问</label>
              <button
                onClick={addQuickPrompt}
                className="text-[12px] text-primary hover:text-primary font-medium"
              >
                + 添加
              </button>
            </div>
            {editing.quickPrompts.length === 0 && (
              <p className="text-[12px] text-subtle">未配置，进入 Agent 后不显示快捷入口。</p>
            )}
            <div className="space-y-2">
              {editing.quickPrompts.map((q, idx) => (
                <div key={idx} className="border border-line rounded-lg p-2.5">
                  <div className="flex gap-2 mb-2">
                    <input
                      className={inputCls + ' w-16 text-center'}
                      value={q.icon || ''}
                      onChange={(e) => patchQuickPrompt(idx, { icon: e.target.value })}
                      placeholder="📊"
                    />
                    <input
                      className={inputCls + ' flex-1'}
                      value={q.label}
                      onChange={(e) => patchQuickPrompt(idx, { label: e.target.value })}
                      placeholder="按钮文案，如：昨日销售日报"
                    />
                    <button
                      onClick={() => removeQuickPrompt(idx)}
                      className="p-2 text-subtle hover:text-danger rounded-lg flex-shrink-0"
                      aria-label="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <textarea
                    className={inputCls}
                    rows={2}
                    value={q.prompt}
                    onChange={(e) => patchQuickPrompt(idx, { prompt: e.target.value })}
                    placeholder="点击后实际发送给 Agent 的指令"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="BI 看板"
        hint="关联后，进入该 Agent 右侧默认显示这块看板（读缓存，秒开），用户可在看板上下钻或点击问 AI。看板与查询在「BI 看板管理」里维护。"
      >
        <select
          className={inputCls}
          value={editing.dashboardKey || ''}
          onChange={(e) => patch({ dashboardKey: e.target.value })}
        >
          <option value="">不关联（保持原有画布）</option>
          {availableDashboards.map((d) => (
            <option key={d.dashboardKey} value={d.dashboardKey}>
              {d.label}（{d.dashboardKey}）{d.enabled ? '' : ' · 已停用'}
            </option>
          ))}
          {editing.dashboardKey && !availableDashboards.some((d) => d.dashboardKey === editing.dashboardKey) && (
            <option value={editing.dashboardKey}>{editing.dashboardKey}（不存在）</option>
          )}
        </select>
      </Section>

      <Section
        title="默认内容"
        hint="开启后，进入该 Agent 会自动执行一次默认分析（对应原型里进入即展示的日报）。已关联看板时不执行，以看板为准。"
      >
        <div className="space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={!!editing.defaultEnabled}
              onChange={(e) => patch({ defaultEnabled: e.target.checked })}
            />
            <span className="text-sm text-fg-2">进入时自动执行默认分析</span>
          </label>
          <div>
            <label className={labelCls}>默认分析指令</label>
            <textarea
              className={inputCls}
              rows={2}
              value={editing.defaultPrompt || ''}
              onChange={(e) => patch({ defaultPrompt: e.target.value })}
              placeholder="生成今日销售日报，包含核心指标与各区域分布"
            />
          </div>
          <div>
            <label className={labelCls}>结果缓存（秒）</label>
            <input
              type="number"
              className={inputCls}
              value={editing.defaultCacheSecs ?? 300}
              onChange={(e) => patch({ defaultCacheSecs: Number(e.target.value) })}
            />
            <p className="text-[11px] text-subtle mt-1">
              0 = 每次进入都重新查询；300 = 5 分钟内复用上次结果，避免频繁跑 SQL
            </p>
          </div>
        </div>
      </Section>

      <Section title="展示与权限">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>布局模式</label>
            <select
              className={inputCls}
              value={editing.layoutMode}
              onChange={(e) => patch({ layoutMode: e.target.value as 'canvas' | 'chat' })}
            >
              <option value="canvas">画布式（对话 + 图表/指标画布）</option>
              <option value="chat">纯聊天（仅文字对话）</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>可见角色</label>
            {availableRoles.length === 0 ? (
              <p className="text-[12px] text-subtle">暂无自定义角色</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableRoles.map((r) => (
                  <label
                    key={r}
                    className={`px-2.5 py-1.5 rounded-lg border text-[12px] cursor-pointer transition-colors ${
                      editing.roles.includes(r)
                        ? 'border-primary/60 bg-primary-soft text-primary'
                        : 'border-line text-fg-2 hover:bg-surface-2'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="hidden"
                      checked={editing.roles.includes(r)}
                      onChange={() => patch({ roles: toggleInList(editing.roles, r) })}
                    />
                    {r}
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-subtle mt-1.5">
              不勾选 = 仅管理员可见；管理员始终可见全部 Agent
            </p>
          </div>
        </div>
      </Section>

      <Section title="高级">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>附加指令（system prompt）</label>
            <textarea
              className={inputCls}
              rows={4}
              value={editing.systemPromptExtra || ''}
              onChange={(e) => patch({ systemPromptExtra: e.target.value })}
              placeholder="仅对该 Agent 生效的额外规则，如追问分类、输出格式偏好"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelCls}>排序</label>
              <input
                type="number"
                className={inputCls}
                value={editing.sortOrder}
                onChange={(e) => patch({ sortOrder: Number(e.target.value) })}
              />
            </div>
            <div className="flex-1 flex items-end">
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={editing.enabled}
                  onChange={(e) => patch({ enabled: e.target.checked })}
                />
                <span className="text-sm text-fg-2">启用</span>
              </label>
            </div>
          </div>
        </div>
      </Section>

      <div className="flex gap-3">
        <button
          onClick={() => setEditing(null)}
          className="flex-1 py-2.5 border border-line-strong text-fg-2 rounded-lg text-sm font-medium hover:bg-surface-2 transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2.5 bg-primary text-primary-fg rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
