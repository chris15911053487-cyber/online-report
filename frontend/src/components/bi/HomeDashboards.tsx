/**
 * 首页「我的工作台」：管理员在 BI 看板上勾选「显示在首页」的角色，命中当前用户角色的看板显示在这里。
 * 多个看板分页签（记住上次选的）；一个都没有则什么都不渲染，首页保持原样。
 *
 * 看板本身就是普通 BI 看板：卡片按查询角色裁剪（后端），按人取数靠查询 SQL 里的 @_loginUser / @_user_字段。
 * 首页没有 AI 对话，点击卡片元素直接下钻（有下一级时）。
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import type { BiDashboard } from '../../utils/bi'
import type { BiPick } from '../../utils/biContext'
import { useIsPc } from '../../hooks/useMediaQuery'
import { Segmented } from '../../ui'
import { DashboardView } from './DashboardPanel'

const TAB_KEY = 'home_dashboard_tab'

function readTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY)
  } catch {
    return null
  }
}
function writeTab(v: string) {
  try {
    localStorage.setItem(TAB_KEY, v)
  } catch {
    /* 存不了就只在本次有效 */
  }
}

const drillOnPick = (pick: BiPick) => {
  if (pick.drillLabel) pick.drill()
}

export default function HomeDashboards() {
  const isPc = useIsPc()
  const [dashboards, setDashboards] = useState<BiDashboard[] | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<string | null>(readTab)

  useEffect(() => {
    let alive = true
    apiFetch('/home/dashboards')
      .then((d: { dashboards?: BiDashboard[] }) => alive && setDashboards(d.dashboards || []))
      .catch((err: unknown) => {
        if (!alive) return
        setDashboards([])
        setError(err instanceof Error ? err.message : '工作台加载失败')
      })
    return () => {
      alive = false
    }
  }, [])

  if (dashboards === null) {
    return (
      <div className="flex items-center gap-2 mb-5 text-[13px] text-subtle">
        <Loader2 className="w-4 h-4 animate-spin" />
        工作台加载中…
      </div>
    )
  }
  if (error) return <div className="mb-5 rounded-xl bg-danger-soft border border-danger/25 text-danger text-[13px] px-3.5 py-2.5">{error}</div>
  if (dashboards.length === 0) return null

  const current = dashboards.find((d) => d.dashboardKey === tab) ?? dashboards[0]
  const choose = (k: string) => {
    setTab(k)
    writeTab(k)
  }

  return (
    <section className="mb-6" data-home-workbench>
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <h3 className="text-[13px] font-medium text-muted">我的工作台</h3>
        {dashboards.length > 1 && (
          <Segmented
            size="sm"
            className="max-w-full overflow-x-auto"
            value={current.dashboardKey}
            onChange={choose}
            options={dashboards.map((d) => ({ value: d.dashboardKey, label: d.label }))}
          />
        )}
      </div>
      {/* 只有一个看板时标题就是看板名；多个时页签已经写了名字 */}
      <DashboardView key={current.dashboardKey} dashboard={current} pcMode={isPc} onPick={drillOnPick} showHeader={dashboards.length === 1} />
    </section>
  )
}
