/**
 * 图表表单：选查询 → 参数（固定值，或留给看板同名筛选）→ 展示（列从查询的输出列下拉选）→ 默认尺寸 → 下钻。
 * 图表不认识看板：没写固定值的参数，放进看板后由同名筛选自动提供。
 * 格式 / 单位 / 缩放不填时继承查询列语义（占位符里显示继承值）。
 */
import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Search, Trash2 } from 'lucide-react'
import { defaultChartSize, type BiCardType, type BiChartDef, type BiColumnRole, type BiColumnSemantic, type BiDrillLevel, type BiEncoding, type BiFormat, type BiLabelMode, type BiStackMode, type BiValue, type BiTrend } from '../../../utils/bi'
import {
  COLUMN_ROLE_LABEL,
  FORMAT_LABEL,
  autoBindDrill,
  cleanEncoding,
  columnOptionLabel,
  defaultEncoding,
  newDrillLevel,
  paramSource,
  suggestRightAxis,
} from '../../../utils/biAdmin'
import { Button, ChipSelect, Field, IconButton, Input, Notice, Segmented } from '../../../ui'
import { cn, compactInputClass } from '../../../ui/classes'
import type { QueryOption } from './types'
import ParamValueInput from './ParamValueInput'
import QueryPickerModal from './QueryPickerModal'
import { MAX_WATERFALL_PANELS } from '../../../utils/biOption'

const CARD_TYPES: { value: BiCardType; label: string }[] = [
  { value: 'kpi', label: 'KPI' },
  { value: 'bar', label: '柱状' },
  { value: 'line', label: '折线' },
  { value: 'pie', label: '饼图' },
  { value: 'waterfall', label: '瀑布' },
  { value: 'table', label: '表格' },
]
const STACK_MODES: { value: BiStackMode | 'none'; label: string }[] = [
  { value: 'none', label: '并排' },
  { value: 'normal', label: '堆叠' },
  { value: 'percent', label: '百分比堆叠' },
]

const LABEL_MODES: { value: BiLabelMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'show', label: '显示' },
  { value: 'hide', label: '不显示' },
]
const TRENDS: { value: BiTrend | 'neutral'; label: string }[] = [
  { value: 'neutral', label: '中性' },
  { value: 'up-good', label: '上涨为好' },
  { value: 'up-bad', label: '上涨为坏' },
]
const WATERFALL_TRENDS: { value: 'up-good' | 'up-bad'; label: string }[] = [
  { value: 'up-good', label: '增加为好（增绿减红）' },
  { value: 'up-bad', label: '增加为坏（增红减绿）' },
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

/** 逗号 / 顿号分隔的一组名称（瀑布图小计行）；输入时保留原文，失焦不改写 */
function NameListInput({ value, onChange, placeholder, ariaLabel }: { value?: string[]; onChange: (v: string[] | undefined) => void; placeholder: string; ariaLabel: string }) {
  const [text, setText] = useState((value || []).join('、'))
  return (
    <input
      className={compactInputClass}
      aria-label={ariaLabel}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        const list = [...new Set(e.target.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean))]
        onChange(list.length ? list : undefined)
      }}
    />
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
  params: Record<string, BiValue>
  /** 下钻：参数从上一级点中行的列取值 */
  bind?: Record<string, string>
  sourceColumns?: BiColumnSemantic[]
  onChange: (params: Record<string, BiValue>, bind?: Record<string, string>) => void
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
              <ParamValueInput param={p} ariaLabel={`参数 ${p.name} 固定值`} value={src.value} onChange={(v) => onChange({ ...params, [pv?.[0] ?? p.name]: v }, bind)} />
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

  const trendRow = (
    <Row label="涨跌颜色" hint="上涨为好：涨绿跌红（销售）；上涨为坏：涨红跌绿（成本、退货）">
      <Segmented size="sm" options={TRENDS} value={enc.trend || 'neutral'} onChange={(v) => set({ trend: v === 'neutral' ? undefined : v })} />
    </Row>
  )

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
        <Row label="对比列" hint="同一行里对比期（去年同期 / 上月）的值：显示增长率和对比值">
          <ColumnSelect ariaLabel="对比列" columns={columns} prefer={['measure']} optional value={enc.compare} onChange={(v) => set({ compare: v })} />
        </Row>
        {enc.compare && trendRow}
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
        {measures.length > 0 && (
          <Row label="涨跌着色列" hint="正数 ▲、负数 ▼ 并着色，适合增长率、差额">
            <ChipSelect
              options={measures.map((c) => ({ value: c.column, label: c.label || c.column }))}
              selected={enc.deltaColumns || []}
              onChange={(sel) => set({ deltaColumns: sel.length ? sel : undefined, trend: sel.length ? enc.trend : undefined })}
            />
          </Row>
        )}
        {!!enc.deltaColumns?.length && trendRow}
        {measures.length > 0 && (
          <Row label="数据条列" hint="单元格里画一根与数值成比例的横条，适合金额、数量对比">
            <ChipSelect
              options={measures.map((c) => ({ value: c.column, label: c.label || c.column }))}
              selected={enc.barColumns || []}
              onChange={(sel) => set({ barColumns: sel.length ? sel : undefined, barShared: sel.length > 1 ? enc.barShared : undefined })}
            />
          </Row>
        )}
        {(enc.barColumns?.length ?? 0) > 1 && (
          <Row label="数据条比例" hint="同一比例：各列按同一个最大值画，单位相同的列（收入、成本、毛利）可以横向比大小">
            <Segmented
              size="sm"
              options={[
                { value: 'column', label: '每列各自' },
                { value: 'shared', label: '各列同一比例' },
              ]}
              value={enc.barShared ? 'shared' : 'column'}
              onChange={(v) => set({ barShared: v === 'shared' || undefined })}
            />
          </Row>
        )}
      </div>
    )
  }

  if (type === 'waterfall') {
    return (
      <div className="flex flex-col gap-2">
        <Row label="方向" hint="横向：项目从上往下排，项目名长、或要按年份分栏对比时用">
          <Segmented
            size="sm"
            options={[
              { value: 'v', label: '竖向' },
              { value: 'h', label: '横向' },
            ]}
            value={enc.horizontal ? 'h' : 'v'}
            onChange={(v) => set(v === 'h' ? { horizontal: true } : { horizontal: undefined, series: undefined })}
          />
        </Row>
        <Row label="柱子画法" hint="累计：每项接着上一项的累计往后画（台阶）；从 0 画起：每项柱子长度就是本项数值，负数画在 0 的另一侧，方便直接比各项大小">
          <Segmented
            size="sm"
            options={[
              { value: 'step', label: '累计' },
              { value: 'zero', label: '从 0 画起' },
            ]}
            value={enc.fromZero ? 'zero' : 'step'}
            onChange={(v) => set({ fromZero: v === 'zero' ? true : undefined })}
          />
        </Row>
        <Row label={enc.horizontal ? '项目列（Y 轴）' : '项目列（X 轴）'} hint={`每行一根柱子，按查询结果的顺序从${enc.horizontal ? '上到下' : '左到右'}`}>
          <ColumnSelect ariaLabel="项目列" columns={columns} prefer={['dimension', 'time']} value={enc.dimension} onChange={(v) => set({ dimension: v })} />
        </Row>
        {enc.horizontal && (
          <Row label="分栏列" hint={`按这一列的值（如年份）每个值画一栏，左右并排、同一比例尺，最多 ${MAX_WATERFALL_PANELS} 栏；查询里每年各有一套项目行（可选）`}>
            <ColumnSelect ariaLabel="分栏列" columns={columns} prefer={['time', 'dimension', 'attr']} optional value={enc.series} onChange={(v) => set({ series: v })} />
          </Row>
        )}
        <Row label="数值列" hint="第一行是起点；之后增加写正数、减少写负数（成本、费用在 SQL 里取负）">
          <ColumnSelect ariaLabel="数值列" columns={columns} prefer={['measure']} value={enc.value ?? enc.values?.[0]} onChange={(v) => set({ value: v, values: undefined })} />
        </Row>
        <Row label="小计行" hint="项目列为这些值的行画成小计柱（从 0 画到当前累计，行里的数值不用），多个用顿号分隔">
          <NameListInput ariaLabel="小计行" value={enc.subtotals} placeholder="如：毛利（可不填）" onChange={(v) => set({ subtotals: v })} />
        </Row>
        <Row label="末尾合计" hint="在最后自动加一根合计柱，值为全部累计">
          <input className={compactInputClass} aria-label="末尾合计" value={enc.total || ''} maxLength={32} placeholder="如：营业利润（不填不加）" onChange={(e) => set({ total: e.target.value.trim() ? e.target.value : undefined })} />
        </Row>
        <Row label="增减颜色">
          <Segmented size="sm" options={WATERFALL_TRENDS} value={enc.trend === 'up-bad' ? 'up-bad' : 'up-good'} onChange={(v) => set({ trend: v === 'up-bad' ? v : undefined })} />
        </Row>
        <Row label="显示数值" hint={`自动：16 项以内在柱子上标${enc.fromZero ? '本项数值' : '增减额'}`}>
          <Segmented size="sm" options={LABEL_MODES} value={enc.labels || 'auto'} onChange={(v) => set({ labels: v === 'auto' ? undefined : v })} />
        </Row>
        {formatRows}
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
              onChange={(sel) =>
                set({
                  ...(sel.length > 1 ? { values: sel, value: undefined } : { value: sel[0], values: undefined }),
                  rightAxis: enc.series || enc.horizontal ? undefined : suggestRightAxis(sel, enc, columns),
                  ...(!enc.series && sel.length < 2 ? { stack: undefined } : {}),
                })
              }
              empty="查询没有度量列"
            />
          )
        ) : (
          <ColumnSelect ariaLabel="数值列" columns={columns} prefer={['measure']} value={enc.value} onChange={(v) => set({ value: v })} />
        )}
      </Row>
      {type !== 'pie' && valueList.length > 1 && !enc.series && !enc.horizontal && (
        <Row label="右轴（折线）" hint="选中的列画成折线、用右侧坐标轴，如增长率与金额同图">
          <ChipSelect
            options={valueList.map((c) => ({ value: c, label: columns.find((x) => x.column === c)?.label || c }))}
            selected={enc.rightAxis || []}
            onChange={(sel) => set({ rightAxis: sel.length ? sel : undefined })}
          />
        </Row>
      )}
      {type !== 'pie' && (
        <Row label="系列列" hint="长表透视：按这一列的值拆成多条系列（可选）">
          <ColumnSelect ariaLabel="系列列" columns={columns} prefer={['dimension', 'attr']} optional value={enc.series} onChange={(v) => set({ series: v, rightAxis: v ? undefined : enc.rightAxis, ...(!v && valueList.length < 2 ? { stack: undefined } : {}) })} />
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
              <input type="checkbox" className="accent-primary w-4 h-4" checked={!!enc.horizontal} onChange={(e) => set({ horizontal: e.target.checked || undefined, rightAxis: e.target.checked ? undefined : enc.rightAxis })} />
              横向条形
            </label>
          )}
        </div>
      </Row>
      {type === 'bar' && (enc.series || valueList.filter((c) => !enc.rightAxis?.includes(c)).length > 1) && (
        <Row label="多系列" hint="堆叠：各系列叠成一根柱子看合计；百分比堆叠：每根柱子 = 100%，看构成占比">
          <Segmented size="sm" options={STACK_MODES} value={enc.stack || 'none'} onChange={(v) => set({ stack: v === 'none' ? undefined : v })} />
        </Row>
      )}
      {type !== 'pie' && (
        <Row label="显示数值" hint={type === 'line' ? '自动：单条折线只标最新值' : '自动：单系列且柱子不多时标在柱上'}>
          <Segmented size="sm" options={LABEL_MODES} value={enc.labels || 'auto'} onChange={(v) => set({ labels: v === 'auto' ? undefined : v })} />
        </Row>
      )}
      {formatRows}
    </div>
  )
}

// ─── 卡片编辑 ────────────────────────────────────────────────────────────────

/** 选查询：显示当前查询，点击打开弹窗（搜索 + 说明 / 输出列 + 数据预览） */
function QuerySelect({ queries, value, onChange, ariaLabel, chartType }: { queries: QueryOption[]; value: string; onChange: (k: string) => void; ariaLabel: string; chartType: BiCardType }) {
  const [open, setOpen] = useState(false)
  const q = queries.find((x) => x.queryKey === value)
  return (
    <>
      <button type="button" aria-label={ariaLabel} className={cn(compactInputClass, 'flex items-center gap-2 text-left')} onClick={() => setOpen(true)}>
        <span className="flex-1 min-w-0 truncate">
          {q ? (
            <>
              {q.label || q.queryKey}
              <span className="text-subtle font-mono">（{q.queryKey}）</span>
              {!q.enabled && <span className="text-warning"> · 已停用</span>}
            </>
          ) : value ? (
            <span className="text-danger">{value}（不存在）</span>
          ) : (
            <span className="text-subtle">请选择查询…</span>
          )}
        </span>
        <Search className="w-3.5 h-3.5 text-subtle shrink-0" />
      </button>
      {open && <QueryPickerModal open onClose={() => setOpen(false)} title={ariaLabel === '图表查询' ? '选择查询' : `选择查询 · ${ariaLabel}`} queries={queries} value={value} chartType={chartType} onPick={(k) => k !== value && onChange(k)} />}
    </>
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
    // 尺寸跟随类型的默认值（KPI 1/4、折线 / 表格整行、柱状半宽、饼图 1/3）
    set({ type, encoding: defaultEncoding(type, cols, cleanEncoding(type, chart.encoding)), size: defaultChartSize(type) })
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
          <QuerySelect ariaLabel="图表查询" queries={queries} value={chart.queryKey} chartType={chart.type} onChange={changeQuery} />
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
                <QuerySelect ariaLabel={`第 ${i + 1} 级下钻查询`} queries={queries} value={d.queryKey} chartType={d.type} onChange={(k) => changeLevelQuery(i, k)} />
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
