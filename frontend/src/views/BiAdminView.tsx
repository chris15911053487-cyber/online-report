/**
 * BI 看板管理：查询库（语义层）+ 看板，两个页签。
 *
 * 配置顺序：先在查询库登记查询（SQL → 参数 → 试运行识别输出列 → 列语义 → 示例问法），
 * 再在看板里用这些查询搭卡片（列从下拉选，格式继承列语义，实时预览）。
 * 看板在「Agent 配置」里关联到某个 Agent，进入该 Agent 即显示。
 * 编辑器在 components/bi/admin/。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { AdminPage, Badge, Button, Card, Code, EmptyState, IconButton, Notice, RecordRow, Skeleton, Tabs } from '../ui'
import { confirmDelete } from '../ui/confirm'
import QueryEditor from '../components/bi/admin/QueryEditor'
import DashboardEditor from '../components/bi/admin/DashboardEditor'
import { EMPTY_DASHBOARD, EMPTY_QUERY, errMsg, type BiDashboardAdmin, type BiQueryAdmin, type QueryOption } from '../components/bi/admin/types'

/** 查询被哪些看板引用（卡片或下钻） */
function usedBy(dashboards: BiDashboardAdmin[], queryKey: string): string[] {
  return dashboards
    .filter((d) => d.cards.some((c) => c.queryKey === queryKey || (c.drill || []).some((x) => x.queryKey === queryKey)))
    .map((d) => d.label)
}

export default function BiAdminView() {
  const { showToast } = useStore()
  const [tab, setTab] = useState<'queries' | 'dashboards'>('queries')
  const [queries, setQueries] = useState<BiQueryAdmin[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [dashboards, setDashboards] = useState<BiDashboardAdmin[]>([])
  const [availableQueries, setAvailableQueries] = useState<QueryOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editQuery, setEditQuery] = useState<{ draft: BiQueryAdmin; isNew: boolean } | null>(null)
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
    Promise.all([apiFetch('/admin/bi/queries'), apiFetch('/admin/bi/dashboards')])
      .then(([q, d]) => {
        if (!alive) return
        setQueries(Array.isArray(q?.items) ? q.items.map((x: BiQueryAdmin) => ({ ...EMPTY_QUERY, ...x })) : [])
        setAvailableRoles(Array.isArray(q?.availableRoles) ? q.availableRoles : [])
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

  const refs = useMemo(() => new Map(queries.map((q) => [q.queryKey, usedBy(dashboards, q.queryKey)])), [queries, dashboards])

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
        onDone={(changed) => {
          setEditQuery(null)
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
        availableQueries={availableQueries}
        onDone={(changed) => {
          setEditDashboard(null)
          if (changed) load()
        }}
      />
    )
  }

  const openNew = () =>
    tab === 'queries'
      ? setEditQuery({ draft: structuredClone(EMPTY_QUERY), isNew: true })
      : setEditDashboard({ draft: structuredClone(EMPTY_DASHBOARD), isNew: true })
  const openQuery = (q: BiQueryAdmin) => setEditQuery({ draft: structuredClone(q), isNew: false })
  const openDashboard = (d: BiDashboardAdmin) => setEditDashboard({ draft: structuredClone(d), isNew: false })

  return (
    <AdminPage
      title="BI 看板管理"
      description="先在查询库登记查询并标注输出列，再用它们搭看板；看板在「Agent 配置」里关联到 Agent"
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
          { value: 'queries', label: `① 查询库（${queries.length}）` },
          { value: 'dashboards', label: `② 看板（${dashboards.length}）` },
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
                    <span>{used.length ? `被看板使用：${used.join('、')}` : '未被看板使用'}</span>
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

      {!loading && !error && tab === 'dashboards' && (
        <Card className="overflow-hidden">
          {dashboards.length === 0 && <EmptyState title="暂无看板" description={queries.length ? '点「新增看板」创建' : '请先在「查询库」登记查询'} />}
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
