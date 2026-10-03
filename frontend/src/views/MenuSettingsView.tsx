import { useState, useEffect, useCallback, useMemo } from 'react'
import { FileText, LayoutGrid, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport } from '../utils/api'
import type { AppRole } from '../types'
import {
  RoleCheckboxGroup,
  RolesDefinitionPanel,
  UserRolesPanel,
} from '../components/RoleSettingsPanels'
import { useAppRoles, fetchAppRoles } from '../hooks/useAppRoles'
import AiGenerateDialog from '../components/AiGenerateDialog'
import { AdminPage, Badge, Button, Card, Checkbox, Code, EditorActions, EmptyState, Field, Input, JsonField, Notice, RecordRow, Section, Segmented, Select, Skeleton, Tabs, Textarea } from '../ui'
import { confirmDelete } from '../ui/confirm'
import { parseJsonField } from '../utils/bi'

interface MenuItemData {
  id: number
  label: string
  routeKey: string
  icon: string
  sortOrder: number
  enabled: boolean
  roles: string[]
  menuKind: 'builtin' | 'report'
  queryTemplate: string
  filterSchema: any[]
  columnLabels: Record<string, string>
  columnNameMapping: Record<string, string>
  detailQueryTemplate: string
  detailKeyColumn: string
  detailKeyParam: string
  detailKeyType: string
  aiPrompt: string
  voiceActions?: any[]
}

const RESERVED_ROUTES = ['orders', 'menu-settings']
const DETAIL_KEY_TYPES = ['string', 'int', 'decimal', 'date', 'datetime', 'bool']

function normalizePromptText(s: string): string {
  if (!s) return s
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

interface MenuEditFormState {
  label: string
  routeKey: string
  icon: string
  sortOrder: number
  enabled: boolean
  selectedRoles: string[]
  menuKind: 'builtin' | 'report'
  queryTemplate: string
  filterSchema: string
  columnLabels: string
  columnNameMapping: string
  detailQueryTemplate: string
  aiPrompt: string
  voiceActions: string
  detailKeyColumn: string
  detailKeyParam: string
  detailKeyType: string
}

function itemToFormState(item: MenuItemData): MenuEditFormState {
  return {
    label: item.label,
    routeKey: item.routeKey,
    icon: item.icon || '',
    sortOrder: item.sortOrder,
    enabled: item.enabled !== false,
    selectedRoles: (item.roles || []).length > 0 ? [...item.roles] : ['operator'],
    menuKind: item.menuKind || 'builtin',
    queryTemplate: item.queryTemplate || '',
    filterSchema: JSON.stringify(item.filterSchema || [], null, 2),
    columnLabels: JSON.stringify(item.columnLabels || {}, null, 2),
    columnNameMapping: JSON.stringify(item.columnNameMapping || {}, null, 2),
    detailQueryTemplate: item.detailQueryTemplate || '',
    aiPrompt: item.aiPrompt || '',
    voiceActions: JSON.stringify(item.voiceActions || [], null, 2),
    detailKeyColumn: item.detailKeyColumn || '',
    detailKeyParam: item.detailKeyParam || 'detailKey',
    detailKeyType: item.detailKeyType || 'string',
  }
}

const emptyFormState: MenuEditFormState = {
  label: '',
  routeKey: '',
  icon: '',
  sortOrder: 100,
  enabled: true,
  selectedRoles: ['operator'],
  menuKind: 'builtin',
  queryTemplate: '',
  filterSchema: '[]',
  columnLabels: '{}',
  columnNameMapping: '{}',
  detailQueryTemplate: '',
  aiPrompt: '',
  voiceActions: '[]',
  detailKeyColumn: '',
  detailKeyParam: 'detailKey',
  detailKeyType: 'string',
}

const AI_PROMPT_EXAMPLE =
  '这个报表主要用于采购订单的到期情况，需要体现出正常和超期到货的情况，' +
  '用预计到货日期[DocDueDate]和今天的对比分析，总共查询了多少条目，超期有多少条目，' +
  '给出具体数据，并给出风险结论和建议。'

const VOICE_ACTIONS_PLACEHOLDER =
  '[\n  {\n    "patterns": ["{n}号订单", "订单{n}", "单号{n}"],\n    "fill": { "DocEntry": "{n}" },\n    "autoQuery": true\n  }\n]'

type SaveBody = Record<string, unknown>

/** 表单 → 提交体；JSON 字段解析失败返回错误文案。与原有新增/编辑逻辑一致。 */
function formToBody(form: MenuEditFormState, isReserved: boolean): { ok: true; value: SaveBody } | { ok: false; error: string } {
  const mk = isReserved ? 'builtin' : form.menuKind
  let filterSchema: unknown[] = []
  let columnLabels: Record<string, string> = {}
  let columnNameMapping: Record<string, string> = {}
  if (!isReserved) {
    const fs = parseJsonField<unknown[]>(form.filterSchema, '查询条件', 'array')
    if (!fs.ok) return fs
    filterSchema = fs.value
    if (mk === 'report') {
      const cl = parseJsonField<Record<string, string>>(form.columnLabels, '列标题映射', 'object')
      if (!cl.ok) return cl
      columnLabels = cl.value
      const cm = parseJsonField<Record<string, string>>(form.columnNameMapping, '列名映射', 'object')
      if (!cm.ok) return cm
      columnNameMapping = cm.value
    }
  }
  const va = parseJsonField<unknown[]>(form.voiceActions, '语音动作', 'array')
  if (!va.ok) return va

  const isReport = !isReserved && mk === 'report'
  return {
    ok: true,
    value: {
      label: form.label.trim(),
      routeKey: form.routeKey.trim().toLowerCase(),
      icon: form.icon.trim(),
      sortOrder: parseInt(String(form.sortOrder), 10),
      enabled: form.enabled,
      roles: [...form.selectedRoles],
      menuKind: mk,
      queryTemplate: isReserved ? '' : form.queryTemplate.trim(),
      filterSchema,
      columnLabels,
      columnNameMapping,
      aiPrompt: form.aiPrompt.trim(),
      voiceActions: va.value,
      detailQueryTemplate: isReport ? form.detailQueryTemplate.trim() : '',
      detailKeyColumn: isReport ? form.detailKeyColumn.trim() : '',
      detailKeyParam: isReport ? form.detailKeyParam.trim() || 'detailKey' : 'detailKey',
      detailKeyType: isReport ? form.detailKeyType : 'string',
    },
  }
}

/** 新增与编辑共用的菜单表单 */
function MenuEditor({
  item,
  isAdmin,
  appRoles,
  onSaved,
  onDeleted,
  onCancel,
}: {
  /** null = 新增 */
  item: MenuItemData | null
  isAdmin: boolean
  appRoles: AppRole[]
  onSaved: () => void
  onDeleted: () => void
  onCancel: () => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [form, setForm] = useState<MenuEditFormState>(() => (item ? itemToFormState(item) : { ...emptyFormState }))
  const [saving, setSaving] = useState(false)
  const [showAIDialog, setShowAIDialog] = useState(false)
  const [error, setError] = useState('')

  const isNew = item == null
  const isReserved = !!item && RESERVED_ROUTES.includes(item.routeKey)
  const isReport = !isReserved && form.menuKind === 'report'

  const update = (patch: Partial<MenuEditFormState>) => setForm((prev) => ({ ...prev, ...patch }))

  const handleSave = async () => {
    setError('')
    if (!form.label.trim() || !form.routeKey.trim()) {
      setError('请填写名称和路由标识')
      return
    }
    const body = formToBody(form, isReserved)
    if (!body.ok) {
      setError(body.error)
      return
    }
    setSaving(true)
    try {
      await apiFetch(isNew ? '/admin/menus' : `/admin/menus/${item.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        body: JSON.stringify(body.value),
      })
      showToast(isNew ? '已添加' : '已保存')
      onSaved()
    } catch (e: any) {
      setError(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!item) return
    if (!(await confirmDelete(`菜单「${item.label}」`))) return
    try {
      await apiFetch(`/admin/menus/${item.id}`, { method: 'DELETE' })
      showToast('已删除')
      onDeleted()
    } catch (e: any) {
      showToast(e.message || '删除失败')
    }
  }

  const handleAIGenerate = async (description: string) => {
    setShowAIDialog(false)
    showToast('AI 正在生成 Prompt 模板…（约需数十秒）', 95000)
    try {
      const data = await apiFetchReport(
        '/ai/generate-prompt',
        {
          method: 'POST',
          body: JSON.stringify({ description, reportType: form.label || '通用报表' }),
        },
        120000,
      )
      if (data.success && data.prompt) {
        update({ aiPrompt: normalizePromptText(data.prompt) })
        showToast('AI Prompt 已生成并填入，检查后保存即可')
      } else {
        showToast('生成失败：' + (data.error || '未知错误'))
      }
    } catch (e: any) {
      const hint = e.name === 'AbortError' || /aborted|超时|timeout/i.test(e.message || '')
        ? '请求超时（120s）或已中断，请检查网络与 AI 服务后重试'
        : e.message || '网络错误'
      showToast('AI 生成 Prompt 失败：' + hint)
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-20">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold text-fg truncate">
            {isNew ? '新增菜单' : form.label || item.routeKey}
          </h3>
          {!isNew && (
            <p className="text-xs text-muted mt-0.5">
              #{item.id} · <Code>{item.routeKey}</Code>
            </p>
          )}
        </div>
        {!isNew && (
          <Button variant="ghost" size="sm" className="text-danger" icon={<Trash2 className="w-4 h-4" />} onClick={() => void handleDelete()}>
            删除菜单
          </Button>
        )}
      </div>

      {isReserved && <Notice tone="info">系统保留菜单：不能改类型，也没有报表 SQL、AI、语音配置。</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}

      <Section title="基本信息">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="名称">
            <Input value={form.label} maxLength={128} onChange={(e) => update({ label: e.target.value })} />
          </Field>
          <Field label="路由标识" hint="地址为 /report/路由标识">
            <Input className="font-mono" value={form.routeKey} maxLength={64} onChange={(e) => update({ routeKey: e.target.value })} />
          </Field>
          <Field label="图标">
            <Input value={form.icon} maxLength={32} onChange={(e) => update({ icon: e.target.value })} />
          </Field>
          <Field label="排序">
            <Input type="number" value={form.sortOrder} onChange={(e) => update({ sortOrder: parseInt(e.target.value, 10) || 0 })} />
          </Field>
          <Field label="菜单类型" className="sm:col-span-2">
            <Segmented
              value={isReserved ? 'builtin' : form.menuKind}
              onChange={(v) => !isReserved && update({ menuKind: v })}
              options={[
                { value: 'report', label: '可配置报表（SQL）' },
                { value: 'builtin', label: '内置页面' },
              ]}
            />
          </Field>
          <div className="sm:col-span-2 flex items-end pb-2">
            <Checkbox label="启用" checked={form.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          </div>
          <Field label="可见角色" className="sm:col-span-2 xl:col-span-4">
            <RoleCheckboxGroup appRoles={appRoles} selected={form.selectedRoles} onChange={(selectedRoles) => update({ selectedRoles })} />
          </Field>
        </div>
      </Section>

      {isReport && (
        <>
          <Section title="报表查询" hint="SQL 支持 GO 分隔多条；筛选字段在「查询条件」中定义，SQL 里以 @name 引用。">
            <div className="flex flex-col gap-3">
              <Field label="SQL 模板">
                <Textarea mono rows={14} spellCheck={false} value={form.queryTemplate} onChange={(e) => update({ queryTemplate: e.target.value })} />
              </Field>
              <JsonField
                label="查询条件"
                hint="JSON 数组（filter_schema）"
                expect="array"
                rows={8}
                value={form.filterSchema}
                onChange={(v) => update({ filterSchema: v })}
              />
              <div className="grid gap-3 lg:grid-cols-2">
                <JsonField
                  label="列标题映射（可选）"
                  hint="表头用：键为列名（映射后优先）。未配置列名映射时须与 SQL 原列名一致。"
                  expect="object"
                  rows={6}
                  value={form.columnLabels}
                  onChange={(v) => update({ columnLabels: v })}
                />
                <JsonField
                  label="列名映射（可选）"
                  hint="逻辑列名 → SQL 列名"
                  expect="object"
                  rows={6}
                  value={form.columnNameMapping}
                  placeholder='{"DocEntry":"order_id","StepCode":"OpId"}'
                  onChange={(v) => update({ columnNameMapping: v })}
                />
              </div>
            </div>
          </Section>

          <Section title="行详情（可选）" hint="留空 SQL 表示不启用行点击查看详情；SQL 须含主键参数（默认 @detailKey）。">
            <div className="flex flex-col gap-3">
              <Field label="行详情 SQL">
                <Textarea mono rows={6} spellCheck={false} value={form.detailQueryTemplate} onChange={(e) => update({ detailQueryTemplate: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="行主键列名" hint="与列表结果列名一致">
                  <Input value={form.detailKeyColumn} maxLength={256} onChange={(e) => update({ detailKeyColumn: e.target.value })} />
                </Field>
                <Field label="详情 SQL 主键参数名">
                  <Input value={form.detailKeyParam} maxLength={128} onChange={(e) => update({ detailKeyParam: e.target.value })} />
                </Field>
                <Field label="行主键类型">
                  <Select value={form.detailKeyType} onChange={(e) => update({ detailKeyType: e.target.value })}>
                    {DETAIL_KEY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          </Section>

          <Section
            title="AI 分析 Prompt（可选）"
            hint="占位符：{report_label}、{filters}、{metrics}、{data_sample}、{columns}、{context}"
            actions={
              isAdmin && (
                <Button size="sm" variant="soft" icon={<Sparkles className="w-3.5 h-3.5" />} onClick={() => setShowAIDialog(true)}>
                  AI 生成 Prompt
                </Button>
              )
            }
          >
            <Textarea rows={10} value={form.aiPrompt} placeholder="AI 分析 Prompt 模板" onChange={(e) => update({ aiPrompt: e.target.value })} />
          </Section>
        </>
      )}

      {!isReserved && (
        <Section title="语音动作（可选）" hint="配置语音可带参数操作本菜单。占位符：{n}=数字 {t}=文本 {d}=日期；fill 的键为查询条件的 name。">
          <JsonField
            label="动作模板（JSON 数组）"
            expect="array"
            rows={7}
            value={form.voiceActions}
            placeholder={VOICE_ACTIONS_PLACEHOLDER}
            onChange={(v) => update({ voiceActions: v })}
          />
        </Section>
      )}

      <EditorActions onCancel={onCancel} onSave={() => void handleSave()} saving={saving} saveLabel={isNew ? '添加菜单' : '保存'} />

      <AiGenerateDialog
        open={showAIDialog}
        title="AI 生成分析 Prompt"
        label={form.label ? `报表「${form.label}」的业务描述（越详细越好）` : '报表业务描述（越详细越好）'}
        example={AI_PROMPT_EXAMPLE}
        placeholder="请描述这个报表的业务场景和分析需求…"
        onConfirm={(v) => void handleAIGenerate(v)}
        onClose={() => setShowAIDialog(false)}
      />
    </div>
  )
}

type KindFilter = 'all' | 'report' | 'builtin'

function MenuManager({ isAdmin, appRoles }: { isAdmin: boolean; appRoles: AppRole[] }) {
  const showToast = useStore((s) => s.showToast)
  const fetchMenus = useStore((s) => s.fetchMenus)
  const [items, setItems] = useState<MenuItemData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** null = 未选中；'new' = 新增 */
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')

  const loadMenus = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/admin/menus')
      setItems(data.items || [])
    } catch (e: any) {
      setError(e.message || '加载失败')
      if (e.status === 403) showToast('需要管理员权限')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadMenus()
  }, [loadMenus])

  const refresh = async () => {
    await fetchMenus()
    await loadMenus()
  }

  const roleLabel = useMemo(() => new Map(appRoles.map((r) => [r.roleKey, r.label])), [appRoles])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .filter((m) => kind === 'all' || (m.menuKind || 'builtin') === kind)
      .filter((m) => !q || m.label.toLowerCase().includes(q) || m.routeKey.toLowerCase().includes(q))
  }, [items, search, kind])

  const current = typeof selected === 'number' ? items.find((m) => m.id === selected) ?? null : null
  const editing = selected === 'new' || current != null

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)] items-start">
      <Card className={`overflow-hidden lg:sticky lg:top-20 ${editing ? 'hidden lg:block' : ''}`}>
        <div className="p-3 border-b border-line flex flex-col gap-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input className="pl-8" value={search} placeholder="搜索名称或路由" onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => setSelected('new')}>
              新增
            </Button>
          </div>
          <Segmented
            size="sm"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: `全部 ${items.length}` },
              { value: 'report', label: '报表' },
              { value: 'builtin', label: '内置' },
            ]}
          />
        </div>
        <div className="lg:max-h-[calc(100vh-15rem)] overflow-y-auto">
          {loading && <Skeleton className="h-32 m-3" />}
          {error && <Notice tone="danger" className="m-3">{error}</Notice>}
          {!loading && !error && filtered.length === 0 && (
            <EmptyState title={items.length ? '没有匹配的菜单' : '暂无菜单'} />
          )}
          {filtered.map((m) => (
            <RecordRow
              key={m.id}
              active={selected === m.id}
              onClick={() => setSelected(m.id)}
              title={m.label}
              badges={
                <>
                  {m.menuKind === 'report' ? (
                    <Badge tone="primary">
                      <FileText className="w-3 h-3" />
                      报表
                    </Badge>
                  ) : (
                    <Badge>
                      <LayoutGrid className="w-3 h-3" />
                      内置
                    </Badge>
                  )}
                  {!m.enabled && <Badge tone="warning">停用</Badge>}
                </>
              }
              meta={
                <span className="truncate">
                  <span className="font-mono">{m.routeKey}</span>
                  <span className="mx-1.5 text-subtle">·</span>
                  {(m.roles || []).map((r) => roleLabel.get(r) || r).join('、') || '—'}
                </span>
              }
            />
          ))}
        </div>
      </Card>

      <div className={editing ? '' : 'hidden lg:block'}>
        {editing ? (
          <MenuEditor
            key={selected === 'new' ? 'new' : current!.id}
            item={current}
            isAdmin={isAdmin}
            appRoles={appRoles}
            onCancel={() => setSelected(null)}
            onSaved={async () => {
              if (selected === 'new') setSelected(null)
              await refresh()
            }}
            onDeleted={async () => {
              setSelected(null)
              await refresh()
            }}
          />
        ) : (
          <Card>
            <EmptyState title="选择左侧菜单进行编辑" description="或点「新增」创建一个报表菜单" />
          </Card>
        )}
      </div>
    </div>
  )
}

export default function MenuSettingsView() {
  const showToast = useStore((s) => s.showToast)
  const user = useStore((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const { appRoles, loading: rolesLoading, reloadAppRoles } = useAppRoles()
  const [roleDefItems, setRoleDefItems] = useState<AppRole[]>([])
  const [tab, setTab] = useState<'menus' | 'roles' | 'users'>('menus')

  const loadRoleDefs = useCallback(async () => {
    try {
      setRoleDefItems(await fetchAppRoles())
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载角色失败')
    }
  }, [showToast])

  useEffect(() => {
    void reloadAppRoles()
  }, [reloadAppRoles])

  useEffect(() => {
    if (tab === 'roles') void loadRoleDefs()
  }, [tab, loadRoleDefs])

  return (
    <AdminPage title="菜单与角色" description="菜单配置（含报表 SQL）、岗位角色定义与用户角色分配">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'menus', label: '菜单项' },
          { value: 'roles', label: '角色定义' },
          { value: 'users', label: '用户角色' },
        ]}
      />

      {tab === 'menus' && <MenuManager isAdmin={isAdmin} appRoles={appRoles} />}
      {tab === 'roles' && (
        <RolesDefinitionPanel
          items={roleDefItems}
          loading={rolesLoading}
          onReload={async () => {
            await loadRoleDefs()
            await reloadAppRoles()
          }}
        />
      )}
      {tab === 'users' && <UserRolesPanel appRoles={appRoles} />}
    </AdminPage>
  )
}
