/**
 * 看板编辑器：基本信息 + 全局筛选（表格）+ 卡片（左列表 / 中编辑 / 右实时预览）+ 整板预览。
 *
 * - 筛选可从卡片查询的参数一键生成，生成后自动绑定到所有同名参数；改名 / 删除同步更新引用
 * - 每张卡片实时检查引用完整性（与后端同规则），有问题的卡片在列表里标出，保存前拦截
 * - 预览用真实数据（POST /bi/query，管理员不受查询角色限制）
 * - 高级：JSON 模式，与表单双向切换
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, BarChart3, Copy, Eye, EyeOff, LineChart, PieChart, Plus, Sparkles, Table2, Trash2, Hash, ArrowUp, ArrowDown } from 'lucide-react'
import { useStore } from '../../../store'
import { apiFetch } from '../../../utils/api'
import { parseJsonField, toJsonText, type BiCard, type BiCardType, type BiDashboard, type BiDrillLevel, type BiFilter, type BiQueryMeta } from '../../../utils/bi'
import { bindFilterEverywhere, cardProblems, filterFromParam, newCard, newDrillLevel, nextCardId, renameFilterRefs, suggestFilterParams, type QueryRef } from '../../../utils/biAdmin'
import { AdminPage, Badge, Button, Card, Checkbox, EditorActions, EmptyState, Field, IconButton, Input, JsonField, Notice, Section, Segmented, Textarea } from '../../../ui'
import { cn, compactInputClass, tableClass, tdClass, thClass } from '../../../ui/classes'
import { DashboardView } from '../DashboardPanel'
import CardEditor from './CardEditor'
import { errMsg, type BiDashboardAdmin, type QueryOption } from './types'

const TYPE_ICON: Record<BiCardType, typeof Hash> = { kpi: Hash, bar: BarChart3, line: LineChart, pie: PieChart, table: Table2 }
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
          <span className="text-muted">卡片查询需要的参数，建议建成筛选：</span>
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
        <p className="text-[13px] text-subtle">暂无筛选。卡片参数也可以写固定值，或不传使用查询默认值。</p>
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

// ─── 主编辑器 ────────────────────────────────────────────────────────────────

export default function DashboardEditor({
  initial,
  isNew,
  availableQueries,
  onDone,
}: {
  initial: BiDashboardAdmin
  isNew: boolean
  availableQueries: QueryOption[]
  onDone: (changed: boolean) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [d, setD] = useState<BiDashboardAdmin>(initial)
  const [selected, setSelected] = useState(0)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [json, setJson] = useState({ filters: '', cards: '' })
  const [showBoard, setShowBoard] = useState(false)
  const patch = (p: Partial<BiDashboardAdmin>) => setD((cur) => ({ ...cur, ...p }))

  const queryMap = useMemo(() => new Map<string, QueryRef>(availableQueries.map((q) => [q.queryKey, q])), [availableQueries])
  const filterNames = useMemo(() => new Set(d.filters.map((f) => f.name)), [d.filters])
  const problems = useMemo(() => d.cards.map((c) => cardProblems(c, queryMap, filterNames)), [d.cards, queryMap, filterNames])
  const suggestions = useMemo(() => suggestFilterParams(d.cards, queryMap, d.filters), [d.cards, queryMap, d.filters])
  const card = d.cards[selected]

  // 预览用的看板：queries 为公开元数据（口径、列语义）
  const previewQueries = useMemo(() => {
    const out: Record<string, BiQueryMeta> = {}
    for (const q of availableQueries) out[q.queryKey] = q
    return out
  }, [availableQueries])
  const toPreview = (cards: BiCard[]): BiDashboard => ({ dashboardKey: d.dashboardKey, label: d.label, description: d.description, filters: d.filters, cards, queries: previewQueries, hiddenCards: 0 })

  // 卡片操作
  const setCard = (i: number, c: BiCard) => patch({ cards: d.cards.map((x, j) => (j === i ? c : x)) })
  const addCard = () => {
    const c = newCard(nextCardId(d.cards.map((x) => x.id)))
    patch({ cards: [...d.cards, c] })
    setSelected(d.cards.length)
  }
  const duplicateCard = (i: number) => {
    const src = d.cards[i]
    const c: BiCard = { ...structuredClone(src), id: nextCardId(d.cards.map((x) => x.id)), title: `${src.title} 副本` }
    const cards = [...d.cards]
    cards.splice(i + 1, 0, c)
    patch({ cards })
    setSelected(i + 1)
  }
  const removeCard = (i: number) => {
    patch({ cards: d.cards.filter((_, j) => j !== i) })
    setSelected((s) => Math.max(0, Math.min(s, d.cards.length - 2)))
  }
  const moveCard = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= d.cards.length) return
    const cards = [...d.cards]
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
    patch({ cards })
    setSelected(j)
  }

  // 筛选操作（同步卡片里的引用）
  const addFilterFromParam = (name: string) => {
    const p = suggestions.find((x) => x.name === name)
    if (!p) return
    const f = filterFromParam(p)
    setD((cur) => ({ ...cur, filters: [...cur.filters, f], cards: bindFilterEverywhere(cur.cards, queryMap, f) }))
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
  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return
    if (next === 'json') {
      setJson({ filters: toJsonText(d.filters), cards: toJsonText(d.cards) })
      setMode('json')
      return
    }
    const f = parseJsonField<BiFilter[]>(json.filters, '全局筛选', 'array')
    if (!f.ok) return showToast(f.error)
    const c = parseJsonField<Partial<BiCard>[]>(json.cards, '卡片', 'array')
    if (!c.ok) return showToast(c.error)
    // 补齐表单需要的字段，避免手写 JSON 缺字段导致编辑器报错
    const cards: BiCard[] = c.value.map((x, i) => {
      const base = newCard(x.id || `card${i + 1}`, x.type)
      return {
        ...base,
        ...x,
        params: x.params || {},
        encoding: x.encoding || {},
        drill: (x.drill || []).map((l: Partial<BiDrillLevel>) => ({ ...newDrillLevel(), ...l })),
        layout: { ...base.layout, ...x.layout },
      }
    })
    patch({ filters: f.value, cards })
    setSelected(0)
    setMode('form')
  }

  const save = async () => {
    let body: BiDashboardAdmin = d
    if (mode === 'json') {
      const f = parseJsonField<BiFilter[]>(json.filters, '全局筛选', 'array')
      if (!f.ok) return showToast(f.error)
      const c = parseJsonField<BiCard[]>(json.cards, '卡片', 'array')
      if (!c.ok) return showToast(c.error)
      body = { ...d, filters: f.value, cards: c.value }
    } else {
      const bad = problems.findIndex((p) => p.length > 0)
      if (bad >= 0) {
        setSelected(bad)
        return showToast(`卡片「${d.cards[bad].title || d.cards[bad].id}」还有 ${problems[bad].length} 个问题`)
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
      description="看板只描述展示：卡片引用查询库的查询，不写 SQL；在「Agent 配置」里关联到 Agent"
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

        {mode === 'form' ? (
          <Section
            title="全局筛选"
            hint="看板顶部的筛选条。卡片参数选择「筛选：xx」即随之变化。"
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
        <Section title="卡片（JSON）" hint="高级：直接编辑卡片定义。切回「表单」时会解析校验。">
          <JsonField label="卡片定义" expect="array" rows={28} value={json.cards} onChange={(v) => setJson((j) => ({ ...j, cards: v }))} />
        </Section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_minmax(0,1fr)] items-start">
          {/* 卡片列表 */}
          <Card className="overflow-hidden lg:sticky lg:top-20">
            <div className="flex items-center justify-between px-3 py-2 border-b border-line">
              <span className="text-[13px] font-semibold text-fg">
                卡片 <span className="text-subtle font-normal">{d.cards.length}</span>
              </span>
              <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} onClick={addCard}>
                添加
              </Button>
            </div>
            {d.cards.length === 0 ? (
              <EmptyState title="还没有卡片" description="点「添加」创建第一张" />
            ) : (
              <ul className="max-h-[60vh] overflow-y-auto">
                {d.cards.map((c, i) => {
                  const Icon = TYPE_ICON[c.type]
                  const bad = problems[i].length > 0
                  return (
                    <li key={c.id + i}>
                      <button
                        type="button"
                        onClick={() => setSelected(i)}
                        className={cn('w-full flex items-center gap-2 px-3 py-2 text-left border-b border-line last:border-b-0 transition-colors', i === selected ? 'bg-primary-soft' : 'hover:bg-surface-2')}
                      >
                        <Icon className={cn('w-4 h-4 shrink-0', i === selected ? 'text-primary' : 'text-subtle')} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] text-fg truncate">{c.title || <span className="text-subtle">（未命名）</span>}</span>
                          <span className="block text-[11px] text-subtle truncate">
                            {TYPE_LABEL[c.type]} · {c.layout.w}/12{c.drill.length ? ` · 下钻 ${c.drill.length} 级` : ''}
                          </span>
                        </span>
                        {bad && <AlertTriangle className="w-4 h-4 text-warning shrink-0" aria-label="有问题" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          {/* 卡片编辑 */}
          {card ? (
            <Section
              title={card.title || '未命名卡片'}
              hint={<span className="font-mono">{card.id}</span>}
              actions={
                <div className="flex items-center">
                  <IconButton label="上移" disabled={selected === 0} onClick={() => moveCard(selected, -1)}>
                    <ArrowUp className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="下移" disabled={selected === d.cards.length - 1} onClick={() => moveCard(selected, 1)}>
                    <ArrowDown className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="复制" onClick={() => duplicateCard(selected)}>
                    <Copy className="w-4 h-4" />
                  </IconButton>
                  <IconButton label="删除卡片" className="hover:text-danger" onClick={() => removeCard(selected)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </div>
              }
            >
              <CardEditor card={card} queries={availableQueries} filters={d.filters} problems={problems[selected]} onChange={(c) => setCard(selected, c)} />
            </Section>
          ) : (
            <Card className="p-8">
              <EmptyState title="选择或添加一张卡片" description={availableQueries.length === 0 ? '查询库为空：请先到「查询库」新增查询' : undefined} />
            </Card>
          )}

          {/* 单卡实时预览（宽屏第三列，其余放在编辑区下方） */}
          {card && (
            <div className="lg:col-start-2 xl:col-start-auto xl:sticky xl:top-20 flex flex-col gap-2 min-w-0">
              <p className="text-[12px] text-subtle">实时预览（真实数据，筛选取默认值）</p>
              {problems[selected].length > 0 ? (
                <Card className="p-6 text-center text-[13px] text-subtle">配置完成后显示预览</Card>
              ) : (
                <DashboardView
                  key={JSON.stringify([card.queryKey, card.params, card.type, card.drill, d.filters])}
                  dashboard={toPreview([{ ...card, layout: { ...card.layout, w: 12 } }])}
                  pcMode
                  showHeader={false}
                />
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'form' && d.cards.length > 0 && (
        <Section
          title="整板预览"
          hint="按实际栅格排版，与 Agent 里看到的一致"
          actions={
            <Button size="sm" variant="ghost" icon={showBoard ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} onClick={() => setShowBoard((v) => !v)}>
              {showBoard ? '收起' : '展开'}
            </Button>
          }
        >
          {showBoard &&
            (problemCount > 0 ? (
              <Notice tone="warning">有 {problemCount} 张卡片配置未完成，修正后再预览。</Notice>
            ) : (
              <DashboardView key={JSON.stringify([d.cards, d.filters])} dashboard={toPreview(d.cards)} pcMode />
            ))}
        </Section>
      )}

      <EditorActions
        onCancel={() => onDone(false)}
        onSave={() => void save()}
        saving={saving}
        leading={
          mode === 'form' && problemCount > 0 ? (
            <Badge tone="warning">{problemCount} 张卡片待完善</Badge>
          ) : undefined
        }
      />
    </AdminPage>
  )
}
