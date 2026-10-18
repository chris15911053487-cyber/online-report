/**
 * Agent 关联的 BI 看板：全局筛选条 + 12 列栅格卡片（手机单列，KPI 两列）。
 * 每张卡片独立并行取数，谁先回来谁先画；一张失败不影响其它。
 *
 * 点中卡片元素时调用 onPick（由上层决定显示点击浮层 / 直接下钻）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { filterDisplayText, initialFilterValues, type BiDashboard, type BiFilter, type BiFilterValues, type BiOption, type BiValue } from '../../utils/bi'
import type { BiPick } from '../../utils/biContext'
import { useFilterOptions } from '../../utils/biOptions'
import BiCardView from './BiCardView'
import MultiSelect from './MultiSelect'

interface Props {
  agentKey: string
  pcMode: boolean
  onPick?: (pick: BiPick, ctx: { dashboard: BiDashboard; filters: BiFilterValues }) => void
  /** 标题行右侧的附加按钮（如全屏切换） */
  actions?: React.ReactNode
}

type LoadState = { key: string; dashboard?: BiDashboard; error?: string; filters?: BiFilterValues }

export default function DashboardPanel({ agentKey, pcMode, onPick, actions }: Props) {
  const [state, setState] = useState<LoadState | null>(null)
  const [filters, setFilters] = useState<BiFilterValues>({})

  useEffect(() => {
    let alive = true
    apiFetch(`/agents/${encodeURIComponent(agentKey)}/dashboard`)
      .then((d: { dashboard: BiDashboard }) => {
        if (!alive) return
        setState({ key: agentKey, dashboard: d.dashboard })
        setFilters(initialFilterValues(d.dashboard.filters || []))
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

  return <DashboardView dashboard={state.dashboard} pcMode={pcMode} onPick={onPick} filters={filters} onFiltersChange={setFilters} actions={actions} />
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
}: {
  dashboard: BiDashboard
  pcMode: boolean
  onPick?: Props['onPick']
  /** 受控筛选值（Agent 运行页）；不传则组件内部按默认值管理（管理端预览） */
  filters?: BiFilterValues
  onFiltersChange?: (f: BiFilterValues) => void
  showHeader?: boolean
  actions?: React.ReactNode
}) {
  const [localFilters, setLocalFilters] = useState<BiFilterValues>(() => initialFilterValues(dashboard.filters || []))
  const filters = controlled ?? localFilters
  const setFilter = (name: string, v: BiValue) => {
    const next = { ...filters, [name]: v }
    setLocalFilters(next)
    onFiltersChange?.(next)
  }
  const span = (w: number, type: string) => (pcMode ? w : type === 'kpi' ? 6 : 12)
  const filterOptions = useFilterOptions(dashboard.filters || [])
  const filterText = useMemo(() => filterDisplayText(dashboard.filters || [], filters, filterOptions.loaded), [dashboard.filters, filters, filterOptions.loaded])

  return (
    <div className="flex flex-col gap-4">
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
                <BiCardView card={card} filters={filters} queries={dashboard.queries} filterText={filterText} onPick={onPick ? (p) => onPick(p, { dashboard, filters }) : undefined} />
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
  let control: React.ReactNode
  if (filter.type === 'select' && fromQuery && !options) {
    // 来自查询的选项还没取到（或无权读取）：取不到时退回文本输入，多个值用逗号分隔
    control = optionsError ? (
      <TextFilter id={id} className={cls} value={Array.isArray(value) ? value.join(',') : value} onCommit={onChange} title={`选项加载失败：${optionsError}`} placeholder={filter.multiple ? '多个用逗号分隔' : undefined} />
    ) : (
      <select id={id} className={cls} disabled>
        <option>加载中…</option>
      </select>
    )
  } else if (filter.type === 'select' && filter.multiple) {
    control = <MultiSelect id={id} className={cls} options={options || []} value={Array.isArray(value) ? value : value == null ? null : [String(value)]} onChange={onChange} />
  } else if (filter.type === 'select') {
    control = (
      <select id={id} className={cls} value={value == null ? '' : String(value)} onChange={(e) => {
        const opt = options?.find((o) => String(o.value) === e.target.value)
        onChange(opt ? opt.value : e.target.value || null)
      }}>
        {/* 来自查询的下拉：可不选（= 全部）；固定选项照旧必选其一 */}
        {fromQuery && <option value="">全部</option>}
        {options?.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    )
  } else if (filter.type === 'year') {
    // 年份：近 10 年下拉；当前值不在范围内时也列出
    const now = new Date().getFullYear()
    const years = Array.from({ length: 10 }, (_, i) => String(now - i))
    const cur = value == null ? '' : String(value)
    if (cur && !years.includes(cur)) years.unshift(cur)
    control = (
      <select id={id} className={cls} value={cur} onChange={(e) => onChange(e.target.value || null)}>
        {years.map((y) => (
          <option key={y} value={y}>{y} 年</option>
        ))}
      </select>
    )
  } else if (filter.type === 'month' || filter.type === 'date') {
    control = (
      <input id={id} type={filter.type} className={cls} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value || null)} />
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
