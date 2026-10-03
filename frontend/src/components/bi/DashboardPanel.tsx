/**
 * Agent 关联的 BI 看板：全局筛选条 + 12 列栅格卡片（手机单列，KPI 两列）。
 * 每张卡片独立并行取数，谁先回来谁先画；一张失败不影响其它。
 *
 * 点中卡片元素时调用 onPick（由上层决定显示点击浮层 / 直接下钻）。
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { initialFilterValues, type BiDashboard, type BiFilter, type BiFilterValues, type BiScalar } from '../../utils/bi'
import type { BiPick } from '../../utils/biContext'
import BiCardView from './BiCardView'

interface Props {
  agentKey: string
  pcMode: boolean
  onPick?: (pick: BiPick, ctx: { dashboard: BiDashboard; filters: BiFilterValues }) => void
}

type LoadState = { key: string; dashboard?: BiDashboard; error?: string; filters?: BiFilterValues }

export default function DashboardPanel({ agentKey, pcMode, onPick }: Props) {
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

  const dashboard = state.dashboard
  const span = (w: number, type: string) => (pcMode ? w : type === 'kpi' ? 6 : 12)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-display text-[16px] font-semibold text-fg">{dashboard.label}</h2>
          {dashboard.description && <p className="text-[12px] text-subtle mt-0.5">{dashboard.description}</p>}
        </div>
        {dashboard.filters.length > 0 && (
          <div className="flex items-end gap-2 flex-wrap" role="group" aria-label="看板筛选">
            {dashboard.filters.map((f) => (
              <FilterInput key={f.name} filter={f} value={filters[f.name] ?? null} onChange={(v) => setFilters((cur) => ({ ...cur, [f.name]: v }))} />
            ))}
          </div>
        )}
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
                <BiCardView card={card} filters={filters} queries={dashboard.queries} onPick={onPick ? (p) => onPick(p, { dashboard, filters }) : undefined} />
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

function FilterInput({ filter, value, onChange }: { filter: BiFilter; value: BiScalar; onChange: (v: BiScalar) => void }) {
  const id = `bi-filter-${filter.name}`
  const cls = 'h-8 px-2.5 rounded-lg border border-line bg-surface text-[12.5px] text-fg-2 focus:outline-none focus:border-primary'
  let control: React.ReactNode
  if (filter.type === 'select') {
    control = (
      <select id={id} className={cls} value={value == null ? '' : String(value)} onChange={(e) => {
        const opt = filter.options?.find((o) => String(o.value) === e.target.value)
        onChange(opt ? opt.value : e.target.value)
      }}>
        {filter.options?.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    )
  } else if (filter.type === 'month' || filter.type === 'date') {
    control = (
      <input id={id} type={filter.type} className={cls} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value || null)} />
    )
  } else {
    // 文本：回车或失焦才生效，避免每个字都触发全部卡片重查
    control = <TextFilter id={id} className={cls} value={value} onCommit={onChange} />
  }
  return (
    <label htmlFor={id} className="flex flex-col gap-0.5">
      <span className="text-[11px] text-subtle">{filter.label}</span>
      {control}
    </label>
  )
}

function TextFilter({ id, className, value, onCommit }: { id: string; className: string; value: BiScalar; onCommit: (v: BiScalar) => void }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const commit = () => {
    const v = draft.trim() || null
    if (v !== value) onCommit(v)
  }
  return (
    <input
      id={id}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}
