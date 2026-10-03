import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { tokenHex } from '../theme'
import { apiFetch } from '../utils/api'
import { AGENT_ICON_NAMES } from './AgentHubView'
import type { AgentAdmin, AgentQuickPrompt, AgentSkillOption } from '../types'
import { AdminPage, Badge, Button, Card, Checkbox, ChipSelect, Code, EditorActions, EmptyState, Field, IconButton, Input, Notice, RecordRow, Section, Select, Skeleton, Textarea } from '../ui'
import { confirmDelete } from '../ui/confirm'

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
    if (!(await confirmDelete(`「${agent.label}」`))) return
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
      <AdminPage
        title="Agent 配置"
        description="配置可在「Agent」页选择的智能体，能力由关联的 Skill 决定"
        actions={
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={() => {
              setEditing({ ...EMPTY_AGENT })
              setIsNew(true)
            }}
          >
            新增 Agent
          </Button>
        }
      >
        {loading && <Skeleton className="h-40" />}
        {!loading && error && <Notice tone="danger">{error}</Notice>}
        {!loading && !error && items.length === 0 && (
          <Card>
            <EmptyState title="暂无 Agent" description="点「新增 Agent」创建第一个" />
          </Card>
        )}
        {!loading && !error && items.length > 0 && (
          <Card className="overflow-hidden">
            {items.map((agent) => (
              <RecordRow
                key={agent.agentKey}
                onClick={() => {
                  setEditing({ ...EMPTY_AGENT, ...agent })
                  setIsNew(false)
                }}
                title={agent.label}
                badges={
                  <>
                    <Code>{agent.agentKey}</Code>
                    {!agent.enabled && <Badge>已停用</Badge>}
                    <Badge tone="primary">{agent.layoutMode === 'canvas' ? '画布式' : '纯聊天'}</Badge>
                    {agent.dashboardKey && <Badge tone="info">看板 {agent.dashboardKey}</Badge>}
                  </>
                }
                meta={
                  <>
                    {agent.subtitle && <span className="text-subtle">{agent.subtitle}</span>}
                    <span>
                      关联 Skill：
                      {agent.skills.length > 0 ? (
                        agent.skills.join('、')
                      ) : (
                        <span className="text-warning">未关联（该 Agent 暂无数据查询能力）</span>
                      )}
                      <span className="mx-2 text-subtle">·</span>
                      可见角色：{agent.roles.length > 0 ? agent.roles.join('、') : '仅管理员'}
                    </span>
                  </>
                }
                actions={
                  <>
                    <IconButton
                      label="编辑"
                      onClick={() => {
                        setEditing({ ...EMPTY_AGENT, ...agent })
                        setIsNew(false)
                      }}
                    >
                      <Pencil className="w-4 h-4" />
                    </IconButton>
                    <IconButton label="删除" className="hover:text-danger" onClick={() => void handleDelete(agent)}>
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

  // ================= 编辑模式 =================
  return (
    <AdminPage
      title={isNew ? '新增 Agent' : `编辑：${editing.label || editing.agentKey}`}
      onBack={() => setEditing(null)}
      withActionBar
    >
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <div className="flex flex-col gap-4">
          <Section title="基本信息">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Agent 标识（agentKey）" hint="小写字母开头，仅小写字母/数字/连字符；创建后不可修改">
                <Input
                  value={editing.agentKey}
                  disabled={!isNew}
                  onChange={(e) => patch({ agentKey: e.target.value })}
                  placeholder="sales-analysis"
                />
              </Field>
              <Field label="显示名称">
                <Input value={editing.label} onChange={(e) => patch({ label: e.target.value })} placeholder="销售分析 Agent" />
              </Field>
              <Field label="副标题" className="sm:col-span-2">
                <Input
                  value={editing.subtitle || ''}
                  onChange={(e) => patch({ subtitle: e.target.value })}
                  placeholder="自然语言交互 · 预置报表 · 智能探索"
                />
              </Field>
              <Field label="卡片描述" className="sm:col-span-2">
                <Textarea
                  rows={2}
                  value={editing.description || ''}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="用一句话说明这个 Agent 能做什么"
                />
              </Field>
              <Field label="图标">
                <Select value={editing.icon || 'Bot'} onChange={(e) => patch({ icon: e.target.value })}>
                  {AGENT_ICON_NAMES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="主题色"
                hint={
                  editing.themeColor ? (
                    <button type="button" className="text-muted hover:text-fg" onClick={() => patch({ themeColor: '' })}>
                      恢复为跟随主题
                    </button>
                  ) : (
                    '未设置：跟随主题'
                  )
                }
              >
                <input
                  type="color"
                  className="w-full h-[38px] border border-line rounded-lg bg-surface"
                  value={editing.themeColor || tokenHex('primary')}
                  onChange={(e) => patch({ themeColor: e.target.value })}
                />
              </Field>
            </div>
          </Section>

          <Section title="对话配置">
            <div className="flex flex-col gap-3">
              <Field label="欢迎语">
                <Textarea
                  rows={3}
                  value={editing.welcomeMd || ''}
                  onChange={(e) => patch({ welcomeMd: e.target.value })}
                  placeholder="我是销售分析 Agent。你可以直接问我销售情况…"
                />
              </Field>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[13px] font-medium text-fg-2">快捷提问</span>
                  <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} onClick={addQuickPrompt}>
                    添加
                  </Button>
                </div>
                {editing.quickPrompts.length === 0 && (
                  <p className="text-xs text-subtle">未配置，进入 Agent 后不显示快捷入口。</p>
                )}
                <div className="flex flex-col gap-2">
                  {editing.quickPrompts.map((q, idx) => (
                    <div key={idx} className="border border-line rounded-lg p-2.5 flex flex-col gap-2">
                      <div className="flex gap-2">
                        <Input
                          className="w-16 text-center"
                          value={q.icon || ''}
                          onChange={(e) => patchQuickPrompt(idx, { icon: e.target.value })}
                          placeholder="图标"
                        />
                        <Input
                          className="flex-1"
                          value={q.label}
                          onChange={(e) => patchQuickPrompt(idx, { label: e.target.value })}
                          placeholder="按钮文案，如：昨日销售日报"
                        />
                        <IconButton label="删除" className="h-[38px] w-[38px] hover:text-danger" onClick={() => removeQuickPrompt(idx)}>
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </div>
                      <Textarea
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

          <Section title="高级">
            <div className="flex flex-col gap-3">
              <Field label="附加指令（system prompt）">
                <Textarea
                  rows={5}
                  value={editing.systemPromptExtra || ''}
                  onChange={(e) => patch({ systemPromptExtra: e.target.value })}
                  placeholder="仅对该 Agent 生效的额外规则，如追问分类、输出格式偏好"
                />
              </Field>
              <div className="flex items-end gap-4">
                <Field label="排序" className="w-32">
                  <Input type="number" value={editing.sortOrder} onChange={(e) => patch({ sortOrder: Number(e.target.value) })} />
                </Field>
                <Checkbox className="pb-2" label="启用" checked={editing.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
              </div>
            </div>
          </Section>
        </div>

        <div className="flex flex-col gap-4">
          <Section
            title="关联 Skill（能力来源）"
            hint="Agent 本身不带查询能力：勾选的 Skill 决定它能查什么表、走什么流程。未勾选则只能做一般性问答。"
          >
            {availableSkills.length === 0 ? (
              <p className="text-[13px] text-subtle">暂无可用 Skill，请先到「AI Skill」创建。</p>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
                {availableSkills.map((s) => (
                  <label
                    key={s.name}
                    className="flex items-start gap-2.5 p-2.5 rounded-lg border border-line hover:bg-surface-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 accent-[rgb(var(--c-primary))]"
                      checked={editing.skills.includes(s.name)}
                      onChange={() => patch({ skills: toggleInList(editing.skills, s.name) })}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <code className="text-[12px] font-medium text-fg">{s.name}</code>
                        {!s.enabled && <Badge>已停用</Badge>}
                      </span>
                      {s.description && (
                        <span className="block text-xs text-muted mt-0.5 leading-relaxed">{s.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="BI 看板"
            hint="关联后，进入该 Agent 右侧默认显示这块看板（读缓存，秒开），用户可在看板上下钻或点击问 AI。看板与查询在「BI 看板管理」里维护。"
          >
            <Select value={editing.dashboardKey || ''} onChange={(e) => patch({ dashboardKey: e.target.value })}>
              <option value="">不关联（保持原有画布）</option>
              {availableDashboards.map((d) => (
                <option key={d.dashboardKey} value={d.dashboardKey}>
                  {d.label}（{d.dashboardKey}）{d.enabled ? '' : ' · 已停用'}
                </option>
              ))}
              {editing.dashboardKey && !availableDashboards.some((d) => d.dashboardKey === editing.dashboardKey) && (
                <option value={editing.dashboardKey}>{editing.dashboardKey}（不存在）</option>
              )}
            </Select>
          </Section>

          <Section
            title="默认内容"
            hint="开启后，进入该 Agent 会自动执行一次默认分析。已关联看板时不执行，以看板为准。"
          >
            <div className="flex flex-col gap-3">
              <Checkbox
                label="进入时自动执行默认分析"
                checked={!!editing.defaultEnabled}
                onChange={(e) => patch({ defaultEnabled: e.target.checked })}
              />
              <Field label="默认分析指令">
                <Textarea
                  rows={2}
                  value={editing.defaultPrompt || ''}
                  onChange={(e) => patch({ defaultPrompt: e.target.value })}
                  placeholder="生成今日销售日报，包含核心指标与各区域分布"
                />
              </Field>
              <Field label="结果缓存（秒）" hint="0 = 每次进入都重新查询；300 = 5 分钟内复用上次结果，避免频繁跑 SQL">
                <Input
                  type="number"
                  value={editing.defaultCacheSecs ?? 300}
                  onChange={(e) => patch({ defaultCacheSecs: Number(e.target.value) })}
                />
              </Field>
            </div>
          </Section>

          <Section title="展示与权限">
            <div className="flex flex-col gap-3">
              <Field label="布局模式">
                <Select value={editing.layoutMode} onChange={(e) => patch({ layoutMode: e.target.value as 'canvas' | 'chat' })}>
                  <option value="canvas">画布式（对话 + 图表/指标画布）</option>
                  <option value="chat">纯聊天（仅文字对话）</option>
                </Select>
              </Field>
              <Field label="可见角色" hint="不勾选 = 仅管理员可见；管理员始终可见全部 Agent">
                <ChipSelect
                  options={availableRoles.map((r) => ({ value: r, label: r }))}
                  selected={editing.roles}
                  onChange={(roles) => patch({ roles })}
                  empty="暂无自定义角色"
                />
              </Field>
            </div>
          </Section>
        </div>
      </div>

      <EditorActions onCancel={() => setEditing(null)} onSave={() => void handleSave()} saving={saving} />
    </AdminPage>
  )
}
