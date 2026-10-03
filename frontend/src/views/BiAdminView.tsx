/**
 * BI 管理（第一期最简版）：查询库 + 看板，两个页签。
 *
 * - 查询库：SQL + 参数（JSON）+ 可下钻维度（JSON）+ 口径 + 缓存 + 可见角色；可用未保存的定义「试运行」
 * - 看板：全局筛选（JSON）+ 卡片（JSON）；卡片只引用 queryKey，保存时由后端校验
 *
 * 看板在「Agent 配置」里选择关联到某个 Agent，进入该 Agent 即显示。
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { parseJsonField, toJsonText, type BiDrillLevel, type BiFilter, type BiParamDef } from '../utils/bi'

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

const inputCls =
  'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500'
const monoCls = inputCls + ' font-mono text-[12px] leading-relaxed'
const labelCls = 'block text-[13px] font-medium text-slate-600 mb-1'

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 mb-3">
      <h3 className="text-sm font-semibold text-slate-800 mb-0.5">{title}</h3>
      {hint && <p className="text-[12px] text-slate-400 mb-3">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </div>
  )
}

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
    <div className="p-4 pb-24">
      <button onClick={() => onDone(false)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ChevronLeft className="w-4 h-4" />
        返回列表
      </button>
      <h2 className="text-lg font-semibold text-slate-900 mb-3">{isNew ? '新增查询' : `编辑：${d.label || d.queryKey}`}</h2>

      <Section title="基本信息">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>查询标识（queryKey）</label>
            <input className={inputCls} value={d.queryKey} disabled={!isNew} onChange={(e) => patch({ queryKey: e.target.value })} placeholder="fin_ar_by_customer" />
            <p className="text-[11px] text-slate-400 mt-1">小写字母开头，仅小写字母/数字/下划线/连字符；创建后不可修改</p>
          </div>
          <div>
            <label className={labelCls}>显示名称</label>
            <input className={inputCls} value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="应收账款 · 按客户" />
          </div>
          <div>
            <label className={labelCls}>说明（这条查询回答什么问题；AI 也会看到）</label>
            <textarea className={inputCls} rows={2} value={d.description} onChange={(e) => patch({ description: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>口径说明</label>
            <input className={inputCls} value={d.caliberNote} onChange={(e) => patch({ caliberNote: e.target.value })} placeholder="按过账日期，含未清贷项，币种本币" />
          </div>
        </div>
      </Section>

      <Section title="SQL" hint="只允许一条 SELECT / WITH 只读查询；参数写成 @name，并在下方「参数定义」中声明。">
        <textarea className={monoCls} rows={10} value={d.sqlText} onChange={(e) => patch({ sqlText: e.target.value })} spellCheck={false} />
      </Section>

      <Section title="参数与维度">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>参数定义（JSON 数组；type 为 string / number / date / bool）</label>
            <textarea className={monoCls} rows={4} value={d.paramsText} onChange={(e) => patch({ paramsText: e.target.value })} placeholder={PARAMS_PLACEHOLDER} spellCheck={false} />
          </div>
          <div>
            <label className={labelCls}>可下钻维度（结果中可作为维度的列）</label>
            <textarea className={monoCls} rows={4} value={d.dimensionsText} onChange={(e) => patch({ dimensionsText: e.target.value })} placeholder={DIMENSIONS_PLACEHOLDER} spellCheck={false} />
          </div>
        </div>
      </Section>

      <Section title="缓存与权限">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>结果缓存（秒）</label>
            <input type="number" className={inputCls} value={d.cacheSecs} onChange={(e) => patch({ cacheSecs: Number(e.target.value) })} />
            <p className="text-[11px] text-slate-400 mt-1">0 = 不缓存。缓存按「参数 + 用户角色组合」分别保存，不同角色不会共享结果</p>
          </div>
          <div>
            <label className={labelCls}>可见角色（未勾选 = 仅管理员）</label>
            <div className="flex flex-wrap gap-2">
              {availableRoles.map((r) => (
                <label key={r} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 text-[12px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={d.roles.includes(r)}
                    onChange={() => patch({ roles: d.roles.includes(r) ? d.roles.filter((x) => x !== r) : [...d.roles, r] })}
                  />
                  {r}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            <span className="text-sm text-slate-700">启用</span>
          </label>
        </div>
      </Section>

      <Section title="试运行" hint="用当前表单里的定义执行（无需先保存），最多返回 50 行，不走缓存。">
        <div className="space-y-2">
          <textarea className={monoCls} rows={2} value={testParamsText} onChange={(e) => setTestParamsText(e.target.value)} placeholder='{ "period": "2026-09" }' spellCheck={false} />
          <button onClick={() => void runTest()} disabled={testing} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm disabled:opacity-60">
            <Play className="w-3.5 h-3.5" />
            {testing ? '执行中…' : '试运行'}
          </button>
          {testError && <p className="text-[12px] text-red-600 break-all">{testError}</p>}
          {testResult && (
            <div>
              <p className="text-[12px] text-slate-500 mb-1">
                {testResult.rowCount} 行{testResult.truncated ? '（已截断）' : ''} · {testResult.durationMs} ms
              </p>
              <div className="overflow-auto max-h-72 border border-slate-200 rounded">
                <table className="min-w-full text-[12px]">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      {testResult.columns.map((c) => (
                        <th key={c} className="px-2 py-1 text-left font-medium text-slate-600 whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {testResult.rows.map((row, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        {testResult.columns.map((c) => (
                          <td key={c} className="px-2 py-1 whitespace-nowrap text-slate-700">{row[c] == null ? '' : String(row[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Section>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-3 flex gap-2 z-10">
        <button onClick={() => onDone(false)} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-600">取消</button>
        <button onClick={() => void save()} disabled={saving} className="flex-1 py-2.5 bg-indigo-500 text-white rounded-lg text-sm font-medium disabled:opacity-60">
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
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
    <div className="p-4 pb-24">
      <button onClick={() => onDone(false)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ChevronLeft className="w-4 h-4" />
        返回列表
      </button>
      <h2 className="text-lg font-semibold text-slate-900 mb-3">{isNew ? '新增看板' : `编辑：${d.label || d.dashboardKey}`}</h2>

      <Section title="基本信息">
        <div className="space-y-3">
          <div>
            <label className={labelCls}>看板标识（dashboardKey）</label>
            <input className={inputCls} value={d.dashboardKey} disabled={!isNew} onChange={(e) => patch({ dashboardKey: e.target.value })} placeholder="finance" />
          </div>
          <div>
            <label className={labelCls}>显示名称</label>
            <input className={inputCls} value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="财务经营看板" />
          </div>
          <div>
            <label className={labelCls}>说明</label>
            <textarea className={inputCls} rows={2} value={d.description} onChange={(e) => patch({ description: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            <span className="text-sm text-slate-700">启用</span>
          </label>
        </div>
      </Section>

      <Section
        title="全局筛选"
        hint="type：month / date / string / select。默认值可用 $today $yesterday $thisMonth $lastMonth $monthStart $yearStart。卡片参数里写 $filter.名称 引用。"
      >
        <textarea className={monoCls} rows={5} value={d.filtersText} onChange={(e) => patch({ filtersText: e.target.value })} placeholder={FILTERS_PLACEHOLDER} spellCheck={false} />
      </Section>

      <Section
        title="卡片"
        hint="type：kpi / bar / line / pie / table。layout.w 为 12 列栅格宽度（1~12），h 为高度档（1~4）。drill 为卡片内逐级下钻：bind 把点中那行的列值绑定为下一级查询的参数。"
      >
        <textarea className={monoCls} rows={18} value={d.cardsText} onChange={(e) => patch({ cardsText: e.target.value })} placeholder={CARDS_PLACEHOLDER} spellCheck={false} />
      </Section>

      <Section title="可引用的查询" hint="来自查询库；卡片与下钻的 queryKey 须在此列表中。">
        {availableQueries.length === 0 ? (
          <p className="text-[13px] text-slate-400">查询库为空，请先到「查询库」页签新增。</p>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {availableQueries.map((q) => (
              <div key={q.queryKey} className="p-2 rounded border border-slate-200 text-[12px]">
                <div className="flex items-center gap-1.5">
                  <code className="font-medium text-slate-800">{q.queryKey}</code>
                  <span className="text-slate-500">{q.label}</span>
                  {!q.enabled && <span className="text-[10px] px-1.5 rounded bg-slate-100 text-slate-500">已停用</span>}
                </div>
                <div className="text-slate-400 mt-0.5">
                  参数：{q.params.length ? q.params.map((p) => p.name).join('、') : '无'}
                  {q.dimensions.length > 0 && ` · 维度：${q.dimensions.map((x) => x.column).join('、')}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-3 flex gap-2 z-10">
        <button onClick={() => onDone(false)} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-600">取消</button>
        <button onClick={() => void save()} disabled={saving} className="flex-1 py-2.5 bg-indigo-500 text-white rounded-lg text-sm font-medium disabled:opacity-60">
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════ 主视图 ═══════════════════════════════

export default function BiAdminView() {
  const { showToast, goBack } = useStore()
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
    if (!window.confirm(`确定删除「${label}」？此操作不可恢复。`)) return
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

  const tabBtn = (key: typeof tab, text: string) => (
    <button
      onClick={() => setTab(key)}
      className={`flex-1 py-2 text-sm rounded-md transition-colors ${tab === key ? 'bg-white shadow text-slate-900 font-medium' : 'text-slate-500'}`}
      aria-pressed={tab === key}
    >
      {text}
    </button>
  )

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">BI 看板管理</h2>
          <p className="text-[12px] text-slate-500 mt-0.5">查询库供卡片、下钻和 Agent 追问共用；看板在「Agent 配置」里关联</p>
        </div>
        <button
          onClick={() =>
            tab === 'queries'
              ? setEditQuery({ draft: { ...EMPTY_QUERY }, isNew: true })
              : setEditDashboard({ draft: { ...EMPTY_DASHBOARD }, isNew: true })
          }
          className="flex items-center gap-1 px-3 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium hover:bg-indigo-600 flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
          新增
        </button>
      </div>

      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg mb-3" role="tablist">
        {tabBtn('queries', `查询库（${queries.length}）`)}
        {tabBtn('dashboards', `看板（${dashboards.length}）`)}
      </div>

      {loading && <p className="text-sm text-slate-400">加载中…</p>}
      {!loading && error && <div className="bg-red-50 border border-red-100 text-red-600 text-sm rounded-lg p-3">{error}</div>}

      {!loading && !error && tab === 'queries' && (
        <div className="space-y-2">
          {queries.length === 0 && <p className="text-sm text-slate-400">暂无查询，点「新增」登记第一条。</p>}
          {queries.map((q) => (
            <div key={q.queryKey} className="bg-white rounded-lg border border-slate-200 p-3.5 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[15px] font-semibold text-slate-900">{q.label}</span>
                  <code className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{q.queryKey}</code>
                  {!q.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">已停用</span>}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">缓存 {q.cacheSecs}s</span>
                </div>
                {q.caliberNote && <p className="text-[12px] text-slate-500 mt-1">口径：{q.caliberNote}</p>}
                <p className="text-[12px] text-slate-500 mt-0.5">可见角色：{q.roles.length ? q.roles.join('、') : '仅管理员'}</p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button onClick={() => setEditQuery({ draft: queryToDraft(q), isNew: false })} className="p-2 text-slate-400 hover:text-sky-600 rounded-lg" aria-label="编辑">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => void remove(`/admin/bi/queries/${encodeURIComponent(q.queryKey)}`, q.label)} className="p-2 text-slate-400 hover:text-red-600 rounded-lg" aria-label="删除">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && tab === 'dashboards' && (
        <div className="space-y-2">
          {dashboards.length === 0 && <p className="text-sm text-slate-400">暂无看板，点「新增」创建。</p>}
          {dashboards.map((d) => (
            <div key={d.dashboardKey} className="bg-white rounded-lg border border-slate-200 p-3.5 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[15px] font-semibold text-slate-900">{d.label}</span>
                  <code className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{d.dashboardKey}</code>
                  {!d.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">已停用</span>}
                </div>
                <p className="text-[12px] text-slate-500 mt-1">
                  {d.cards.length} 张卡片 · {d.filters.length} 个筛选
                </p>
                <p className="text-[12px] text-slate-500 mt-0.5">
                  关联 Agent：{d.usedByAgents?.length ? d.usedByAgents.join('、') : <span className="text-amber-600">未关联（在「Agent 配置」里选择）</span>}
                </p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button onClick={() => setEditDashboard({ draft: dashboardToDraft(d), isNew: false })} className="p-2 text-slate-400 hover:text-sky-600 rounded-lg" aria-label="编辑">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => void remove(`/admin/bi/dashboards/${encodeURIComponent(d.dashboardKey)}`, d.label)} className="p-2 text-slate-400 hover:text-red-600 rounded-lg" aria-label="删除">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button onClick={goBack} className="w-full mt-4 py-2.5 border border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">
        返回
      </button>
    </div>
  )
}
