/**
 * 只看下钻明细的页面（/bi/drill?drill=…）：看板明细面板里点「在新标签页打开」或 Ctrl / ⌘ + 点击时打开。
 * 地址里带着 Agent、卡片、筛选和下钻路径，可以直接发给同事（对方同样要有该 Agent 与查询的权限）。
 * 权限仍由后端校验：看板经 /agents/:agentKey/dashboard 按角色裁剪，明细经 /bi/query 取数。
 */
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { apiFetch } from '../utils/api'
import { filterDisplayText, type BiDashboard } from '../utils/bi'
import { DRILL_PARAM, decodeDrillLink, drillPagePath, encodeDrillLink, openPanel, panelFromLink, toDrillLink, type DrillLink, type DrillPanelState } from '../utils/biDrill'
import { useFilterOptions } from '../utils/biOptions'
import DrillPanel from '../components/bi/DrillPanel'
import { EmptyState } from '../ui'

type LoadState = { dashboard?: BiDashboard; error?: string }

export default function BiDrillView() {
  const [link] = useState<DrillLink | null>(() => decodeDrillLink(new URLSearchParams(window.location.search).get(DRILL_PARAM)))
  const [state, setState] = useState<LoadState | null>(null)
  const [panel, setPanel] = useState<DrillPanelState | null>(null)

  useEffect(() => {
    if (!link) return
    let alive = true
    apiFetch(`/agents/${encodeURIComponent(link.agentKey)}/dashboard`)
      .then((d: { dashboard: BiDashboard }) => {
        if (!alive) return
        const card = d.dashboard.cards.find((c) => c.id === link.cardId)
        const p = card ? panelFromLink(card, link) : null
        if (!p) setState({ error: card ? '看板配置已改动，这个下钻位置已不存在' : '找不到这张卡片，或没有查看权限' })
        else {
          setState({ dashboard: d.dashboard })
          setPanel(p)
        }
      })
      .catch((err: unknown) => alive && setState({ error: err instanceof Error ? err.message : '看板加载失败' }))
    return () => {
      alive = false
    }
  }, [link])

  const filterDefs = useMemo(() => state?.dashboard?.filters ?? [], [state])
  const filterOptions = useFilterOptions(filterDefs)
  const filters = useMemo(() => link?.filters ?? {}, [link])
  const filterText = useMemo(() => filterDisplayText(filterDefs, filters, filterOptions.loaded), [filterDefs, filters, filterOptions.loaded])

  // 面板里继续下钻：地址跟着变（刷新、复制链接都停在当前这一级）
  const change = (p: DrillPanelState) => {
    setPanel(p)
    if (!link) return
    try {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}?${DRILL_PARAM}=${encodeDrillLink(toDrillLink(link.agentKey, p, filters))}`)
    } catch {
      /* 地址改不了不影响查看 */
    }
  }

  if (!link) return <EmptyState className="py-20" title="链接无效" description="下钻链接不完整或已损坏，请回到看板重新打开" />
  if (!state) {
    return (
      <div className="flex items-center justify-center h-48 gap-2 text-[13px] text-subtle">
        <Loader2 className="w-4 h-4 animate-spin" />
        加载中…
      </div>
    )
  }
  if (state.error || !state.dashboard || !panel) return <EmptyState className="py-20" title="打不开这份明细" description={state.error} />

  const dashboard = state.dashboard
  const boardHref = `/agents/${encodeURIComponent(link.agentKey)}?${DRILL_PARAM}=${encodeDrillLink(toDrillLink(link.agentKey, panel, filters))}`

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-3 h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-4rem)] min-h-[520px]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="font-display text-[16px] font-semibold text-fg truncate">{dashboard.label}</h1>
          <p className="text-[12px] text-subtle">下钻明细 · 筛选条件与打开时的看板一致</p>
        </div>
        <a href={boardHref} className="h-8 px-3 rounded-lg border border-line text-[12.5px] text-fg-2 hover:text-primary hover:border-primary flex items-center gap-1.5">
          <ExternalLink className="w-3.5 h-3.5" />
          回到看板
        </a>
      </div>
      <DrillPanel
        panel={panel}
        onChange={change}
        filters={filters}
        filterDefs={filterDefs}
        filterText={filterText}
        queries={dashboard.queries}
        variant="page"
        onOpenTab={(stack) => window.open(drillPagePath(toDrillLink(link.agentKey, openPanel(panel.card, stack), filters)), '_blank', 'noopener')}
      />
    </div>
  )
}
