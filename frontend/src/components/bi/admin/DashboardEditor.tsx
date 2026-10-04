/**
 * 看板编辑器：基本信息 + 全局筛选（表格）+ 看板画布（真实排版与数据，拖动换位置 / 改宽高）+ 右侧卡片设置。
 *
 * - 卡片 = 从图表库选一张图表；图表的参数默认由同名筛选自动提供，需要时再覆盖（筛选 / 固定值）、改标题与尺寸
 * - 筛选可从图表查询的参数一键生成；改名 / 删除同步更新卡片里的覆盖引用
 * - 每张卡片展开后实时检查引用完整性（与后端同规则），有问题的卡片在列表里标出，保存前拦截
 * - 预览用真实数据（POST /bi/query，管理员不受查询角色限制）
 * - 高级：JSON 模式，与表单双向切换
 */
import { useMemo, useState } from 'react'
import { Plus, Sparkles, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { useStore } from '../../../store'
import { apiFetch } from '../../../utils/api'
import { parseJsonField, toJsonText, type BiCard, type BiCardRef, type BiCardType, type BiChartDef, type BiFilter, type BiQueryMeta, type BiScalar } from '../../../utils/bi'
import { effectiveSource, filterFromParam, nextRefId, refProblems, renameFilterRefs, resolveCard, suggestFilterParams, type QueryRef } from '../../../utils/biAdmin'
import { AdminPage, Badge, Button, Card, Checkbox, EditorActions, EmptyState, Field, IconButton, Input, JsonField, Notice, Section, Segmented, Textarea } from '../../../ui'
import { cn, compactInputClass, tableClass, tdClass, thClass } from '../../../ui/classes'
import DashboardCanvas from './DashboardCanvas'
import { errMsg, type BiDashboardAdmin, type QueryOption } from './types'

const TYPE_LABEL: Record<BiCardType, string> = { kpi: 'KPI', bar: '柱状', line: '折线', pie: '饼图', table: '表格' }
const FILTER_TYPES: { value: BiFilter['type']; label: string }[] = [
  { value: 'month', label: '月份' },
  { value: 'date', label: '日期' },
  { value: 'select', label: '下拉' },
  { value: 'string', label: '文本' },
]
const DEFAULT_TOKENS: Record<string, { value: string; label: string }[]> = {
  month: [
    { value: '$thisMonth', label: '本月' },
    { value: '$lastMonth', label: '上月' },
  ],
  date: [
    { value: '$today', label: '今天' },
    { value: '$yesterday', label: '昨天' },
    { value: '$monthStart', label: '本月 1 日' },
    { value: '$yearStart', label: '今年 1 月 1 日' },
  ],
}
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** select 筛选的选项 ⇄ 文本（每行「值=显示名」） */
const optionsToText = (f: BiFilter) => (f.options || []).map((o) => (String(o.value) === o.label ? o.label : `${o.value}=${o.label}`)).join('\n')
function textToOptions(text: string): BiFilter['options'] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('=')
      return i > 0 ? { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() } : { value: l, label: l }
    })
}

// ─── 全局筛选 ────────────────────────────────────────────────────────────────

function FiltersEditor({
  filters,
  suggestions,
  onChange,
  onAddFromParam,
  onRename,
  onRemove,
}: {
  filters: BiFilter[]
  suggestions: { name: string; label?: string; required?: boolean }[]
  onChange: (f: BiFilter[]) => void
  onAddFromParam: (name: string) => void
  onRename: (from: string, to: string) => void
  onRemove: (name: string) => void
}) {
  const patch = (i: number, p: Partial<BiFilter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...p } : f)))
  return (
    <div className="flex flex-col gap-3">
      {suggestions.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-[12.5px]">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <span className="text-muted">图表需要的参数，建议建成筛选：</span>
          {suggestions.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => onAddFromParam(p.name)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary-soft text-primary hover:bg-primary hover:text-primary-fg transition-colors"
            >
              <Plus className="w-3 h-3" />
              {p.label || p.name}
              {p.required && <span title="必填参数">*</span>}
            </button>
          ))}
        </div>
      )}
      {filters.length === 0 ? (
        <p className="text-[13px] text-subtle">暂无筛选。图表参数可以在图表里写固定值，或在卡片上覆盖。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>名称（参数名）</th>
                <th className={thClass}>显示名</th>
                <th className={thClass}>类型</th>
                <th className={thClass}>默认值 / 选项</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {filters.map((f, i) => {
                const tokens = DEFAULT_TOKENS[f.type]
                const isToken = typeof f.default === 'string' && f.default.startsWith('$')
                return (
                  <tr key={i} className="align-top">
                    <td className={tdClass}>
                      <input
                        className={cn(compactInputClass, 'font-mono', !NAME_RE.test(f.name) && 'border-danger')}
                        aria-label="筛选名称"
                        defaultValue={f.name}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v !== f.name) onRename(f.name, v)
                        }}
                      />
                    </td>
                    <td className={tdClass}>
                      <input className={compactInputClass} aria-label="筛选显示名" value={f.label} onChange={(e) => patch(i, { label: e.target.value })} />
                    </td>
                    <td className={tdClass}>
                      <select
                        className={compactInputClass}
                        aria-label="筛选类型"
                        value={f.type}
                        onChange={(e) => {
                          const type = e.target.value as BiFilter['type']
                          patch(i, { type, default: DEFAULT_TOKENS[type]?.[0]?.value, options: type === 'select' ? (f.options ?? []) : undefined })
                        }}
                      >
                        {FILTER_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={tdClass + ' min-w-[14rem]'}>
                      {f.type === 'select' ? (
                        <textarea
                          className={compactInputClass + ' h-auto py-1.5'}
                          rows={3}
                          aria-label="下拉选项"
                          placeholder={'每行一个：值=显示名\nWH01=一号仓'}
                          defaultValue={optionsToText(f)}
                          onBlur={(e) => patch(i, { options: textToOptions(e.target.value) })}
                        />
                      ) : tokens ? (
                        <div className="flex gap-2">
                          <select
                            className={compactInputClass}
                            aria-label="默认值"
                            value={isToken ? String(f.default) : f.default == null || f.default === '' ? '' : 'custom'}
                            onChange={(e) => patch(i, { default: e.target.value === 'custom' ? '' : e.target.value || undefined })}
                          >
                            <option value="">无</option>
                            {tokens.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                            <option value="custom">指定…</option>
                          </select>
                          {!isToken && f.default != null && (
                            <input className={compactInputClass} type={f.type} aria-label="指定默认值" value={String(f.default)} onChange={(e) => patch(i, { default: e.target.value })} />
                          )}
                        </div>
                      ) : (
                        <input className={compactInputClass} aria-label="默认值" value={f.default == null ? '' : String(f.default)} placeholder="无" onChange={(e) => patch(i, { default: e.target.value || undefined })} />
                      )}
                    </td>
                    <td className={tdClass + ' w-8'}>
                      <IconButton label="删除筛选" className="hover:text-danger" onClick={() => onRemove(f.name)}>
                        <Trash2 className="w-4 h-4" />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


// ─── 卡片（图表引用）设置 ────────────────────────────────────────────────────

const WIDTHS = [
  { value: 3, label: '1/4' },
  { value: 4, label: '1/3' },
  { value: 6, label: '1/2' },
  { value: 8, label: '2/3' },
  { value: 9, label: '3/4' },
  { value: 12, label: '整行' },
]
const HEIGHTS = [
  { value: 1, label: '矮' },
  { value: 2, label: '中' },
  { value: 3, label: '高' },
  { value: 4, label: '很高' },
]

function ChartSelect({ charts, value, onChange, placeholder, ariaLabel }: { charts: BiChartDef[]; value: string; onChange: (k: string) => void; placeholder: string; ariaLabel: string }) {
  return (
    <select className={compactInputClass} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {value && !charts.some((c) => c.chartKey === value) && <option value={value}>{value}（不存在）</option>}
      {charts.map((c) => (
        <option key={c.chartKey} value={c.chartKey}>
          {TYPE_LABEL[c.type]} · {c.label}（{c.chartKey}）{c.enabled ? '' : ' · 已停用'}
        </option>
      ))}
    </select>
  )
}

/** 一张卡片的参数来源：默认显示自动结果（同名筛选 / 图表固定值 / 查询默认），可覆盖为筛选或固定值 */
function ParamOverrides({ cardRef, chart, query, filters, onChange }: { cardRef: BiCardRef; chart: BiChartDef; query: QueryOption; filters: BiFilter[]; onChange: (params: Record<string, BiScalar> | undefined) => void }) {
  if (query.params.length === 0) return <p className="text-[12px] text-subtle">图表的查询没有参数</p>
  const params = cardRef.params || {}
  const setOverride = (name: string, v: BiScalar | undefined) => {
    const next = Object.fromEntries(Object.entries(params).filter(([k]) => k.toLowerCase() !== name.toLowerCase()))
    if (v !== undefined) next[name] = v
    onChange(Object.keys(next).length ? next : undefined)
  }
  return (
    <div className="flex flex-col gap-2">
      {query.params.map((p) => {
        const src = effectiveSource(p, cardRef, chart, filters)
        const autoLabel = (() => {
          const s = effectiveSource(p, { ...cardRef, params: undefined }, chart, filters)
          if (s.kind === 'filter') return `自动：筛选「${filters.find((f) => f.name === s.filter)?.label || s.filter}」`
          if (s.kind === 'fixed') return `自动：图表固定值 ${String(s.value)}`
          if (s.kind === 'default') return `自动：查询默认值 ${String(s.value)}`
          return p.required ? '自动：无来源（必填！）' : '自动：不传'
        })()
        const ov = src.kind === 'override' ? src.value : undefined
        const key = ov === undefined ? 'auto' : typeof ov === 'string' && ov.startsWith('$filter.') ? `filter:${ov.slice(8)}` : 'fixed'
        return (
          <div key={p.name} className="grid grid-cols-[6rem_minmax(0,2fr)_minmax(0,1fr)] items-center gap-2">
            <span className="text-[12.5px] text-fg-2 truncate" title={p.name}>
              {p.label || p.name}
              {p.required && p.default == null && <span className="text-danger"> *</span>}
            </span>
            <select
              className={cn(compactInputClass, src.kind === 'none' && p.required && p.default == null && 'border-danger')}
              aria-label={`参数 ${p.name} 来源`}
              value={key}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'auto') setOverride(p.name, undefined)
                else if (v === 'fixed') setOverride(p.name, '')
                else setOverride(p.name, `$filter.${v.slice(7)}`)
              }}
            >
              <option value="auto">{autoLabel}</option>
              {filters.length > 0 && (
                <optgroup label="改用筛选">
                  {filters.map((f) => (
                    <option key={f.name} value={`filter:${f.name}`}>
                      筛选：{f.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {key.startsWith('filter:') && !filters.some((f) => `filter:${f.name}` === key) && <option value={key}>筛选：{key.slice(7)}（不存在）</option>}
              <option value="fixed">固定值</option>
            </select>
            {key === 'fixed' ? (
              <input
                className={compactInputClass}
                aria-label={`参数 ${p.name} 固定值`}
                value={ov == null ? '' : String(ov)}
                onChange={(e) => setOverride(p.name, p.type === 'number' && e.target.value !== '' && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value)}
              />
            ) : (
              <span className="text-[11px] text-subtle font-mono truncate">@{p.name}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CardRefEditor({
  cardRef,
  charts,
  chart,
  query,
  filters,
  problems,
  onChange,
}: {
  cardRef: BiCardRef
  charts: BiChartDef[]
  chart?: BiChartDef
  query?: QueryOption
  filters: BiFilter[]
  problems: string[]
  onChange: (r: BiCardRef) => void
}) {
  const size = cardRef.layout || chart?.size || { w: 6, h: 2 }
  return (
    <div className="flex flex-col gap-3">
      {problems.length > 0 && (
        <Notice tone="warning">
          <ul className="list-disc pl-5 space-y-0.5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}
      <Field label="图表" hint={chart?.description || (chart ? `查询：${query?.label || chart.queryKey}` : '图表在「② 图表」页签里维护')}>
        <ChartSelect
          ariaLabel="卡片图表"
          charts={charts}
          value={cardRef.chartKey}
          placeholder="请选择图表…"
          onChange={(k) => {
            const c = charts.find((x) => x.chartKey === k)
            onChange({ id: cardRef.id, chartKey: k, layout: c ? { ...c.size } : cardRef.layout })
          }}
        />
      </Field>
      {chart && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="标题" hint="不填用图表标题">
              <Input value={cardRef.title || ''} placeholder={chart.label} onChange={(e) => onChange({ ...cardRef, title: e.target.value || undefined })} />
            </Field>
            <Field label="宽度 / 高度">
              <div className="grid grid-cols-2 gap-2">
                <select className={compactInputClass} aria-label="宽度" value={size.w} onChange={(e) => onChange({ ...cardRef, layout: { ...size, w: Number(e.target.value) } })}>
                  {!WIDTHS.some((w) => w.value === size.w) && <option value={size.w}>{size.w}/12</option>}
                  {WIDTHS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
                <select className={compactInputClass} aria-label="高度" value={size.h} disabled={chart.type === 'kpi'} onChange={(e) => onChange({ ...cardRef, layout: { ...size, h: Number(e.target.value) } })}>
                  {HEIGHTS.map((h) => (
                    <option key={h.value} value={h.value}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
          {query && (
            <div className="flex flex-col gap-2">
              <h4 className="text-[12px] font-semibold text-muted">参数来源（默认自动按同名筛选，一般不用改）</h4>
              <ParamOverrides cardRef={cardRef} chart={chart} query={query} filters={filters} onChange={(params) => onChange({ ...cardRef, params })} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── 主编辑器 ────────────────────────────────────────────────────────────────

export default function DashboardEditor({
  initial,
  isNew,
  availableCharts,
  availableQueries,
  onDone,
}: {
  initial: BiDashboardAdmin
  isNew: boolean
  availableCharts: BiChartDef[]
  availableQueries: QueryOption[]
  onDone: (changed: boolean) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [d, setD] = useState<BiDashboardAdmin>(initial)
  const [selected, setSelected] = useState(0)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [json, setJson] = useState({ filters: '', cards: '' })
  const patch = (p: Partial<BiDashboardAdmin>) => setD((cur) => ({ ...cur, ...p }))

  const queryMap = useMemo(() => new Map<string, QueryRef>(availableQueries.map((q) => [q.queryKey, q])), [availableQueries])
  const chartMap = useMemo(() => new Map(availableCharts.map((c) => [c.chartKey, c])), [availableCharts])
  const problems = useMemo(() => d.cards.map((r) => refProblems(r, chartMap.get(r.chartKey), d.filters, queryMap)), [d.cards, d.filters, chartMap, queryMap])
  // 展开后的卡片（预览、建议筛选用）；未选图表 / 图表不存在的为 null
  const expanded = useMemo(
    () => d.cards.map((r) => (chartMap.get(r.chartKey) ? resolveCard(r, chartMap.get(r.chartKey)!, d.filters, queryMap) : null)),
    [d.cards, d.filters, chartMap, queryMap],
  )
  const suggestions = useMemo(() => suggestFilterParams(expanded.filter((c): c is BiCard => !!c), queryMap, d.filters), [expanded, queryMap, d.filters])
  const ref = d.cards[selected]
  const refChart = ref ? chartMap.get(ref.chartKey) : undefined

  const previewQueries = useMemo(() => {
    const out: Record<string, BiQueryMeta> = {}
    for (const q of availableQueries) out[q.queryKey] = q
    return out
  }, [availableQueries])

  // 卡片操作
  const setRef = (i: number, r: BiCardRef) => patch({ cards: d.cards.map((x, j) => (j === i ? r : x)) })
  const addChart = (chartKey: string) => {
    const c = chartMap.get(chartKey)
    if (!c) return
    const ref: BiCardRef = { id: nextRefId(chartKey, d.cards.map((x) => x.id)), chartKey, layout: { ...c.size } }
    // KPI 并排放在最前面那一排（排在已有的开头 KPI 之后）；其它追加到末尾
    let at = d.cards.length
    if (c.type === 'kpi') {
      at = d.cards.findIndex((r) => chartMap.get(r.chartKey)?.type !== 'kpi')
      if (at < 0) at = d.cards.length
    }
    const cards = [...d.cards]
    cards.splice(at, 0, ref)
    patch({ cards })
    setSelected(at)
  }
  const removeCard = (i: number) => {
    patch({ cards: d.cards.filter((_, j) => j !== i) })
    setSelected((s) => Math.max(0, Math.min(s, d.cards.length - 2)))
  }
  /** 把 from 移到插入位置 to（to 按移除前的下标计） */
  const moveTo = (from: number, to: number) => {
    const cards = [...d.cards]
    const [x] = cards.splice(from, 1)
    const at = to > from ? to - 1 : to
    cards.splice(at, 0, x)
    patch({ cards })
    setSelected(at)
  }
  const moveCard = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= d.cards.length) return
    moveTo(i, dir < 0 ? j : j + 1)
  }

  // 筛选操作（同名参数自动绑定；改名 / 删除同步卡片里的覆盖）
  const addFilterFromParam = (name: string) => {
    const p = suggestions.find((x) => x.name === name)
    if (p) patch({ filters: [...d.filters, filterFromParam(p)] })
  }
  const renameFilter = (from: string, to: string) => {
    if (!NAME_RE.test(to)) return showToast('筛选名称须为字母或下划线开头，仅含字母、数字、下划线')
    if (d.filters.some((f) => f.name === to)) return showToast(`已有名为「${to}」的筛选`)
    setD((cur) => ({ ...cur, filters: cur.filters.map((f) => (f.name === from ? { ...f, name: to } : f)), cards: renameFilterRefs(cur.cards, from, to) }))
  }
  const removeFilter = (name: string) => setD((cur) => ({ ...cur, filters: cur.filters.filter((f) => f.name !== name), cards: renameFilterRefs(cur.cards, name, null) }))
  const addBlankFilter = () => {
    let n = 1
    while (d.filters.some((f) => f.name === `filter${n}`)) n += 1
    patch({ filters: [...d.filters, { name: `filter${n}`, label: '新筛选', type: 'string' }] })
  }

  // 表单 ⇄ JSON
  const parseJson = () => {
    const f = parseJsonField<BiFilter[]>(json.filters, '全局筛选', 'array')
    if (!f.ok) return f
    const c = parseJsonField<BiCardRef[]>(json.cards, '卡片', 'array')
    if (!c.ok) return c
    return { ok: true as const, filters: f.value, cards: c.value.map((x, i) => ({ ...x, id: x.id || nextRefId(x.chartKey || `card${i + 1}`, []) })) }
  }
  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return
    if (next === 'json') {
      setJson({ filters: toJsonText(d.filters), cards: toJsonText(d.cards) })
      setMode('json')
      return
    }
    const r = parseJson()
    if (!r.ok) return showToast(r.error)
    patch({ filters: r.filters, cards: r.cards })
    setSelected(0)
    setMode('form')
  }

  const save = async () => {
    let body: BiDashboardAdmin = d
    if (mode === 'json') {
      const r = parseJson()
      if (!r.ok) return showToast(r.error)
      body = { ...d, filters: r.filters, cards: r.cards }
    } else {
      const bad = problems.findIndex((p) => p.length > 0)
      if (bad >= 0) {
        setSelected(bad)
        return showToast(`卡片「${expanded[bad]?.title || d.cards[bad].id}」还有 ${problems[bad].length} 个问题`)
      }
    }
    setSaving(true)
    try {
      await apiFetch('/admin/bi/dashboards', {
        method: 'POST',
        body: JSON.stringify({ ...body, dashboardKey: body.dashboardKey.trim(), label: body.label.trim() }),
      })
      showToast('已保存')
      onDone(true)
    } catch (err) {
      showToast(errMsg(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const problemCount = problems.filter((p) => p.length > 0).length

  return (
    <AdminPage
      title={isNew ? '新增看板' : `编辑看板：${d.label || d.dashboardKey}`}
      description="看板只负责组合：选图表、设筛选、排版；在「Agent 配置」里关联到 Agent"
      onBack={() => onDone(false)}
      withActionBar
      actions={
        <Segmented
          size="sm"
          className="w-40"
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'form', label: '表单' },
            { value: 'json', label: 'JSON' },
          ]}
        />
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
        <Section title="基本信息">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="看板标识（dashboardKey）" hint={isNew ? '小写字母开头；创建后不可修改' : undefined}>
              <Input value={d.dashboardKey} disabled={!isNew} onChange={(e) => patch({ dashboardKey: e.target.value })} placeholder="sales" />
            </Field>
            <Field label="显示名称">
              <Input value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="销售经营看板" />
            </Field>
            <Field label="说明" className="sm:col-span-2">
              <Textarea rows={2} value={d.description} onChange={(e) => patch({ description: e.target.value })} />
            </Field>
            <Checkbox label="启用" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          </div>
        </Section>

        {mode === 'form' ? (
          <Section
            title="全局筛选"
            hint="看板顶部的筛选条。图表里与筛选同名的参数自动跟随筛选变化。"
            actions={
              <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} onClick={addBlankFilter}>
                添加筛选
              </Button>
            }
          >
            <FiltersEditor
              filters={d.filters}
              suggestions={suggestions}
              onChange={(filters) => patch({ filters })}
              onAddFromParam={addFilterFromParam}
              onRename={renameFilter}
              onRemove={removeFilter}
            />
          </Section>
        ) : (
          <Section title="全局筛选（JSON）">
            <JsonField label="筛选定义" expect="array" rows={8} value={json.filters} onChange={(v) => setJson((j) => ({ ...j, filters: v }))} />
          </Section>
        )}
      </div>

      {mode === 'json' ? (
        <Section title="卡片（JSON）" hint={'高级：每项 { "chartKey", "title"?, "params"?, "layout"? }。切回「表单」时会解析校验。'}>
          <JsonField label="卡片定义" expect="array" rows={20} value={json.cards} onChange={(v) => setJson((j) => ({ ...j, cards: v }))} />
        </Section>
      ) : (
        <Section
          title={
            <span>
              看板画布 <span className="text-subtle font-normal">{d.cards.length} 张卡片</span>
            </span>
          }
          hint="与 Agent 里看到的一致（真实数据）。拖 ⠿ 换位置，拖右边缘改宽度、下边缘改高度，点卡片在右侧设置。"
          actions={
            <div className="w-64">
              <ChartSelect ariaLabel="添加图表" charts={availableCharts} value="" placeholder="＋ 添加图表…" onChange={addChart} />
            </div>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
            {d.cards.length === 0 ? (
              <EmptyState title="还没有卡片" description={availableCharts.length ? '从右上角「添加图表」选图表放进来' : '图表库为空：请先到「② 图表」新增'} />
            ) : (
              <div className="min-w-0 pt-3">
                <DashboardCanvas
                  key={JSON.stringify(d.filters)}
                  refs={d.cards}
                  cards={expanded}
                  problems={problems}
                  filters={d.filters}
                  queries={previewQueries}
                  selected={selected}
                  onSelect={setSelected}
                  onMove={moveTo}
                  onResize={(i, layout) => setRef(i, { ...d.cards[i], layout })}
                  onRemove={removeCard}
                />
              </div>
            )}

            {/* 选中卡片的设置 */}
            <Card className="p-4 lg:sticky lg:top-20 flex flex-col gap-3">
              {ref ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-semibold text-fg truncate">{ref.title || refChart?.label || '未选图表'}</span>
                      <span className="block text-[11px] text-subtle font-mono truncate">{ref.id}</span>
                    </span>
                    <div className="flex items-center shrink-0">
                      <IconButton label="前移" disabled={selected === 0} onClick={() => moveCard(selected, -1)}>
                        <ArrowUp className="w-4 h-4" />
                      </IconButton>
                      <IconButton label="后移" disabled={selected === d.cards.length - 1} onClick={() => moveCard(selected, 1)}>
                        <ArrowDown className="w-4 h-4" />
                      </IconButton>
                      <IconButton label="从看板移除" className="hover:text-danger" onClick={() => removeCard(selected)}>
                        <Trash2 className="w-4 h-4" />
                      </IconButton>
                    </div>
                  </div>
                  <CardRefEditor
                    cardRef={ref}
                    charts={availableCharts}
                    chart={refChart}
                    query={refChart ? availableQueries.find((q) => q.queryKey === refChart.queryKey) : undefined}
                    filters={d.filters}
                    problems={problems[selected]}
                    onChange={(r) => setRef(selected, r)}
                  />
                </>
              ) : (
                <p className="text-[13px] text-subtle">点画布上的卡片进行设置</p>
              )}
            </Card>
          </div>
        </Section>
      )}

      <EditorActions
        onCancel={() => onDone(false)}
        onSave={() => void save()}
        saving={saving}
        leading={mode === 'form' && problemCount > 0 ? <Badge tone="warning">{problemCount} 张卡片待完善</Badge> : undefined}
      />
    </AdminPage>
  )
}
