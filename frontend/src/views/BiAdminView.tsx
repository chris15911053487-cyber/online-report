/**
 * BI 管理（第一期最简版）：查询库 + 看板，两个页签。
 *
 * - 查询库：SQL + 参数（JSON）+ 可下钻维度（JSON）+ 口径 + 缓存 + 可见角色；可用未保存的定义「试运行」
 * - 看板：全局筛选（JSON）+ 卡片（JSON）；卡片只引用 queryKey，保存时由后端校验
 *
 * 看板在「Agent 配置」里选择关联到某个 Agent，进入该 Agent 即显示。
 */
import { useCallback, useEffect, useState } from 'react'
import { Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { parseJsonField, toJsonText, type BiDrillLevel, type BiFilter, type BiParamDef } from '../utils/bi'
import { AdminPage, Badge, Button, Card, Checkbox, ChipSelect, Code, EditorActions, EmptyState, Field, IconButton, Input, JsonField, Notice, RecordRow, ResultTable, Section, Skeleton, Tabs, Textarea } from '../ui'
import { confirmDelete } from '../ui/confirm'

interface BiQueryAdmin {
  queryKey: string
  label: string
  description: string
  sqlText: string
  params: BiParamDef[]
  dimensions: { column: string; label?: string }[]
  caliberNote: string
  cacheSecs: number
  roles: string[]
  enabled: boolean
  updatedAt?: string | null
}

interface BiDashboardAdmin {
  dashboardKey: string
  label: string
  description: string
  filters: BiFilter[]
  cards: { id: string; title: string; queryKey: string; drill?: BiDrillLevel[] }[]
  enabled: boolean
  usedByAgents?: string[]
}

interface QueryOption {
  queryKey: string
  label: string
  enabled: boolean
  dimensions: { column: string; label?: string }[]
  params: BiParamDef[]
}

interface TestResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  durationMs: number
}

/** 编辑表单：JSON 字段以文本编辑，保存时解析 */
interface QueryDraft {
  queryKey: string
  label: string
  description: string
  sqlText: string
  paramsText: string
  dimensionsText: string
  caliberNote: string
  cacheSecs: number
  roles: string[]
  enabled: boolean
}
interface DashboardDraft {
  dashboardKey: string
  label: string
  description: string
  filtersText: string
  cardsText: string
  enabled: boolean
}

const EMPTY_QUERY: QueryDraft = {
  queryKey: '',
  label: '',
  description: '',
  sqlText: '',
  paramsText: '',
  dimensionsText: '',
  caliberNote: '',
  cacheSecs: 300,
  roles: [],
  enabled: true,
}
const EMPTY_DASHBOARD: DashboardDraft = {
  dashboardKey: '',
  label: '',
  description: '',
  filtersText: '',
  cardsText: '',
  enabled: true,
}

const PARAMS_PLACEHOLDER = `[
  { "name": "period", "type": "string", "label": "期间", "required": true }
]`
const DIMENSIONS_PLACEHOLDER = `[
  { "column": "CardCode", "label": "客户编码" },
  { "column": "CardName", "label": "客户" }
]`
const FILTERS_PLACEHOLDER = `[
  { "name": "period", "label": "期间", "type": "month", "default": "$thisMonth" }
]`
const CARDS_PLACEHOLDER = `[
  {
    "id": "ar_total", "type": "kpi", "title": "应收账款",
    "queryKey": "fin_ar_total", "params": { "period": "$filter.period" },
    "encoding": { "value": "Balance", "compare": "PrevBalance", "scale": 10000, "unit": "万" },
    "layout": { "w": 3 }
  },
  {
    "id": "ar_by_customer", "type": "bar", "title": "应收 · 按客户 Top10",
    "queryKey": "fin_ar_by_customer", "params": { "period": "$filter.period" },
    "encoding": { "dimension": "CardName", "value": "Balance", "topN": 10, "horizontal": true },
    "drill": [
      { "queryKey": "fin_ar_docs", "label": "单据", "bind": { "cardCode": "CardCode" },
        "params": { "period": "$filter.period" }, "type": "table" }
    ],
    "layout": { "w": 6, "h": 2 }
  }
]`

function queryToDraft(q: BiQueryAdmin): QueryDraft {
  return {
    queryKey: q.queryKey,
    label: q.label,
    description: q.description || '',
    sqlText: q.sqlText,
    paramsText: toJsonText(q.params),
    dimensionsText: toJsonText(q.dimensions),
    caliberNote: q.caliberNote || '',
    cacheSecs: q.cacheSecs,
    roles: q.roles || [],
    enabled: q.enabled,
  }
}

/** 草稿 → 提交体；JSON 解析失败返回错误文案 */
function draftToQuery(d: QueryDraft): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const params = parseJsonField<unknown[]>(d.paramsText, '参数定义', 'array')
  if (!params.ok) return params
  const dims = parseJsonField<unknown[]>(d.dimensionsText, '可下钻维度', 'array')
  if (!dims.ok) return dims
  return {
    ok: true,
    value: {
      queryKey: d.queryKey.trim(),
      label: d.label.trim(),
      description: d.description,
      sqlText: d.sqlText,
      params: params.value,
      dimensions: dims.value,
      caliberNote: d.caliberNote,
      cacheSecs: Number(d.cacheSecs) || 0,
      roles: d.roles,
      enabled: d.enabled,
    },
  }
}

function dashboardToDraft(d: BiDashboardAdmin): DashboardDraft {
  return {
    dashboardKey: d.dashboardKey,
    label: d.label,
    description: d.description || '',
    filtersText: toJsonText(d.filters),
    cardsText: toJsonText(d.cards),
    enabled: d.enabled,
  }
}

const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

// ═══════════════════════════════ 查询库 ═══════════════════════════════

function QueryEditor({
  initial,
  isNew,
  availableRoles,
  onDone,
}: {
  initial: QueryDraft
  isNew: boolean
  availableRoles: string[]
  onDone: (saved: boolean) => void
}) {
  const { showToast } = useStore()
  const [d, setD] = useState<QueryDraft>(initial)
  const [saving, setSaving] = useState(false)
  const [testParamsText, setTestParamsText] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState('')
  const patch = (p: Partial<QueryDraft>) => setD((cur) => ({ ...cur, ...p }))

  const save = async () => {
    const body = draftToQuery(d)
    if (!body.ok) return showToast(body.error)
    setSaving(true)
    try {
      await apiFetch('/admin/bi/queries', { method: 'POST', body: JSON.stringify(body.value) })
      showToast('已保存')
      onDone(true)
    } catch (err) {
      showToast(errMsg(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    const body = draftToQuery(d)
    if (!body.ok) return setTestError(body.error)
    const params = parseJsonField<Record<string, unknown>>(testParamsText, '试运行参数', 'object')
    if (!params.ok) return setTestError(params.error)
    setTesting(true)
    setTestError('')
    setTestResult(null)
    try {
      const r = (await apiFetch('/admin/bi/queries/test', {
        method: 'POST',
        body: JSON.stringify({ query: body.value, params: params.value }),
      })) as TestResult
      setTestResult(r)
    } catch (err) {
      setTestError(errMsg(err, '试运行失败'))
    } finally {
      setTesting(false)
    }
  }

  return (
    <AdminPage title={isNew ? '新增查询' : `编辑：${d.label || d.queryKey}`} onBack={() => onDone(false)} withActionBar>
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <div className="flex flex-col gap-4">
          <Section title="基本信息">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="查询标识（queryKey）" hint="小写字母开头，仅小写字母/数字/下划线/连字符；创建后不可修改">
                <Input value={d.queryKey} disabled={!isNew} onChange={(e) => patch({ queryKey: e.target.value })} placeholder="fin_ar_by_customer" />
              </Field>
              <Field label="显示名称">
                <Input value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="应收账款 · 按客户" />
              </Field>
              <Field label="说明（这条查询回答什么问题；AI 也会看到）" className="sm:col-span-2">
                <Textarea rows={2} value={d.description} onChange={(e) => patch({ description: e.target.value })} />
              </Field>
              <Field label="口径说明" className="sm:col-span-2">
                <Input value={d.caliberNote} onChange={(e) => patch({ caliberNote: e.target.value })} placeholder="按过账日期，含未清贷项，币种本币" />
              </Field>
            </div>
          </Section>

          <Section title="SQL" hint="只允许一条 SELECT / WITH 只读查询；参数写成 @name，并在「参数定义」中声明。">
            <Textarea mono rows={16} value={d.sqlText} onChange={(e) => patch({ sqlText: e.target.value })} spellCheck={false} />
          </Section>
        </div>

        <div className="flex flex-col gap-4">
          <Section title="参数与维度">
            <div className="flex flex-col gap-3">
              <JsonField
                label="参数定义"
                hint="JSON 数组；type 为 string / number / date / bool"
                expect="array"
                value={d.paramsText}
                onChange={(v) => patch({ paramsText: v })}
                placeholder={PARAMS_PLACEHOLDER}
              />
              <JsonField
                label="可下钻维度"
                hint="结果中可作为维度的列"
                expect="array"
                value={d.dimensionsText}
                onChange={(v) => patch({ dimensionsText: v })}
                placeholder={DIMENSIONS_PLACEHOLDER}
              />
            </div>
          </Section>

          <Section title="缓存与权限">
            <div className="flex flex-col gap-3">
              <Field label="结果缓存（秒）" hint="0 = 不缓存。缓存按「参数 + 用户角色组合」分别保存，不同角色不会共享结果">
                <Input type="number" className="max-w-[12rem]" value={d.cacheSecs} onChange={(e) => patch({ cacheSecs: Number(e.target.value) })} />
              </Field>
              <Field label="可见角色（未勾选 = 仅管理员）">
                <ChipSelect
                  options={availableRoles.map((r) => ({ value: r, label: r }))}
                  selected={d.roles}
                  onChange={(roles) => patch({ roles })}
                  empty="暂无自定义角色"
                />
              </Field>
              <Checkbox label="启用" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            </div>
          </Section>

          <Section title="试运行" hint="用当前表单里的定义执行（无需先保存），最多返回 50 行，不走缓存。">
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <JsonField
                  label="参数"
                  expect="object"
                  rows={2}
                  className="flex-1"
                  value={testParamsText}
                  onChange={setTestParamsText}
                  placeholder='{ "period": "2026-09" }'
                />
                <Button className="mt-6" variant="soft" icon={<Play className="w-3.5 h-3.5" />} onClick={() => void runTest()} disabled={testing}>
                  {testing ? '执行中…' : '试运行'}
                </Button>
              </div>
              {testError && <Notice tone="danger">{testError}</Notice>}
              {testResult && (
                <div>
                  <p className="text-xs text-muted mb-1">
                    {testResult.rowCount} 行{testResult.truncated ? '（已截断）' : ''} · {testResult.durationMs} ms
                  </p>
                  <ResultTable columns={testResult.columns} rows={testResult.rows} />
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>

      <EditorActions onCancel={() => onDone(false)} onSave={() => void save()} saving={saving} />
    </AdminPage>
  )
}

// ═══════════════════════════════ 看板 ═══════════════════════════════

function DashboardEditor({
  initial,
  isNew,
  availableQueries,
  onDone,
}: {
  initial: DashboardDraft
  isNew: boolean
  availableQueries: QueryOption[]
  onDone: (saved: boolean) => void
}) {
  const { showToast } = useStore()
  const [d, setD] = useState<DashboardDraft>(initial)
  const [saving, setSaving] = useState(false)
  const patch = (p: Partial<DashboardDraft>) => setD((cur) => ({ ...cur, ...p }))

  const save = async () => {
    const filters = parseJsonField<unknown[]>(d.filtersText, '全局筛选', 'array')
    if (!filters.ok) return showToast(filters.error)
    const cards = parseJsonField<unknown[]>(d.cardsText, '卡片', 'array')
    if (!cards.ok) return showToast(cards.error)
    setSaving(true)
    try {
      await apiFetch('/admin/bi/dashboards', {
        method: 'POST',
        body: JSON.stringify({
          dashboardKey: d.dashboardKey.trim(),
          label: d.label.trim(),
          description: d.description,
          filters: filters.value,
          cards: cards.value,
          enabled: d.enabled,
        }),
      })
      showToast('已保存')
      onDone(true)
    } catch (err) {
      showToast(errMsg(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AdminPage title={isNew ? '新增看板' : `编辑：${d.label || d.dashboardKey}`} onBack={() => onDone(false)} withActionBar>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
        <div className="flex flex-col gap-4">
          <Section title="基本信息">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="看板标识（dashboardKey）">
                <Input value={d.dashboardKey} disabled={!isNew} onChange={(e) => patch({ dashboardKey: e.target.value })} placeholder="finance" />
              </Field>
              <Field label="显示名称">
                <Input value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="财务经营看板" />
              </Field>
              <Field label="说明" className="sm:col-span-2">
                <Textarea rows={2} value={d.description} onChange={(e) => patch({ description: e.target.value })} />
              </Field>
              <Checkbox label="启用" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            </div>
          </Section>

          <Section
            title="全局筛选"
            hint="type：month / date / string / select。默认值可用 $today $yesterday $thisMonth $lastMonth $monthStart $yearStart。卡片参数里写 $filter.名称 引用。"
          >
            <JsonField label="筛选定义" expect="array" rows={6} value={d.filtersText} onChange={(v) => patch({ filtersText: v })} placeholder={FILTERS_PLACEHOLDER} />
          </Section>

          <Section title="可引用的查询" hint="来自查询库；卡片与下钻的 queryKey 须在此列表中。">
            {availableQueries.length === 0 ? (
              <p className="text-[13px] text-subtle">查询库为空，请先到「查询库」页签新增。</p>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
                {availableQueries.map((q) => (
                  <div key={q.queryKey} className="p-2 rounded-lg border border-line text-xs">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <code className="font-medium text-fg">{q.queryKey}</code>
                      <span className="text-muted">{q.label}</span>
                      {!q.enabled && <Badge>已停用</Badge>}
                    </div>
                    <div className="text-subtle mt-0.5">
                      参数：{q.params.length ? q.params.map((p) => p.name).join('、') : '无'}
                      {q.dimensions.length > 0 && ` · 维度：${q.dimensions.map((x) => x.column).join('、')}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <Section
          title="卡片"
          hint="type：kpi / bar / line / pie / table。layout.w 为 12 列栅格宽度（1~12），h 为高度档（1~4）。drill 为卡片内逐级下钻：bind 把点中那行的列值绑定为下一级查询的参数。"
        >
          <JsonField label="卡片定义" expect="array" rows={28} value={d.cardsText} onChange={(v) => patch({ cardsText: v })} placeholder={CARDS_PLACEHOLDER} />
        </Section>
      </div>

      <EditorActions onCancel={() => onDone(false)} onSave={() => void save()} saving={saving} />
    </AdminPage>
  )
}

// ═══════════════════════════════ 主视图 ═══════════════════════════════

export default function BiAdminView() {
  const { showToast } = useStore()
  const [tab, setTab] = useState<'queries' | 'dashboards'>('queries')
  const [queries, setQueries] = useState<BiQueryAdmin[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [dashboards, setDashboards] = useState<BiDashboardAdmin[]>([])
  const [availableQueries, setAvailableQueries] = useState<QueryOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editQuery, setEditQuery] = useState<{ draft: QueryDraft; isNew: boolean } | null>(null)
  const [editDashboard, setEditDashboard] = useState<{ draft: DashboardDraft; isNew: boolean } | null>(null)

  // 递增即重新加载（保存/删除后在事件里调用 load()）；effect 内只在 Promise 回调里 setState
  const [reloadTick, setReloadTick] = useState(0)
  const load = useCallback(() => {
    setLoading(true)
    setError('')
    setReloadTick((t) => t + 1)
  }, [])

  useEffect(() => {
    let alive = true
    Promise.all([apiFetch('/admin/bi/queries'), apiFetch('/admin/bi/dashboards')])
      .then(([q, d]) => {
        if (!alive) return
        setQueries(Array.isArray(q?.items) ? q.items : [])
        setAvailableRoles(Array.isArray(q?.availableRoles) ? q.availableRoles : [])
        setDashboards(Array.isArray(d?.items) ? d.items : [])
        setAvailableQueries(Array.isArray(d?.availableQueries) ? d.availableQueries : [])
      })
      .catch((err) => {
        if (alive) setError(errMsg(err, 'BI 配置加载失败'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [reloadTick])

  const remove = async (url: string, label: string) => {
    if (!(await confirmDelete(`「${label}」`))) return
    try {
      await apiFetch(url, { method: 'DELETE' })
      showToast('已删除')
      load()
    } catch (err) {
      showToast(errMsg(err, '删除失败'))
    }
  }

  if (editQuery) {
    return (
      <QueryEditor
        initial={editQuery.draft}
        isNew={editQuery.isNew}
        availableRoles={availableRoles}
        onDone={(saved) => {
          setEditQuery(null)
          if (saved) load()
        }}
      />
    )
  }
  if (editDashboard) {
    return (
      <DashboardEditor
        initial={editDashboard.draft}
        isNew={editDashboard.isNew}
        availableQueries={availableQueries}
        onDone={(saved) => {
          setEditDashboard(null)
          if (saved) load()
        }}
      />
    )
  }

  const openNew = () =>
    tab === 'queries'
      ? setEditQuery({ draft: { ...EMPTY_QUERY }, isNew: true })
      : setEditDashboard({ draft: { ...EMPTY_DASHBOARD }, isNew: true })

  return (
    <AdminPage
      title="BI 看板管理"
      description="查询库供卡片、下钻和 Agent 追问共用；看板在「Agent 配置」里关联"
      actions={
        <Button icon={<Plus className="w-4 h-4" />} onClick={openNew}>
          {tab === 'queries' ? '新增查询' : '新增看板'}
        </Button>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'queries', label: `查询库（${queries.length}）` },
          { value: 'dashboards', label: `看板（${dashboards.length}）` },
        ]}
      />

      {loading && <Skeleton className="h-40" />}
      {!loading && error && <Notice tone="danger">{error}</Notice>}

      {!loading && !error && tab === 'queries' && (
        <Card className="overflow-hidden">
          {queries.length === 0 && <EmptyState title="暂无查询" description="点「新增查询」登记第一条" />}
          {queries.map((q) => (
            <RecordRow
              key={q.queryKey}
              onClick={() => setEditQuery({ draft: queryToDraft(q), isNew: false })}
              title={q.label}
              badges={
                <>
                  <Code>{q.queryKey}</Code>
                  {!q.enabled && <Badge>已停用</Badge>}
                  <Badge tone="primary">缓存 {q.cacheSecs}s</Badge>
                </>
              }
              meta={
                <>
                  {q.caliberNote && <span>口径：{q.caliberNote}</span>}
                  <span>可见角色：{q.roles.length ? q.roles.join('、') : '仅管理员'}</span>
                </>
              }
              actions={
                <>
                  <IconButton label="编辑" onClick={() => setEditQuery({ draft: queryToDraft(q), isNew: false })}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(`/admin/bi/queries/${encodeURIComponent(q.queryKey)}`, q.label)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </>
              }
            />
          ))}
        </Card>
      )}

      {!loading && !error && tab === 'dashboards' && (
        <Card className="overflow-hidden">
          {dashboards.length === 0 && <EmptyState title="暂无看板" description="点「新增看板」创建" />}
          {dashboards.map((d) => (
            <RecordRow
              key={d.dashboardKey}
              onClick={() => setEditDashboard({ draft: dashboardToDraft(d), isNew: false })}
              title={d.label}
              badges={
                <>
                  <Code>{d.dashboardKey}</Code>
                  {!d.enabled && <Badge>已停用</Badge>}
                </>
              }
              meta={
                <>
                  <span>
                    {d.cards.length} 张卡片 · {d.filters.length} 个筛选
                  </span>
                  <span>
                    关联 Agent：
                    {d.usedByAgents?.length ? d.usedByAgents.join('、') : <span className="text-warning">未关联（在「Agent 配置」里选择）</span>}
                  </span>
                </>
              }
              actions={
                <>
                  <IconButton label="编辑" onClick={() => setEditDashboard({ draft: dashboardToDraft(d), isNew: false })}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(`/admin/bi/dashboards/${encodeURIComponent(d.dashboardKey)}`, d.label)}>
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
