/**
 * BI 看板管理：查询库（语义层）→ 图表 → 看板，三个页签。
 *
 * 配置顺序：先在查询库登记查询（SQL → 参数 → 试运行识别输出列 → 列语义 → 示例问法），
 * 再用查询做图表（类型、列从下拉选、下钻，实时预览；可被多个看板复用），
 * 最后在看板里选图表、设筛选、排版（同名参数自动跟随筛选）。
 * 看板在「Agent 配置」里关联到某个 Agent，进入该 Agent 即显示。
 * 编辑器在 components/bi/admin/。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { AdminPage, Badge, Button, Card, Code, EmptyState, IconButton, Notice, RecordRow, Skeleton, Tabs } from '../ui'
import { confirmDelete } from '../ui/confirm'
import QueryEditor from '../components/bi/admin/QueryEditor'
import ChartEditor from '../components/bi/admin/ChartEditor'
import DashboardEditor from '../components/bi/admin/DashboardEditor'
import AiDraftModal, { type BiDraft } from '../components/bi/admin/AiDraftModal'
import AiChartsReview from '../components/bi/admin/AiChartsReview'
import { EMPTY_DASHBOARD, EMPTY_QUERY, errMsg, type BiChartAdmin, type BiDashboardAdmin, type BiQueryAdmin, type QueryOption } from '../components/bi/admin/types'
import { newChart } from '../utils/biAdmin'
import HelpDocPanel from '../components/HelpDocPanel'
import { clearPendingPin, readPendingPin } from '../utils/biPin'

type Tab = 'queries' | 'charts' | 'dashboards'
const TYPE_LABEL: Record<string, string> = { kpi: 'KPI', bar: '柱状', line: '折线', pie: '饼图', table: '表格' }

/** 查询被哪些图表用到（主查询或下钻） */
function usedBy(charts: BiChartAdmin[], queryKey: string): string[] {
  return charts.filter((c) => c.queryKey === queryKey || (c.drill || []).some((x) => x.queryKey === queryKey)).map((c) => c.label)
}

export default function BiAdminView() {
  const { showToast } = useStore()
  const [tab, setTab] = useState<Tab>('queries')
  const [queries, setQueries] = useState<BiQueryAdmin[]>([])
  const [charts, setCharts] = useState<BiChartAdmin[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [dashboards, setDashboards] = useState<BiDashboardAdmin[]>([])
  const [availableQueries, setAvailableQueries] = useState<QueryOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editQuery, setEditQuery] = useState<{ draft: BiQueryAdmin; isNew: boolean; ai?: BiDraft } | null>(null)
  const [editChart, setEditChart] = useState<{ draft: BiChartAdmin; isNew: boolean } | null>(null)
  const [aiReview, setAiReview] = useState<BiDraft | null>(null)
  // 对话页「📌 收藏到看板」新开本页时带来的 SQL：进来直接打开收藏弹窗（读一次即清除）
  const [pin, setPin] = useState(() => readPendingPin())
  const [aiOpen, setAiOpen] = useState(() => pin != null)
  const [helpOpen, setHelpOpen] = useState(false)
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  useEffect(() => clearPendingPin(), [])
  const [editDashboard, setEditDashboard] = useState<{ draft: BiDashboardAdmin; isNew: boolean } | null>(null)

  // 递增即重新加载（保存/删除后在事件里调用 load()）；effect 内只在 Promise 回调里 setState
  const [reloadTick, setReloadTick] = useState(0)
  const load = useCallback(() => {
    setLoading(true)
    setError('')
    setReloadTick((t) => t + 1)
  }, [])

  useEffect(() => {
    let alive = true
    Promise.all([apiFetch('/admin/bi/queries'), apiFetch('/admin/bi/charts'), apiFetch('/admin/bi/dashboards')])
      .then(([q, c, d]) => {
        if (!alive) return
        setQueries(Array.isArray(q?.items) ? q.items.map((x: BiQueryAdmin) => ({ ...EMPTY_QUERY, ...x })) : [])
        setAvailableRoles(Array.isArray(q?.availableRoles) ? q.availableRoles : [])
        setCharts(Array.isArray(c?.items) ? c.items.map((x: BiChartAdmin) => ({ ...newChart(), ...x })) : [])
        setDashboards(Array.isArray(d?.items) ? d.items : [])
        setAvailableQueries(Array.isArray(d?.availableQueries) ? d.availableQueries.map((x: QueryOption) => ({ ...x, columns: x.columns || [] })) : [])
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

  const refs = useMemo(() => new Map(queries.map((q) => [q.queryKey, usedBy(charts, q.queryKey)])), [queries, charts])

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
    const ai = editQuery.ai
    return (
      <QueryEditor
        initial={editQuery.draft}
        isNew={editQuery.isNew}
        availableRoles={availableRoles}
        initialTestValues={ai ? Object.fromEntries(Object.entries(ai.sampleParams).map(([k, v]) => [k, v == null ? '' : String(v)])) : undefined}
        banner={
          ai && (
            <Notice tone="info">
              <p className="font-medium">AI 草稿 · 第 1 步 / 共 2 步：确认查询</p>
              <p>核对 SQL、口径、列的中文名与角色、可见角色后保存；保存后并排预览 AI 推荐的图表。{ai.notes ? `AI 的假设：${ai.notes}` : ''}</p>
            </Notice>
          )
        }
        onDone={(changed, savedKey) => {
          setEditQuery(null)
          if (changed) load()
          // AI 草稿：查询保存后接着确认推荐的图表（查询标识以实际保存的为准）
          if (ai && changed && savedKey) setAiReview({ ...ai, charts: ai.charts.map((c) => ({ ...c, queryKey: savedKey })) })
        }}
      />
    )
  }
  if (aiReview) {
    return (
      <AiChartsReview
        charts={aiReview.charts}
        availableQueries={availableQueries}
        sampleParams={aiReview.sampleParams}
        onDone={(changed) => {
          setAiReview(null)
          if (changed) {
            setTab('charts')
            load()
          }
        }}
      />
    )
  }
  if (editChart) {
    return (
      <ChartEditor
        initial={editChart.draft}
        isNew={editChart.isNew}
        availableQueries={availableQueries}
        onDone={(changed) => {
          setEditChart(null)
          if (changed) load()
        }}
      />
    )
  }
  if (editDashboard) {
    return (
      <DashboardEditor
        initial={editDashboard.draft}
        isNew={editDashboard.isNew}
        availableCharts={charts}
        availableQueries={availableQueries}
        onDone={(changed) => {
          setEditDashboard(null)
          if (changed) load()
        }}
      />
    )
  }

  const openNew = () => {
    if (tab === 'queries') setEditQuery({ draft: structuredClone(EMPTY_QUERY), isNew: true })
    else if (tab === 'charts') setEditChart({ draft: newChart(), isNew: true })
    else setEditDashboard({ draft: structuredClone(EMPTY_DASHBOARD), isNew: true })
  }
  const openQuery = (q: BiQueryAdmin) => setEditQuery({ draft: structuredClone(q), isNew: false })
  const openChart = (c: BiChartAdmin) => setEditChart({ draft: structuredClone(c), isNew: false })
  const openDashboard = (d: BiDashboardAdmin) => setEditDashboard({ draft: structuredClone(d), isNew: false })

  return (
    <AdminPage
      title="BI 看板管理"
      description="查询（数据与口径）→ 图表（怎么展示，可复用）→ 看板（选图表、设筛选、排版）；看板在「Agent 配置」里关联到 Agent"
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={<BookOpen className="w-4 h-4" />} onClick={() => setHelpOpen(true)}>
            使用说明
          </Button>
          {tab !== 'dashboards' && (
            <Button variant="soft" icon={<Sparkles className="w-4 h-4" />} onClick={() => setAiOpen(true)}>
              AI 起草
            </Button>
          )}
          <Button icon={<Plus className="w-4 h-4" />} onClick={openNew}>
            {tab === 'queries' ? '新增查询' : tab === 'charts' ? '新增图表' : '新增看板'}
          </Button>
        </div>
      }
    >
      <HelpDocPanel
        open={helpOpen}
        onClose={closeHelp}
        tabs={[
          { slug: 'bi-admin', label: '看板配置（管理员）' },
          { slug: 'bi-dashboard', label: '看板使用' },
        ]}
      />
      <AiDraftModal
        open={aiOpen}
        fromSql={pin}
        onClose={() => {
          setAiOpen(false)
          setPin(null)
        }}
        onAccept={(d) => {
          setAiOpen(false)
          setPin(null)
          setEditQuery({ draft: { ...EMPTY_QUERY, ...d.query }, isNew: true, ai: d })
        }}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'queries', label: `① 查询库（${queries.length}）` },
          { value: 'charts', label: `② 图表（${charts.length}）` },
          { value: 'dashboards', label: `③ 看板（${dashboards.length}）` },
        ]}
      />

      {loading && <Skeleton className="h-40" />}
      {!loading && error && <Notice tone="danger">{error}</Notice>}

      {!loading && !error && tab === 'queries' && (
        <Card className="overflow-hidden">
          {queries.length === 0 && <EmptyState title="暂无查询" description="点「新增查询」登记第一条：写 SQL、试运行、标注输出列" />}
          {queries.map((q) => {
            const used = refs.get(q.queryKey) || []
            return (
              <RecordRow
                key={q.queryKey}
                onClick={() => openQuery(q)}
                title={q.label}
                badges={
                  <>
                    <Code>{q.queryKey}</Code>
                    {!q.enabled && <Badge>已停用</Badge>}
                    {q.columns.length === 0 ? <Badge tone="warning">未登记输出列</Badge> : <Badge tone="info">{q.columns.length} 列</Badge>}
                    {q.params.length > 0 && <Badge>{q.params.length} 个参数</Badge>}
                  </>
                }
                meta={
                  <>
                    {q.description && <span className="truncate max-w-[32rem]">{q.description}</span>}
                    <span>可见角色：{q.roles.length ? q.roles.join('、') : '仅管理员'}</span>
                    <span>{used.length ? `被图表使用：${used.join('、')}` : '未被图表使用'}</span>
                  </>
                }
                actions={
                  <>
                    <IconButton label="编辑" onClick={() => openQuery(q)}>
                      <Pencil className="w-4 h-4" />
                    </IconButton>
                    <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(`/admin/bi/queries/${encodeURIComponent(q.queryKey)}`, q.label)}>
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  </>
                }
              />
            )
          })}
        </Card>
      )}

      {!loading && !error && tab === 'charts' && (
        <Card className="overflow-hidden">
          {charts.length === 0 && <EmptyState title="暂无图表" description={queries.length ? '点「新增图表」：选查询、选类型和列，实时预览' : '请先在「查询库」登记查询'} />}
          {charts.map((c) => {
            const q = queries.find((x) => x.queryKey === c.queryKey)
            return (
              <RecordRow
                key={c.chartKey}
                onClick={() => openChart(c)}
                title={c.label}
                badges={
                  <>
                    <Code>{c.chartKey}</Code>
                    <Badge tone="info">{TYPE_LABEL[c.type] || c.type}</Badge>
                    {!c.enabled && <Badge>已停用</Badge>}
                    {c.drill.length > 0 && <Badge>下钻 {c.drill.length} 级</Badge>}
                  </>
                }
                meta={
                  <>
                    <span>查询：{q ? q.label : <span className="text-danger">{c.queryKey}（不存在）</span>}</span>
                    <span>{c.usedByDashboards?.length ? `用于看板：${c.usedByDashboards.join('、')}` : '未放进看板'}</span>
                  </>
                }
                actions={
                  <>
                    <IconButton label="编辑" onClick={() => openChart(c)}>
                      <Pencil className="w-4 h-4" />
                    </IconButton>
                    <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(`/admin/bi/charts/${encodeURIComponent(c.chartKey)}`, c.label)}>
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  </>
                }
              />
            )
          })}
        </Card>
      )}

      {!loading && !error && tab === 'dashboards' && (
        <Card className="overflow-hidden">
          {dashboards.length === 0 && <EmptyState title="暂无看板" description={charts.length ? '点「新增看板」创建' : '请先在「图表」里做好图表'} />}
          {dashboards.map((d) => (
            <RecordRow
              key={d.dashboardKey}
              onClick={() => openDashboard(d)}
              title={d.label}
              badges={
                <>
                  <Code>{d.dashboardKey}</Code>
                  {!d.enabled && <Badge>已停用</Badge>}
                  {d.cards.length === 0 && <Badge tone="warning">没有卡片</Badge>}
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
                  <IconButton label="编辑" onClick={() => openDashboard(d)}>
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
