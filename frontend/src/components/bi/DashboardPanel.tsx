/**
 * Agent 关联的 BI 看板：全局筛选条 + 12 列栅格卡片（手机单列，KPI 两列）。
 * 每张卡片独立并行取数，谁先回来谁先画；一张失败不影响其它。
 *
 * 点中卡片元素时调用 onPick（由上层决定显示点击浮层 / 直接下钻）。
 * 下钻到配成「明细面板」的一级时打开 DrillPanel（PC 右侧抽屉，可并排；手机全屏面板），
 * 位置写进地址 ?drill=（刷新恢复、返回键先关面板），也可在新标签页打开（/bi/drill）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DatePicker, SelectPicker } from '../../ui/pickers'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { openHistoryOverlay, type OverlayHandle } from '../../router'
import { filterDisplayText, initialFilterValues, type BiCard, type BiDashboard, type BiFilter, type BiFilterValues, type BiOption, type BiValue } from '../../utils/bi'
import type { BiPick } from '../../utils/biContext'
import {
  DRILL_PARAM,
  decodeDrillLink,
  drillPagePath,
  encodeDrillLink,
  openPanel,
  panelFromLink,
  toDrillLink,
  type DrillFrame,
  type DrillPanelState,
} from '../../utils/biDrill'
import { enterLandscape } from '../../utils/landscape'
import { useFilterOptions } from '../../utils/biOptions'
import BiCardView from './BiCardView'
import LandscapeViewer from './LandscapeViewer'
import DrillPanel, { DRAWER_MIN_W } from './DrillPanel'
import MultiSelect from './MultiSelect'

interface Props {
  agentKey: string
  pcMode: boolean
  onPick?: (pick: BiPick, ctx: { dashboard: BiDashboard; filters: BiFilterValues }) => void
  /** 标题行右侧的附加按钮（如全屏切换） */
  actions?: React.ReactNode
  /** PC：明细抽屉挂到这个容器里（只盖住看板这一栏）；容器须 position: relative、与看板滚动区同为 flex 行 */
  panelHost?: HTMLElement | null
}

type LoadState = { key: string; dashboard?: BiDashboard; error?: string; filters?: BiFilterValues; restore?: DrillPanelState }

/** 地址上的 ?drill=（刷新、从新标签页「回到看板」）：还原出面板与筛选；对不上本看板返回 null */
function restoreFromUrl(agentKey: string, dashboard: BiDashboard, filters: BiFilterValues): { panel: DrillPanelState; filters: BiFilterValues } | null {
  const link = decodeDrillLink(new URLSearchParams(window.location.search).get(DRILL_PARAM))
  if (!link || link.agentKey !== agentKey) return null
  const card = dashboard.cards.find((c) => c.id === link.cardId)
  const panel = card ? panelFromLink(card, link) : null
  if (!panel) return null
  const known = new Set((dashboard.filters || []).map((f) => f.name))
  const next = { ...filters }
  for (const [k, v] of Object.entries(link.filters)) if (known.has(k)) next[k] = v
  return { panel, filters: next }
}

export default function DashboardPanel({ agentKey, pcMode, onPick, actions, panelHost }: Props) {
  const [state, setState] = useState<LoadState | null>(null)
  const [filters, setFilters] = useState<BiFilterValues>({})

  useEffect(() => {
    let alive = true
    apiFetch(`/agents/${encodeURIComponent(agentKey)}/dashboard`)
      .then((d: { dashboard: BiDashboard }) => {
        if (!alive) return
        const initial = initialFilterValues(d.dashboard.filters || [])
        const restored = restoreFromUrl(agentKey, d.dashboard, initial)
        setState({ key: agentKey, dashboard: d.dashboard, restore: restored?.panel })
        setFilters(restored?.filters ?? initial)
      })
      .catch((err: unknown) => alive && setState({ key: agentKey, error: err instanceof Error ? err.message : '看板加载失败' }))
    return () => {
      alive = false
    }
  }, [agentKey])

  if (!state || state.key !== agentKey) {
    return (
      <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-subtle">
        <Loader2 className="w-4 h-4 animate-spin" />
        看板加载中…
      </div>
    )
  }
  if (state.error || !state.dashboard) {
    return <div className="rounded-xl bg-danger-soft border border-danger/25 text-danger text-[13px] p-4">{state.error || '看板不可用'}</div>
  }

  return (
    <DashboardView
      key={state.key}
      dashboard={state.dashboard}
      pcMode={pcMode}
      onPick={onPick}
      filters={filters}
      onFiltersChange={setFilters}
      actions={actions}
      drillLinkKey={agentKey}
      panelHost={panelHost}
      initialPanel={state.restore}
    />
  )
}

// ─── 明细面板偏好（本机）──────────────────────────────────────────────────────

const PANEL_W_KEY = 'bi_drill_panel_w'
const PANEL_SPLIT_KEY = 'bi_drill_panel_split'

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* 存不了就只在本次有效 */
  }
}

/**
 * 明细面板状态 + 历史条目：打开时占一条历史（返回键先关面板），内容变化时更新地址上的 ?drill=。
 * linkKey 为空（管理端预览）时不写地址。
 */
function useDrillPanel(linkKey: string | undefined, filters: BiFilterValues, initial?: DrillPanelState) {
  const [panel, setPanel] = useState<DrillPanelState | null>(initial ?? null)
  const handleRef = useRef<OverlayHandle | null>(null)
  const search = useCallback((p: DrillPanelState) => (linkKey ? `?${DRILL_PARAM}=${encodeDrillLink(toDrillLink(linkKey, p, filters))}` : ''), [linkKey, filters])
  const onBack = useCallback(() => {
    // 浏览器后退 / 安卓返回键
    handleRef.current = null
    setPanel(null)
  }, [])

  const show = useCallback(
    (p: DrillPanelState) => {
      setPanel(p)
      if (!linkKey) return
      if (handleRef.current) handleRef.current.update(search(p))
      else {
        handleRef.current = openHistoryOverlay(search(p), onBack)
      }
    },
    [linkKey, search, onBack],
  )
  const close = useCallback(() => {
    handleRef.current?.close()
    handleRef.current = null
    setPanel(null)
  }, [])

  // 筛选变了：地址跟着更新（面板内容按新筛选重查）
  useEffect(() => {
    if (panel && handleRef.current) handleRef.current.update(search(panel))
  }, [panel, search])

  // 卸载（换 Agent）时退掉历史条目；推迟一拍，StrictMode 开发时的「卸载 → 立即重新挂载」不算
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    // 从地址恢复的面板：补上历史条目（返回键先关面板）
    if (panel && linkKey && !handleRef.current) handleRef.current = openHistoryOverlay(search(panel), onBack)
    return () => {
      mounted.current = false
      setTimeout(() => {
        if (mounted.current) return
        handleRef.current?.close()
        handleRef.current = null
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { panel, show, close }
}

/**
 * 看板渲染（筛选条 + 栅格卡片）。Agent 运行页与管理端预览共用；
 * 管理端传入草稿看板（queries 为公开元数据），卡片照常经 /bi/query 取真实数据。
 */
export function DashboardView({
  dashboard,
  pcMode,
  onPick,
  filters: controlled,
  onFiltersChange,
  showHeader = true,
  actions,
  drillLinkKey,
  panelHost,
  initialPanel,
}: {
  dashboard: BiDashboard
  pcMode: boolean
  onPick?: Props['onPick']
  /** 受控筛选值（Agent 运行页）；不传则组件内部按默认值管理（管理端预览） */
  filters?: BiFilterValues
  onFiltersChange?: (f: BiFilterValues) => void
  showHeader?: boolean
  actions?: React.ReactNode
  /** Agent 标识：明细面板写地址 ?drill=、可在新标签页打开；不传（管理端预览）则都不做 */
  drillLinkKey?: string
  panelHost?: HTMLElement | null
  /** 从地址 ?drill= 还原的面板（DashboardPanel 加载看板时解析） */
  initialPanel?: DrillPanelState
}) {
  const [localFilters, setLocalFilters] = useState<BiFilterValues>(() => initialFilterValues(dashboard.filters || []))
  const filters = controlled ?? localFilters
  const setFilters = (next: BiFilterValues) => {
    setLocalFilters(next)
    onFiltersChange?.(next)
  }
  const setFilter = (name: string, v: BiValue) => setFilters({ ...filters, [name]: v })
  const filterOptions = useFilterOptions(dashboard.filters || [])
  const filterText = useMemo(() => filterDisplayText(dashboard.filters || [], filters, filterOptions.loaded), [dashboard.filters, filters, filterOptions.loaded])

  // ── 明细面板 ──
  const { panel, show: showPanel, close: closePanel } = useDrillPanel(drillLinkKey, filters, initialPanel)
  const [split, setSplit] = useState(() => readPref(PANEL_SPLIT_KEY) === '1')
  const [panelWidth, setPanelWidth] = useState(() => {
    const w = Number(readPref(PANEL_W_KEY))
    return Number.isFinite(w) && w >= DRAWER_MIN_W ? w : null
  })
  const toggleSplit = () => {
    setSplit((v) => {
      writePref(PANEL_SPLIT_KEY, v ? '0' : '1')
      return !v
    })
  }
  const resizePanel = (w: number) => {
    setPanelWidth(w)
    writePref(PANEL_W_KEY, String(w))
  }
  // 默认宽度：看板这一栏的 55%（宿主本身可能是 display: contents，取它的父元素）
  const hostWidth = panelHost ? panelHost.offsetWidth || panelHost.parentElement?.clientWidth || 0 : window.innerWidth
  const wanted = panelWidth ?? Math.round(hostWidth * 0.55)
  // 窗口变窄后，存下的宽度也要给看板留出至少 320px
  const drawerWidth = Math.max(DRAWER_MIN_W, hostWidth > 0 ? Math.min(wanted, hostWidth - 320) : wanted)

  const openTab = (card: BiCard, stack: DrillFrame[]) => {
    if (!drillLinkKey) return
    window.open(drillPagePath(toDrillLink(drillLinkKey, openPanel(card, stack), filters)), '_blank', 'noopener')
  }


  // ── 手机全屏：横屏查看器，左右滑动切换图表 / 表格卡片 ──
  const [landscapeId, setLandscapeId] = useState<string | null>(null)
  const swipeCards = useMemo(() => dashboard.cards.filter((c) => c.type !== 'kpi'), [dashboard.cards])
  const openLandscape = (cardId: string) => {
    enterLandscape() // 须在点击回调里同步调用
    setLandscapeId(cardId)
  }

  const splitOn = pcMode && split && !!panel && !!panelHost
  // 并排时看板变窄：KPI 两个一行，其余半宽以上的卡片占满一行
  const span = (w: number, type: string) => (!pcMode ? (type === 'kpi' ? 6 : 12) : splitOn ? (type === 'kpi' ? 6 : w >= 6 ? 12 : 6) : w)
  const pick = onPick ? (p: BiPick) => onPick(p, { dashboard, filters }) : undefined

  const panelEl = panel ? (
    <DrillPanel
      key={panel.card.id}
      panel={panel}
      onChange={showPanel}
      onClose={closePanel}
      filters={filters}
      filterDefs={dashboard.filters || []}
      filterText={filterText}
      queries={dashboard.queries}
      variant={pcMode ? 'drawer' : 'sheet'}
      split={splitOn}
      onToggleSplit={panelHost ? toggleSplit : undefined}
      fixed={!panelHost}
      width={drawerWidth}
      onResize={resizePanel}
      onPick={pick}
      onOpenTab={pcMode && drillLinkKey ? (stack) => openTab(panel.card, stack) : undefined}
    />
  ) : null

  const cardProps = (card: BiCard) => ({
    card,
    filters,
    queries: dashboard.queries,
    filterText,
    onPick: pick,
    onOpenPanel: onPick ? (stack: DrillFrame[]) => showPanel(openPanel(card, stack)) : undefined,
    onOpenTab: pcMode && drillLinkKey ? (stack: DrillFrame[]) => openTab(card, stack) : undefined,
    selectedRow: panel?.card.id === card.id ? (panel.stack[panel.base]?.fromRow ?? null) : null,
  })

  return (
    <div className="flex flex-col gap-4">
      {landscapeId && !pcMode && (
        <LandscapeViewer
          cards={swipeCards}
          startId={landscapeId}
          onClose={() => setLandscapeId(null)}
          renderCard={(card) => <BiCardView {...cardProps(card)} embedded={{ onExit: () => setLandscapeId(null) }} />}
        />
      )}
      {panelEl && (pcMode && panelHost ? createPortal(panelEl, panelHost) : panelEl)}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        {showHeader ? (
          <div className="min-w-0">
            <h2 className="font-display text-[16px] font-semibold text-fg">{dashboard.label}</h2>
            {dashboard.description && <p className="text-[12px] text-subtle mt-0.5">{dashboard.description}</p>}
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-end gap-2 flex-wrap">
          <FilterBar filters={dashboard.filters} values={filters} onChange={setFilter} loaded={filterOptions} />
          {actions}
        </div>
      </div>

      {dashboard.cards.length === 0 ? (
        <p className="text-[13px] text-subtle py-10 text-center">看板暂无可显示的卡片</p>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
          {dashboard.cards.map((card) => (
            <div
              key={card.id}
              style={{ gridColumn: `span ${span(card.layout.w, card.type)} / span ${span(card.layout.w, card.type)}`, alignSelf: card.type === 'kpi' ? 'start' : undefined }}
              className="min-w-0 flex"
            >
              {/* 图表/表格撑满行高对齐；KPI 不拉伸，避免与同行图表等高留下大片空白 */}
              <div className={`flex-1 min-w-0 flex flex-col ${card.type === 'kpi' ? '' : '[&>section]:flex-1'}`}>
                <BiCardView {...cardProps(card)} onRequestFullscreen={pcMode ? undefined : () => openLandscape(card.id)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {dashboard.hiddenCards > 0 && (
        <p className="text-[11px] text-subtle">另有 {dashboard.hiddenCards} 张卡片因权限未显示</p>
      )}
    </div>
  )
}

/** 看板筛选条（Agent 看板与管理端画布共用）；loaded：来自查询的选项（useFilterOptions） */
export function FilterBar({
  filters,
  values,
  onChange,
  loaded,
}: {
  filters: BiFilter[]
  values: BiFilterValues
  onChange: (name: string, v: BiValue) => void
  loaded: { loaded: Record<string, BiOption[]>; errors: Record<string, string> }
}) {
  if (filters.length === 0) return null
  return (
    <div className="flex items-end gap-2 flex-wrap" role="group" aria-label="看板筛选">
      {filters.map((f) => (
        <FilterInput
          key={f.name}
          filter={f}
          value={values[f.name] ?? null}
          options={f.options?.length ? f.options : loaded.loaded[f.name]}
          optionsError={loaded.errors[f.name]}
          onChange={(v) => onChange(f.name, v)}
        />
      ))}
    </div>
  )
}

function FilterInput({
  filter,
  value,
  options,
  optionsError,
  onChange,
}: {
  filter: BiFilter
  value: BiValue
  /** 固定选项或已取到的「来自查询」选项；undefined = 还在取 / 取不到 */
  options?: BiOption[]
  optionsError?: string
  onChange: (v: BiValue) => void
}) {
  const id = `bi-filter-${filter.name}`
  const cls = 'h-8 px-2.5 rounded-lg border border-line bg-surface text-[12.5px] text-fg-2 focus:outline-none focus:border-primary'
  const fromQuery = !filter.options?.length && !!filter.optionsQuery
  // 自绘下拉 / 日期框没有原生控件那样按最长选项撑开的宽度，给个下限
  const pickCls = `${cls} min-w-[8rem] max-w-[16rem]`
  let control: React.ReactNode
  if (filter.type === 'select' && fromQuery && !options) {
    // 来自查询的选项还没取到（或无权读取）：取不到时退回文本输入，多个值用逗号分隔
    control = optionsError ? (
      <TextFilter id={id} className={cls} value={Array.isArray(value) ? value.join(',') : value} onCommit={onChange} title={`选项加载失败：${optionsError}`} placeholder={filter.multiple ? '多个用逗号分隔' : undefined} />
    ) : (
      <SelectPicker id={id} className={pickCls} value="" options={[]} loading onChange={() => {}} />
    )
  } else if (filter.type === 'select' && filter.multiple) {
    control = <MultiSelect id={id} className={cls} title={filter.label} options={options || []} value={Array.isArray(value) ? value : value == null ? null : [String(value)]} onChange={onChange} />
  } else if (filter.type === 'select') {
    control = (
      <SelectPicker
        id={id}
        className={pickCls}
        value={value == null ? '' : String(value)}
        options={(options ?? []).map((o) => ({ value: String(o.value), label: o.label }))}
        // 来自查询的下拉：可不选（= 全部）；固定选项照旧必选其一
        emptyLabel={fromQuery ? '全部' : undefined}
        title={filter.label}
        onChange={(v) => {
          const opt = options?.find((o) => String(o.value) === v)
          onChange(opt ? opt.value : v || null)
        }}
      />
    )
  } else if (filter.type === 'year') {
    // 年份：近 10 年下拉；当前值不在范围内时也列出
    const now = new Date().getFullYear()
    const years = Array.from({ length: 10 }, (_, i) => String(now - i))
    const cur = value == null ? '' : String(value)
    if (cur && !years.includes(cur)) years.unshift(cur)
    control = (
      <SelectPicker id={id} className={pickCls} value={cur} options={years.map((y) => ({ value: y, label: `${y} 年` }))} title={filter.label} onChange={(v) => onChange(v || null)} />
    )
  } else if (filter.type === 'month' || filter.type === 'date') {
    control = (
      <DatePicker id={id} mode={filter.type} className={pickCls} value={value == null ? '' : String(value)} title={filter.label} onChange={(v) => onChange(v || null)} />
    )
  } else {
    // 文本：回车或失焦才生效，避免每个字都触发全部卡片重查
    control = <TextFilter id={id} className={cls} value={Array.isArray(value) ? value.join(',') : value} onCommit={onChange} />
  }
  return (
    <label htmlFor={id} className="flex flex-col gap-0.5">
      <span className="text-[11px] text-subtle">{filter.label}</span>
      {control}
    </label>
  )
}

function TextFilter({ id, className, value, onCommit, title, placeholder }: { id: string; className: string; value: BiValue; onCommit: (v: BiValue) => void; title?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const commit = () => {
    const v = draft.trim() || null
    if (v !== value) onCommit(v)
  }
  return (
    <input
      id={id}
      className={className}
      title={title}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}
