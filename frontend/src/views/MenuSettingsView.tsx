import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport } from '../utils/api'
import type { AppRole } from '../types'
import {
  RoleCheckboxGroup,
  RolesDefinitionPanel,
  UserRolesPanel,
} from '../components/RoleSettingsPanels'
import { useAppRoles, fetchAppRoles } from '../hooks/useAppRoles'

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

function AIPromptDialog({
  reportLabel,
  onConfirm,
  onClose,
}: {
  reportLabel: string
  onConfirm: (description: string) => void
  onClose: () => void
}) {
  const [description, setDescription] = useState('')

  const exampleText =
    '这个报表主要用于采购订单的到期情况，需要体现出正常和超期到货的情况，' +
    '用预计到货日期[DocDueDate]和今天的对比分析，总共查询了多少条目，超期有多少条目，' +
    '给出具体数据，并给出风险结论和建议。'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[90%] max-w-lg p-5">
        <p className="font-semibold text-slate-800 mb-3">
          请输入报表业务描述（越详细越好）：
        </p>
        <div className="text-xs text-slate-500 mb-1">示例：</div>
        <div className="text-xs text-slate-600 bg-slate-50 rounded p-2 mb-3 leading-relaxed">
          {exampleText}
        </div>
        <label className="block text-sm text-slate-700 mb-1">
          {reportLabel ? `报表「${reportLabel}」的业务描述` : '业务描述'}
        </label>
        <textarea
          className="w-full border border-slate-300 rounded-lg p-2 text-sm min-h-[100px] focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
          placeholder="请描述这个报表的业务场景和分析需求…"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-lg bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50"
            disabled={!description.trim()}
            onClick={() => onConfirm(description.trim())}
          >
            生成
          </button>
        </div>
      </div>
    </div>
  )
}

function MenuEditCard({
  item,
  isAdmin,
  appRoles,
  onSaved,
  onDeleted,
}: {
  item: MenuItemData
  isAdmin: boolean
  appRoles: AppRole[]
  onSaved: () => void
  onDeleted: () => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [form, setForm] = useState<MenuEditFormState>(() => itemToFormState(item))
  const [saving, setSaving] = useState(false)
  const [showAIDialog, setShowAIDialog] = useState(false)

  const isReserved = RESERVED_ROUTES.includes(item.routeKey)

  useEffect(() => {
    setForm(itemToFormState(item))
  }, [item])

  const update = (patch: Partial<MenuEditFormState>) =>
    setForm((prev) => ({ ...prev, ...patch }))

  const handleSave = async () => {
    const roles = [...form.selectedRoles]

    const mk = isReserved ? 'builtin' : form.menuKind
    const qtpl = isReserved ? '' : form.queryTemplate.trim()

    let fsParsed: any[] = []
    let columnLabelsParsed: Record<string, string> = {}
    let columnNameMappingParsed: Record<string, string> = {}

    if (!isReserved) {
      try {
        fsParsed = form.filterSchema.trim() ? JSON.parse(form.filterSchema) : []
      } catch {
        showToast('查询条件 JSON 格式错误')
        return
      }
      if (mk === 'report') {
        try {
          columnLabelsParsed = form.columnLabels.trim()
            ? JSON.parse(form.columnLabels)
            : {}
        } catch {
          showToast('列标题映射 JSON 格式错误')
          return
        }
        try {
          columnNameMappingParsed = form.columnNameMapping.trim()
            ? JSON.parse(form.columnNameMapping)
            : {}
        } catch {
          showToast('列名映射 JSON 格式错误')
          return
        }
      }
    }

    const detailBody = {
      detailQueryTemplate: '',
      detailKeyColumn: '',
      detailKeyParam: 'detailKey',
      detailKeyType: 'string',
    }
    if (!isReserved && mk === 'report') {
      detailBody.detailQueryTemplate = form.detailQueryTemplate.trim()
      detailBody.detailKeyColumn = form.detailKeyColumn.trim()
      detailBody.detailKeyParam = form.detailKeyParam.trim() || 'detailKey'
      detailBody.detailKeyType = form.detailKeyType
    }

    let voiceActionsParsed: any[] = []
    if (form.voiceActions.trim()) {
      try {
        voiceActionsParsed = JSON.parse(form.voiceActions)
        if (!Array.isArray(voiceActionsParsed)) {
          showToast('语音动作必须是 JSON 数组')
          return
        }
      } catch {
        showToast('语音动作 JSON 格式错误')
        return
      }
    }

    setSaving(true)
    try {
      await apiFetch(`/admin/menus/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: form.label.trim(),
          routeKey: form.routeKey.trim().toLowerCase(),
          icon: form.icon.trim(),
          sortOrder: parseInt(String(form.sortOrder), 10),
          enabled: form.enabled,
          roles,
          menuKind: mk,
          queryTemplate: qtpl,
          filterSchema: fsParsed,
          columnLabels: columnLabelsParsed,
          columnNameMapping: !isReserved && mk === 'report' ? columnNameMappingParsed : {},
          aiPrompt: form.aiPrompt.trim(),
          voiceActions: voiceActionsParsed,
          ...detailBody,
        }),
      })
      showToast('已保存')
      onSaved()
    } catch (e: any) {
      showToast(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('确定删除该菜单？')) return
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
    showToast('🤖 AI 正在生成专业的 Prompt 模板…（约需数十秒）', 95000)
    try {
      const data = await apiFetchReport(
        '/ai/generate-prompt',
        {
          method: 'POST',
          body: JSON.stringify({
            description,
            reportType: item.label || '通用报表',
          }),
        },
        120000,
      )
      if (data.success && data.prompt) {
        update({ aiPrompt: normalizePromptText(data.prompt) })
        showToast('✅ AI Prompt 生成成功！已自动填入，可直接保存。')
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

  const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none disabled:bg-slate-100 disabled:text-slate-400'
  const labelCls = 'block text-sm font-medium text-slate-600 mb-1'

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
      <h3 className="font-semibold text-slate-700">菜单 #{item.id}</h3>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>名称</span>
          <input className={inputCls} value={form.label} maxLength={128}
            onChange={(e) => update({ label: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>路由标识</span>
          <input className={inputCls} value={form.routeKey} maxLength={64}
            onChange={(e) => update({ routeKey: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>图标</span>
          <input className={inputCls} value={form.icon} maxLength={32}
            onChange={(e) => update({ icon: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>排序</span>
          <input className={inputCls} type="number" value={form.sortOrder}
            onChange={(e) => update({ sortOrder: parseInt(e.target.value, 10) || 0 })} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" className="rounded" checked={form.enabled}
          onChange={(e) => update({ enabled: e.target.checked })} />
        启用
      </label>

      <div className="space-y-1">
        <span className={labelCls}>可见角色</span>
        <RoleCheckboxGroup
          appRoles={appRoles}
          selected={form.selectedRoles}
          onChange={(selectedRoles) => update({ selectedRoles })}
        />
      </div>

      <label className="block">
        <span className={labelCls}>菜单类型</span>
        <select className={inputCls} value={form.menuKind} disabled={isReserved}
          onChange={(e) => update({ menuKind: e.target.value as 'builtin' | 'report' })}>
          <option value="builtin">内置页面</option>
          <option value="report">可配置报表（SQL）</option>
        </select>
      </label>

      <label className="block">
        <span className={labelCls}>SQL 模板</span>
        <textarea className={inputCls + ' min-h-[80px]'} rows={4}
          value={form.queryTemplate} disabled={isReserved}
          onChange={(e) => update({ queryTemplate: e.target.value })} />
      </label>

      <label className="block">
        <span className={labelCls}>查询条件 JSON</span>
        <textarea className={inputCls + ' min-h-[80px] font-mono text-xs'} rows={4}
          value={form.filterSchema} disabled={isReserved}
          onChange={(e) => update({ filterSchema: e.target.value })} />
      </label>

      <label className="block">
        <span className={labelCls}>列标题映射 JSON（可选）</span>
        <textarea className={inputCls + ' min-h-[60px] font-mono text-xs'} rows={3}
          value={form.columnLabels} disabled={isReserved}
          placeholder="表头用：键为列名（映射后优先）。未配置列名映射时须与 SQL 原列名一致。"
          onChange={(e) => update({ columnLabels: e.target.value })} />
      </label>

      <label className="block">
        <span className={labelCls}>列名映射 JSON（可选）</span>
        <textarea className={inputCls + ' min-h-[60px] font-mono text-xs'} rows={3}
          value={form.columnNameMapping} disabled={isReserved}
          placeholder='逻辑列名 -> SQL 列名，例如：{"DocEntry":"order_id","StepCode":"OpId"}'
          onChange={(e) => update({ columnNameMapping: e.target.value })} />
      </label>

      <label className="block">
        <span className={labelCls}>行详情 SQL（可选）</span>
        <textarea className={inputCls + ' min-h-[60px]'} rows={3}
          value={form.detailQueryTemplate} disabled={isReserved}
          placeholder="留空表示不启用行点击查看详情；SQL 须含主键参数（默认 @detailKey）"
          onChange={(e) => update({ detailQueryTemplate: e.target.value })} />
      </label>

      <label className="block">
        <span className={labelCls}>AI 分析 Prompt（可选）</span>
        <textarea
          id={`menu-ai-prompt-${item.id}`}
          className={inputCls + ' min-h-[100px]'} rows={6}
          value={form.aiPrompt} disabled={isReserved}
          placeholder={'AI 分析 Prompt 模板（支持占位符：{report_label}、{filters}、{metrics}、{data_sample}）\n\n推荐直接复制 migrate-nav-menu-ai-prompt.sql 中的示例'}
          onChange={(e) => update({ aiPrompt: e.target.value })}
        />
      </label>

      <label className="block">
        <span className={labelCls}>语音动作模板（可选，JSON 数组）</span>
        <textarea
          className={inputCls + ' min-h-[110px] font-mono text-xs'}
          rows={6}
          value={form.voiceActions}
          disabled={isReserved}
          placeholder={
            '配置语音可带参数操作本菜单。占位符：{n}=数字 {t}=文本 {d}=日期\n例：\n[\n  {\n    "patterns": ["{n}号订单", "订单{n}", "单号{n}"],\n    "fill": { "DocEntry": "{n}" },\n    "autoQuery": true\n  }\n]'
          }
          onChange={(e) => update({ voiceActions: e.target.value })}
        />
      </label>

      {!isReserved && isAdmin && (
        <button
          type="button"
          className="text-sm px-3 py-1.5 rounded-lg border border-sky-300 text-sky-600 hover:bg-sky-50"
          onClick={() => setShowAIDialog(true)}
        >
          🤖 AI 生成 Prompt
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>行主键列名</span>
          <input className={inputCls} value={form.detailKeyColumn} disabled={isReserved}
            maxLength={256} placeholder="与列表结果列名一致"
            onChange={(e) => update({ detailKeyColumn: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>详情 SQL 主键参数名</span>
          <input className={inputCls} value={form.detailKeyParam} disabled={isReserved}
            maxLength={128}
            onChange={(e) => update({ detailKeyParam: e.target.value })} />
        </label>
      </div>

      <label className="block">
        <span className={labelCls}>行主键类型</span>
        <select className={inputCls} value={form.detailKeyType} disabled={isReserved}
          onChange={(e) => update({ detailKeyType: e.target.value })}>
          {DETAIL_KEY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          className="px-4 py-2 text-sm rounded-lg bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="px-4 py-2 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50"
          onClick={handleDelete}
        >
          删除
        </button>
      </div>

      {showAIDialog && (
        <AIPromptDialog
          reportLabel={item.label}
          onConfirm={handleAIGenerate}
          onClose={() => setShowAIDialog(false)}
        />
      )}
    </div>
  )
}

export default function MenuSettingsView() {
  const showToast = useStore((s) => s.showToast)
  const user = useStore((s) => s.user)
  const fetchMenus = useStore((s) => s.fetchMenus)
  const isAdmin = user?.role === 'admin'
  const { appRoles, loading: rolesLoading, reloadAppRoles } = useAppRoles()
  const [roleDefItems, setRoleDefItems] = useState<AppRole[]>([])

  const loadRoleDefs = useCallback(async () => {
    try {
      setRoleDefItems(await fetchAppRoles())
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载角色失败')
    }
  }, [showToast])

  const [tab, setTab] = useState<'menus' | 'roles' | 'users'>('menus')

  const [items, setItems] = useState<MenuItemData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [addForm, setAddForm] = useState<MenuEditFormState>({ ...emptyFormState })
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')

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

  useEffect(() => { loadMenus() }, [loadMenus])

  useEffect(() => {
    void reloadAppRoles()
  }, [reloadAppRoles])

  useEffect(() => {
    if (tab === 'roles') void loadRoleDefs()
  }, [tab, loadRoleDefs])

  const handleRefresh = async () => {
    await fetchMenus()
    await loadMenus()
  }

  const updateAdd = (patch: Partial<MenuEditFormState>) =>
    setAddForm((prev) => ({ ...prev, ...patch }))

  const handleAdd = async () => {
    setAddError('')
    const roles = [...addForm.selectedRoles]

    let filterSchema: any[] = []
    let columnLabels: Record<string, string> = {}
    let columnNameMapping: Record<string, string> = {}

    try {
      filterSchema = addForm.filterSchema.trim() ? JSON.parse(addForm.filterSchema) : []
    } catch {
      setAddError('查询条件 JSON 格式错误')
      return
    }
    try {
      columnLabels = addForm.columnLabels.trim() ? JSON.parse(addForm.columnLabels) : {}
    } catch {
      setAddError('列标题映射 JSON 格式错误')
      return
    }
    try {
      columnNameMapping = addForm.columnNameMapping.trim() ? JSON.parse(addForm.columnNameMapping) : {}
    } catch {
      setAddError('列名映射 JSON 格式错误')
      return
    }

    let voiceActions: any[] = []
    if (addForm.voiceActions.trim()) {
      try {
        voiceActions = JSON.parse(addForm.voiceActions)
        if (!Array.isArray(voiceActions)) {
          setAddError('语音动作必须是 JSON 数组')
          return
        }
      } catch {
        setAddError('语音动作 JSON 格式错误')
        return
      }
    }

    setAdding(true)
    try {
      await apiFetch('/admin/menus', {
        method: 'POST',
        body: JSON.stringify({
          label: addForm.label.trim(),
          routeKey: addForm.routeKey.trim().toLowerCase(),
          icon: addForm.icon.trim(),
          sortOrder: parseInt(String(addForm.sortOrder), 10),
          enabled: addForm.enabled,
          roles,
          menuKind: addForm.menuKind,
          queryTemplate: addForm.queryTemplate.trim(),
          filterSchema,
          columnLabels,
          columnNameMapping,
          detailQueryTemplate: addForm.detailQueryTemplate.trim(),
          detailKeyColumn: addForm.detailKeyColumn.trim(),
          detailKeyParam: addForm.detailKeyParam.trim() || 'detailKey',
          detailKeyType: addForm.detailKeyType,
          aiPrompt: addForm.aiPrompt.trim(),
          voiceActions,
        }),
      })
      showToast('已添加')
      setAddForm({ ...emptyFormState })
      await handleRefresh()
    } catch (e: any) {
      setAddError(e.message || '添加失败')
    } finally {
      setAdding(false)
    }
  }

  const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none'
  const labelCls = 'block text-sm font-medium text-slate-600 mb-1'

  return (
    <div className="p-4 pb-24 max-w-3xl mx-auto">
      <h2 className="text-xl font-semibold text-slate-800 mb-4">菜单与权限</h2>

      <div className="flex gap-2 mb-6 border-b border-slate-200">
        {([
          ['menus', '菜单项'],
          ['roles', '角色定义'],
          ['users', '用户角色'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-sky-500 text-sky-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

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

      {tab === 'menus' && (
        <>
      {loading && <p className="text-slate-400 text-center py-8">加载中…</p>}
      {error && <p className="text-red-500 text-center py-4">{error}</p>}

      <div className="space-y-4">
        {items.map((item) => (
          <MenuEditCard
            key={item.id}
            item={item}
            isAdmin={isAdmin}
            appRoles={appRoles}
            onSaved={handleRefresh}
            onDeleted={handleRefresh}
          />
        ))}

        {!loading && items.length === 0 && !error && (
          <p className="text-slate-400 text-center py-8">暂无菜单，请在下方添加</p>
        )}
      </div>

      {/* Add menu form */}
      <div className="mt-8 bg-white rounded-xl border border-dashed border-sky-300 shadow-sm p-4 space-y-3">
        <h3 className="font-semibold text-sky-700">添加新菜单</h3>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>名称</span>
            <input className={inputCls} value={addForm.label} maxLength={128}
              onChange={(e) => updateAdd({ label: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>路由标识</span>
            <input className={inputCls} value={addForm.routeKey} maxLength={64}
              onChange={(e) => updateAdd({ routeKey: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>图标</span>
            <input className={inputCls} value={addForm.icon} maxLength={32}
              onChange={(e) => updateAdd({ icon: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>排序</span>
            <input className={inputCls} type="number" value={addForm.sortOrder}
              onChange={(e) => updateAdd({ sortOrder: parseInt(e.target.value, 10) || 0 })} />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="rounded" checked={addForm.enabled}
            onChange={(e) => updateAdd({ enabled: e.target.checked })} />
          启用
        </label>

        <div className="space-y-1">
          <span className={labelCls}>可见角色</span>
          <RoleCheckboxGroup
            appRoles={appRoles}
            selected={addForm.selectedRoles}
            onChange={(selectedRoles) => updateAdd({ selectedRoles })}
          />
        </div>

        <label className="block">
          <span className={labelCls}>菜单类型</span>
          <select className={inputCls} value={addForm.menuKind}
            onChange={(e) => updateAdd({ menuKind: e.target.value as 'builtin' | 'report' })}>
            <option value="builtin">内置页面</option>
            <option value="report">可配置报表（SQL）</option>
          </select>
        </label>

        <label className="block">
          <span className={labelCls}>SQL 模板</span>
          <textarea className={inputCls + ' min-h-[80px]'} rows={4}
            value={addForm.queryTemplate}
            onChange={(e) => updateAdd({ queryTemplate: e.target.value })} />
        </label>

        <label className="block">
          <span className={labelCls}>查询条件 JSON</span>
          <textarea className={inputCls + ' min-h-[80px] font-mono text-xs'} rows={4}
            value={addForm.filterSchema}
            onChange={(e) => updateAdd({ filterSchema: e.target.value })} />
        </label>

        <label className="block">
          <span className={labelCls}>列标题映射 JSON（可选）</span>
          <textarea className={inputCls + ' min-h-[60px] font-mono text-xs'} rows={3}
            value={addForm.columnLabels}
            placeholder="表头用：键为列名（映射后优先）。"
            onChange={(e) => updateAdd({ columnLabels: e.target.value })} />
        </label>

        <label className="block">
          <span className={labelCls}>列名映射 JSON（可选）</span>
          <textarea className={inputCls + ' min-h-[60px] font-mono text-xs'} rows={3}
            value={addForm.columnNameMapping}
            placeholder='逻辑列名 -> SQL 列名'
            onChange={(e) => updateAdd({ columnNameMapping: e.target.value })} />
        </label>

        <label className="block">
          <span className={labelCls}>行详情 SQL（可选）</span>
          <textarea className={inputCls + ' min-h-[60px]'} rows={3}
            value={addForm.detailQueryTemplate}
            placeholder="留空表示不启用行点击查看详情"
            onChange={(e) => updateAdd({ detailQueryTemplate: e.target.value })} />
        </label>

        <label className="block">
          <span className={labelCls}>AI 分析 Prompt（可选）</span>
          <textarea className={inputCls + ' min-h-[80px]'} rows={4}
            value={addForm.aiPrompt}
            placeholder="AI 分析 Prompt 模板"
            onChange={(e) => updateAdd({ aiPrompt: e.target.value })} />
        </label>

        <label className="block">
          <span className={labelCls}>语音动作模板（可选，JSON 数组）</span>
          <textarea
            className={inputCls + ' min-h-[100px] font-mono text-xs'}
            rows={5}
            value={addForm.voiceActions}
            placeholder={
              '占位符 {n}=数字 {t}=文本 {d}=日期；fill 键为 filter_schema 的 name'
            }
            onChange={(e) => updateAdd({ voiceActions: e.target.value })}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>行主键列名</span>
            <input className={inputCls} value={addForm.detailKeyColumn} maxLength={256}
              onChange={(e) => updateAdd({ detailKeyColumn: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>详情 SQL 主键参数名</span>
            <input className={inputCls} value={addForm.detailKeyParam} maxLength={128}
              onChange={(e) => updateAdd({ detailKeyParam: e.target.value })} />
          </label>
        </div>

        <label className="block">
          <span className={labelCls}>行主键类型</span>
          <select className={inputCls} value={addForm.detailKeyType}
            onChange={(e) => updateAdd({ detailKeyType: e.target.value })}>
            {DETAIL_KEY_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        {addError && <p className="text-red-500 text-sm">{addError}</p>}

        <button
          type="button"
          className="w-full py-2.5 text-sm rounded-lg bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50 font-medium"
          disabled={adding}
          onClick={handleAdd}
        >
          {adding ? '添加中…' : '添加菜单'}
        </button>
      </div>
        </>
      )}
    </div>
  )
}
