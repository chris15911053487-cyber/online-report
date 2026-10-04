/**
 * 图表表单：选查询 → 参数（固定值，或留给看板同名筛选）→ 展示（列从查询的输出列下拉选）→ 默认尺寸 → 下钻。
 * 图表不认识看板：没写固定值的参数，放进看板后由同名筛选自动提供。
 * 格式 / 单位 / 缩放不填时继承查询列语义（占位符里显示继承值）。
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { BiCardType, BiChartDef, BiColumnRole, BiColumnSemantic, BiDrillLevel, BiEncoding, BiFormat, BiScalar } from '../../../utils/bi'
import {
  COLUMN_ROLE_LABEL,
  FORMAT_LABEL,
  autoBindDrill,
  cleanEncoding,
  columnOptionLabel,
  defaultEncoding,
  newDrillLevel,
  paramSource,
} from '../../../utils/biAdmin'
import { Button, ChipSelect, Field, IconButton, Input, Notice, Segmented } from '../../../ui'
import { compactInputClass } from '../../../ui/classes'
import type { QueryOption } from './types'

const CARD_TYPES: { value: BiCardType; label: string }[] = [
  { value: 'kpi', label: 'KPI' },
  { value: 'bar', label: '柱状' },
  { value: 'line', label: '折线' },
  { value: 'pie', label: '饼图' },
  { value: 'table', label: '表格' },
]
const DRILL_TYPES = CARD_TYPES.filter((t) => t.value !== 'kpi') as { value: Exclude<BiCardType, 'kpi'>; label: string }[]

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
const SCALES = [
  { value: '', label: '继承' },
  { value: '1', label: '原值' },
  { value: '1000', label: '千' },
  { value: '10000', label: '万' },
  { value: '100000000', label: '亿' },
]
const ROLE_ORDER: BiColumnRole[] = ['dimension', 'time', 'measure', 'attr']

// ─── 列选择 ──────────────────────────────────────────────────────────────────

/** 从查询输出列中选一列（按角色分组，优先角色排前面）；查询未登记列时退化为文本框 */
function ColumnSelect({
  columns,
  value,
  onChange,
  prefer,
  optional,
  ariaLabel,
}: {
  columns: BiColumnSemantic[]
  value?: string
  onChange: (v: string | undefined) => void
  prefer: BiColumnRole[]
  optional?: boolean
  ariaLabel: string
}) {
  if (columns.length === 0) {
    return <input className={compactInputClass + ' font-mono'} aria-label={ariaLabel} value={value || ''} placeholder="列名" onChange={(e) => onChange(e.target.value.trim() || undefined)} />
  }
  const order = [...prefer, ...ROLE_ORDER.filter((r) => !prefer.includes(r))]
  const missing = value && !columns.some((c) => c.column === value)
  return (
    <select className={compactInputClass} aria-label={ariaLabel} value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{optional ? '（不使用）' : '请选择…'}</option>
      {missing && <option value={value}>{value}（不在输出列中）</option>}
      {order.map((role) => {
        const cols = columns.filter((c) => c.role === role)
        if (cols.length === 0) return null
        return (
          <optgroup key={role} label={COLUMN_ROLE_LABEL[role]}>
            {cols.map((c) => (
              <option key={c.column} value={c.column}>
                {columnOptionLabel(c)}
              </option>
            ))}
          </optgroup>
        )
      })}
    </select>
  )
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12.5px] text-muted">{label}</span>
      <div className="min-w-0">
        {children}
        {hint && <p className="text-[11px] text-subtle mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}

// ─── 参数取值来源 ─────────────────────────────────────────────────────────────

function ParamBindings({
  query,
  params,
  bind,
  sourceColumns,
  onChange,
}: {
  query: QueryOption
  params: Record<string, BiScalar>
  /** 下钻：参数从上一级点中行的列取值 */
  bind?: Record<string, string>
  sourceColumns?: BiColumnSemantic[]
  onChange: (params: Record<string, BiScalar>, bind?: Record<string, string>) => void
}) {
  if (query.params.length === 0) return <p className="text-[12px] text-subtle">该查询没有参数</p>
  const find = <T,>(obj: Record<string, T> | undefined, name: string): [string, T] | undefined =>
    Object.entries(obj || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())

  const setSource = (name: string, src: string) => {
    const nextParams = Object.fromEntries(Object.entries(params).filter(([k]) => k.toLowerCase() !== name.toLowerCase()))
    const nextBind = bind ? Object.fromEntries(Object.entries(bind).filter(([k]) => k.toLowerCase() !== name.toLowerCase())) : undefined
    if (src === 'fixed') nextParams[name] = ''
    else if (src.startsWith('col:') && nextBind) nextBind[name] = src.slice(4)
    onChange(nextParams, nextBind)
  }

  return (
    <div className="flex flex-col gap-2">
      {query.params.map((p) => {
        const pv = find(params, p.name)
        const bv = find(bind, p.name)
        const src = bv ? { kind: 'col' as const, col: bv[1] } : paramSource(pv?.[1])
        const key = src.kind === 'col' ? `col:${src.col}` : src.kind === 'filter' ? `filter:${src.filter}` : src.kind === 'fixed' ? 'fixed' : 'none'
        const required = p.required && p.default == null
        return (
          <div key={p.name} className="grid grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
            <span className="text-[12.5px] text-fg-2 truncate" title={p.name}>
              {p.label || p.name}
              {required && <span className="text-danger"> *</span>}
            </span>
            <select className={compactInputClass} aria-label={`参数 ${p.name} 取值来源`} value={key} onChange={(e) => setSource(p.name, e.target.value)}>
              <option value="none">{p.default != null ? `看板同名筛选（无则默认 ${String(p.default)}）` : '看板同名筛选提供'}</option>
              {bind && sourceColumns && sourceColumns.length > 0 && (
                <optgroup label="上一级点中行的列">
                  {sourceColumns.map((c) => (
                    <option key={c.column} value={`col:${c.column}`}>
                      {columnOptionLabel(c)}
                    </option>
                  ))}
                </optgroup>
              )}
              {bind && sourceColumns?.length === 0 && bv && <option value={`col:${bv[1]}`}>上一级列：{bv[1]}</option>}
              {src.kind === 'filter' && <option value={key}>筛选：{src.filter}（图表里不能引用筛选，请改掉）</option>}
              <option value="fixed">固定值</option>
            </select>
            {src.kind === 'fixed' ? (
              <input
                className={compactInputClass}
                aria-label={`参数 ${p.name} 固定值`}
                value={src.value == null ? '' : String(src.value)}
                onChange={(e) => onChange({ ...params, [pv?.[0] ?? p.name]: p.type === 'number' && e.target.value !== '' && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value }, bind)}
              />
            ) : bind && sourceColumns?.length === 0 && src.kind !== 'filter' ? (
              <input
                className={compactInputClass + ' font-mono'}
                aria-label={`参数 ${p.name} 取值列`}
                placeholder="上一级列名"
                value={src.kind === 'col' ? src.col : ''}
                onChange={(e) => setSource(p.name, e.target.value.trim() ? `col:${e.target.value.trim()}` : 'none')}
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

// ─── 展示设置 ────────────────────────────────────────────────────────────────

function EncodingFields({ type, enc, columns, onChange }: { type: BiCardType; enc: BiEncoding; columns: BiColumnSemantic[]; onChange: (e: BiEncoding) => void }) {
  const set = (p: Partial<BiEncoding>) => {
    const next = { ...enc, ...p }
    for (const k of Object.keys(p) as (keyof BiEncoding)[]) if (next[k] === undefined) delete next[k]
    onChange(next)
  }
  const measures = columns.filter((c) => c.role === 'measure')
  const primary = columns.find((c) => c.column === (enc.value ?? enc.values?.[0]))
  const inherit = (v?: string | number) => (v == null || v === '' ? '' : `继承：${v}`)
  const valueList = enc.values?.length ? enc.values : enc.value ? [enc.value] : []

  const formatRows = type !== 'table' && (
    <>
      <Row label="格式">
        <select className={compactInputClass} value={enc.format || ''} onChange={(e) => set({ format: (e.target.value || undefined) as BiFormat | undefined })}>
          <option value="">{primary?.format ? `继承（${FORMAT_LABEL[primary.format]}）` : '默认'}</option>
          {Object.entries(FORMAT_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row label="单位 / 缩放">
        <div className="grid grid-cols-2 gap-2">
          <input className={compactInputClass} value={enc.unit || ''} placeholder={inherit(primary?.unit) || '如 万元'} onChange={(e) => set({ unit: e.target.value || undefined })} />
          <select className={compactInputClass} value={enc.scale ? String(enc.scale) : ''} onChange={(e) => set({ scale: e.target.value ? Number(e.target.value) : undefined })}>
            {SCALES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value === '' && primary?.scale ? `继承（÷${primary.scale}）` : s.label}
              </option>
            ))}
          </select>
        </div>
      </Row>
    </>
  )

  if (type === 'kpi') {
    return (
      <div className="flex flex-col gap-2">
        <Row label="数值列">
          <ColumnSelect ariaLabel="数值列" columns={columns} prefer={['measure']} value={enc.value} onChange={(v) => set({ value: v })} />
        </Row>
        <Row label="对比列" hint="同一行里上期的值，显示环比">
          <ColumnSelect ariaLabel="对比列" columns={columns} prefer={['measure']} optional value={enc.compare} onChange={(v) => set({ compare: v })} />
        </Row>
        <Row label="说明列">
          <ColumnSelect ariaLabel="说明列" columns={columns} prefer={['dimension', 'time']} optional value={enc.label} onChange={(v) => set({ label: v })} />
        </Row>
        {formatRows}
      </div>
    )
  }

  if (type === 'table') {
    return (
      <div className="flex flex-col gap-2">
        <Row label="显示列" hint="不选 = 显示全部输出列；列名和格式取自查询">
          {columns.length > 0 ? (
            <ChipSelect
              options={columns.map((c) => ({ value: c.column, label: c.label || c.column }))}
              selected={(enc.columns || []).map((c) => c.column)}
              onChange={(sel) => set({ columns: sel.length ? sel.map((column) => enc.columns?.find((c) => c.column === column) ?? { column }) : undefined })}
            />
          ) : (
            <span className="text-[12px] text-subtle">查询未登记输出列，显示全部列</span>
          )}
        </Row>
        <Row label="行标题列" hint="下钻时面包屑显示这一列的值">
          <ColumnSelect ariaLabel="行标题列" columns={columns} prefer={['dimension']} optional value={enc.dimension} onChange={(v) => set({ dimension: v })} />
        </Row>
      </div>
    )
  }

  // bar / line / pie
  return (
    <div className="flex flex-col gap-2">
      <Row label={type === 'pie' ? '分类列' : '维度列（X 轴）'}>
        <ColumnSelect ariaLabel="维度列" columns={columns} prefer={type === 'line' ? ['time', 'dimension'] : ['dimension', 'time']} value={enc.dimension} onChange={(v) => set({ dimension: v })} />
      </Row>
      <Row label="数值列" hint={type === 'pie' ? '' : '可多选，多个系列'}>
        {columns.length > 0 ? (
          type === 'pie' ? (
            <ColumnSelect ariaLabel="数值列" columns={columns} prefer={['measure']} value={enc.value} onChange={(v) => set({ value: v, values: undefined })} />
          ) : (
            <ChipSelect
              options={(measures.length ? measures : columns).map((c) => ({ value: c.column, label: c.label || c.column }))}
              selected={valueList}
              onChange={(sel) => set(sel.length > 1 ? { values: sel, value: undefined } : { value: sel[0], values: undefined })}
              empty="查询没有度量列"
            />
          )
        ) : (
          <ColumnSelect ariaLabel="数值列" columns={columns} prefer={['measure']} value={enc.value} onChange={(v) => set({ value: v })} />
        )}
      </Row>
      {type !== 'pie' && (
        <Row label="系列列" hint="长表透视：按这一列的值拆成多条系列（可选）">
          <ColumnSelect ariaLabel="系列列" columns={columns} prefer={['dimension', 'attr']} optional value={enc.series} onChange={(v) => set({ series: v })} />
        </Row>
      )}
      <Row label="只显示前">
        <div className="flex items-center gap-3">
          <input
            className={compactInputClass + ' w-24'}
            type="number"
            min={1}
            max={500}
            value={enc.topN ?? ''}
            placeholder="全部"
            onChange={(e) => set({ topN: e.target.value ? Math.max(1, Math.min(500, Math.floor(Number(e.target.value)))) : undefined })}
          />
          {type === 'bar' && (
            <label className="flex items-center gap-1.5 text-[12.5px] text-fg-2">
              <input type="checkbox" className="accent-primary w-4 h-4" checked={!!enc.horizontal} onChange={(e) => set({ horizontal: e.target.checked || undefined })} />
              横向条形
            </label>
          )}
        </div>
      </Row>
      {formatRows}
    </div>
  )
}

// ─── 卡片编辑 ────────────────────────────────────────────────────────────────

function QuerySelect({ queries, value, onChange, ariaLabel }: { queries: QueryOption[]; value: string; onChange: (k: string) => void; ariaLabel: string }) {
  return (
    <select className={compactInputClass} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">请选择查询…</option>
      {value && !queries.some((q) => q.queryKey === value) && <option value={value}>{value}（不存在）</option>}
      {queries.map((q) => (
        <option key={q.queryKey} value={q.queryKey}>
          {q.label}（{q.queryKey}）{q.enabled ? '' : ' · 已停用'}
          {q.columns.length === 0 ? ' · 未登记输出列' : ''}
        </option>
      ))}
    </select>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-[12px] font-semibold text-muted uppercase tracking-wide mt-1">{children}</h4>
}

export default function ChartForm({
  chart,
  queries,
  problems,
  onChange,
}: {
  chart: BiChartDef
  queries: QueryOption[]
  problems: string[]
  onChange: (c: BiChartDef) => void
}) {
  const byKey = new Map(queries.map((q) => [q.queryKey, q]))
  const query = byKey.get(chart.queryKey)
  const cols = query?.columns ?? []
  const set = (p: Partial<BiChartDef>) => onChange({ ...chart, ...p })

  const changeType = (type: BiCardType) => {
    const size = type === 'kpi' ? { w: Math.min(chart.size.w, 4), h: 1 } : chart.type === 'kpi' ? { w: 6, h: 2 } : chart.size
    set({ type, encoding: defaultEncoding(type, cols, cleanEncoding(type, chart.encoding)), size })
  }
  const changeQuery = (queryKey: string) => {
    const q = byKey.get(queryKey)
    set({
      queryKey,
      label: chart.label || q?.label || '',
      params: {},
      encoding: defaultEncoding(chart.type, q?.columns ?? [], {}),
    })
  }

  // 下钻
  const sourceColsAt = (i: number): BiColumnSemantic[] => (i === 0 ? cols : (byKey.get(chart.drill[i - 1].queryKey)?.columns ?? []))
  const setLevel = (i: number, p: Partial<BiDrillLevel>) => set({ drill: chart.drill.map((d, j) => (j === i ? { ...d, ...p } : d)) })
  const changeLevelQuery = (i: number, queryKey: string) => {
    const q = byKey.get(queryKey)
    const auto = autoBindDrill(q?.params ?? [], sourceColsAt(i).map((c) => c.column), [], { bind: {}, params: {} })
    const d = chart.drill[i]
    setLevel(i, { queryKey, label: d.label || q?.label || '', ...auto, encoding: defaultEncoding(d.type, q?.columns ?? [], {}) })
  }
  const moveLevel = (i: number, dir: -1 | 1) => {
    const next = [...chart.drill]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    set({ drill: next })
  }

  return (
    <div className="flex flex-col gap-4">
      {problems.length > 0 && (
        <Notice tone="warning">
          <ul className="list-disc pl-5 space-y-0.5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="flex flex-col gap-2">
        <SubHeading>数据</SubHeading>
        <Row label="查询">
          <QuerySelect ariaLabel="图表查询" queries={queries} value={chart.queryKey} onChange={changeQuery} />
        </Row>
        {query?.description && <p className="text-[11.5px] text-subtle pl-[7.5rem] -mt-1">{query.description}</p>}
        {query && (
          <ParamBindings query={query} params={chart.params} onChange={(params) => set({ params })} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SubHeading>展示</SubHeading>
        <Row label="类型">
          <Segmented size="sm" options={CARD_TYPES} value={chart.type} onChange={changeType} />
        </Row>
        <div className="grid grid-cols-2 gap-2">
          <Field label="标题">
            <Input value={chart.label} onChange={(e) => set({ label: e.target.value })} placeholder="客户销售额 Top 10" />
          </Field>
          <Field label="副标题">
            <Input value={chart.subtitle || ''} onChange={(e) => set({ subtitle: e.target.value || undefined })} placeholder="可选" />
          </Field>
        </div>
        {query && <EncodingFields type={chart.type} enc={chart.encoding} columns={cols} onChange={(encoding) => set({ encoding })} />}
        <Row label="默认尺寸" hint="放进看板时的宽 / 高，看板里可再调整">
          <div className="grid grid-cols-2 gap-2">
            <select className={compactInputClass} aria-label="宽度" value={chart.size.w} onChange={(e) => set({ size: { ...chart.size, w: Number(e.target.value) } })}>
              {!WIDTHS.some((w) => w.value === chart.size.w) && <option value={chart.size.w}>{chart.size.w}/12</option>}
              {WIDTHS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
            <select className={compactInputClass} aria-label="高度" value={chart.size.h} disabled={chart.type === 'kpi'} onChange={(e) => set({ size: { ...chart.size, h: Number(e.target.value) } })}>
              {HEIGHTS.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
        </Row>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SubHeading>下钻（点中后逐级展开）</SubHeading>
          <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} disabled={chart.drill.length >= 5} onClick={() => set({ drill: [...chart.drill, newDrillLevel()] })}>
            添加一级
          </Button>
        </div>
        {chart.drill.length === 0 && <p className="text-[12px] text-subtle">未配置下钻：点击只用于 AI 解读</p>}
        {chart.drill.map((d, i) => {
          const q = byKey.get(d.queryKey)
          return (
            <div key={i} className="rounded-xl border border-line p-3 flex flex-col gap-2 bg-surface-2/40">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-fg-2">
                  第 {i + 1} 级 · 点中「{i === 0 ? chart.label || '图表' : chart.drill[i - 1].label || `第 ${i} 级`}」的一行后
                </span>
                <div className="flex items-center">
                  <IconButton label="上移" disabled={i === 0} onClick={() => moveLevel(i, -1)}>
                    <ArrowUp className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label="下移" disabled={i === chart.drill.length - 1} onClick={() => moveLevel(i, 1)}>
                    <ArrowDown className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label="删除这一级" className="hover:text-danger" onClick={() => set({ drill: chart.drill.filter((_, j) => j !== i) })}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              </div>
              <Row label="名称">
                <input className={compactInputClass} value={d.label} placeholder="如 单据" onChange={(e) => setLevel(i, { label: e.target.value })} />
              </Row>
              <Row label="查询">
                <QuerySelect ariaLabel={`第 ${i + 1} 级下钻查询`} queries={queries} value={d.queryKey} onChange={(k) => changeLevelQuery(i, k)} />
              </Row>
              {q && (
                <ParamBindings
                  query={q}
                  params={d.params}
                  bind={d.bind}
                  sourceColumns={sourceColsAt(i)}
                  onChange={(params, bind) => setLevel(i, { params, bind: bind ?? d.bind })}
                />
              )}
              <Row label="展示">
                <Segmented
                  size="sm"
                  options={DRILL_TYPES}
                  value={d.type}
                  onChange={(type) => setLevel(i, { type, encoding: defaultEncoding(type, q?.columns ?? [], cleanEncoding(type, d.encoding)) })}
                />
              </Row>
              {q && <EncodingFields type={d.type} enc={d.encoding} columns={q.columns} onChange={(encoding) => setLevel(i, { encoding })} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
