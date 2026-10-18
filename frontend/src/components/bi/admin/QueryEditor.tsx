/**
 * 查询库编辑器（语义层）：SQL → 自动识别参数 → 试运行 → 自动识别输出列 → 标注列语义 → 给 AI 的说明。
 *
 * 输出列语义是看板配置的基础：卡片的维度 / 度量只能从这里选，格式 / 单位默认从这里继承。
 * 保存后若用到它的图表 / 看板对不上（删了列、改了参数），接口返回 warnings，编辑器保持打开并列出。
 */
import { Fragment, useMemo, useState } from 'react'
import type { BiValue } from '../../../utils/bi'
import { ChevronDown, ChevronRight, Loader2, Play, Sparkles, Trash2, Undo2, Wand2 } from 'lucide-react'
import { useStore } from '../../../store'
import { apiFetch } from '../../../utils/api'
import type { BiColumnRole, BiColumnSemantic, BiFormat, BiParamDef } from '../../../utils/bi'
import { COLUMN_ROLE_LABEL, FORMAT_LABEL, bareTableRefs, extractSqlParams, mergeDetectedColumns, optionsToText, paramDefProblems, sessionParamsUsed, syncParamsWithSql, textToOptions } from '../../../utils/biAdmin'
import { AdminPage, Badge, Button, Checkbox, ChipSelect, Code, EditorActions, Field, IconButton, Input, Notice, ResultTable, Section, Segmented, Textarea } from '../../../ui'
import { compactInputClass, tableClass, tdClass, thClass } from '../../../ui/classes'
import { errMsg, type BiQueryAdmin, type QueryOption, type TestResult } from './types'
import ParamValueInput from './ParamValueInput'
import { useRoleLabels } from '../../../hooks/useAppRoles'

const SCALE_OPTIONS = [
  { value: '', label: '原值' },
  { value: '1000', label: '千' },
  { value: '10000', label: '万' },
  { value: '1000000', label: '百万' },
  { value: '100000000', label: '亿' },
]

const PARAM_TYPE_LABEL: Record<BiParamDef['type'], string> = { string: '文本', number: '数字', date: '日期', month: '月份', bool: '是/否', list: '多选' }

/** 改类型时去掉不再适用的约束（可选值只给文本 / 数字 / 多选，范围只给数字） */
function changeParamType(p: BiParamDef, type: BiParamDef['type']): BiParamDef {
  const next: BiParamDef = { ...p, type }
  if (!['string', 'number', 'list'].includes(type)) {
    delete next.options
    delete next.optionsQuery
  }
  if (type !== 'number') {
    delete next.min
    delete next.max
  }
  if (Array.isArray(next.default) && type !== 'list') delete next.default
  return next
}

/** 参数「取值」一栏的摘要 */
function constraintSummary(p: BiParamDef): string {
  const parts: string[] = []
  if (p.options?.length) parts.push(`${p.options.length} 个可选值`)
  if (p.optionsQuery) parts.push(`来自 ${p.optionsQuery.queryKey || '查询'}`)
  if (p.min != null || p.max != null) parts.push(`${p.min ?? ''}~${p.max ?? ''}`)
  return parts.join('，') || '不限'
}

/** 参数的取值约束：可选值（固定 / 来自查询）、数字范围，以及按类型的 SQL 写法提示 */
function ParamConstraints({ p, selfKey, queries, onPatch }: { p: BiParamDef; selfKey: string; queries: QueryOption[]; onPatch: (next: BiParamDef) => void }) {
  const canOptions = ['string', 'number', 'list'].includes(p.type)
  const mode: 'none' | 'fixed' | 'query' = p.optionsQuery ? 'query' : p.options ? 'fixed' : 'none'
  const setMode = (m: 'none' | 'fixed' | 'query') => {
    const next = { ...p }
    delete next.options
    delete next.optionsQuery
    if (m === 'fixed') next.options = []
    if (m === 'query') next.optionsQuery = { queryKey: '', valueColumn: '' }
    onPatch(next)
  }
  const sources = queries.filter((q) => q.queryKey !== selfKey && q.enabled)
  const src = sources.find((q) => q.queryKey === p.optionsQuery?.queryKey)
  const setOq = (patch: Partial<NonNullable<BiParamDef['optionsQuery']>>) => onPatch({ ...p, optionsQuery: { queryKey: '', valueColumn: '', ...p.optionsQuery, ...patch } })
  const colSelect = (value: string, onChange: (v: string) => void, label: string, optional?: boolean) =>
    src?.columns.length ? (
      <select className={compactInputClass} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? '（同取值列）' : '选择列'}</option>
        {src.columns.map((c) => (
          <option key={c.column} value={c.column}>
            {c.label ? `${c.label}（${c.column}）` : c.column}
          </option>
        ))}
      </select>
    ) : (
      <input className={compactInputClass + ' font-mono'} aria-label={label} placeholder={optional ? '显示列（可空）' : '取值列名'} value={value} onChange={(e) => onChange(e.target.value.trim())} />
    )

  return (
    <div className="flex flex-col gap-2.5 py-1">
      {canOptions && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-muted w-14 shrink-0">可选值</span>
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'none', label: '不限' },
                { value: 'fixed', label: '固定选项' },
                { value: 'query', label: '来自查询' },
              ]}
            />
          </div>
          {mode === 'fixed' && (
            <textarea
              className={compactInputClass + ' h-auto py-1.5 font-mono'}
              rows={3}
              aria-label={`参数 ${p.name} 可选值`}
              placeholder={'每行一个：值=显示名\nyoy=同比\nmom=环比'}
              defaultValue={optionsToText(p.options)}
              onBlur={(e) => onPatch({ ...p, options: textToOptions(e.target.value).map((o) => (p.type === 'number' && Number.isFinite(Number(o.value)) ? { ...o, value: Number(o.value) } : o)) })}
            />
          )}
          {mode === 'query' && (
            <div className="grid gap-2 sm:grid-cols-3">
              <select className={compactInputClass} aria-label="选项来源查询" value={p.optionsQuery?.queryKey || ''} onChange={(e) => setOq({ queryKey: e.target.value, valueColumn: '', labelColumn: undefined })}>
                <option value="">选择查询</option>
                {sources.map((q) => (
                  <option key={q.queryKey} value={q.queryKey}>
                    {q.label}（{q.queryKey}）
                  </option>
                ))}
              </select>
              {colSelect(p.optionsQuery?.valueColumn || '', (v) => setOq({ valueColumn: v }), '取值列')}
              {colSelect(p.optionsQuery?.labelColumn || '', (v) => setOq({ labelColumn: v || undefined }), '显示列', true)}
            </div>
          )}
          {mode === 'fixed' && <p className="text-[11.5px] text-subtle">传入不在其中的值会直接报错并列出可选值；看板上同名下拉筛选可一键带出这些选项。</p>}
          {mode === 'query' && <p className="text-[11.5px] text-subtle">来源查询不能有必填参数；下拉里按取值列去重，最多 500 项。执行时不逐值核对。</p>}
        </div>
      )}
      {p.type === 'number' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted w-14 shrink-0">范围</span>
          <input className={compactInputClass + ' w-24'} type="number" aria-label="最小值" placeholder="最小" value={p.min ?? ''} onChange={(e) => onPatch({ ...p, min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <span className="text-subtle">~</span>
          <input className={compactInputClass + ' w-24'} type="number" aria-label="最大值" placeholder="最大" value={p.max ?? ''} onChange={(e) => onPatch({ ...p, max: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </div>
      )}
      {p.type === 'list' && (
        <p className="text-[11.5px] text-muted">
          多选在 SQL 里这样写（不选 = 全部）：<Code>(@{p.name} IS NULL OR 列 IN (SELECT value FROM OPENJSON(@{p.name})))</Code>
        </p>
      )}
      {p.type === 'month' && (
        <p className="text-[11.5px] text-muted">
          值为 <Code>YYYY-MM</Code> 文本（2026-9、202609 会自动规范成 2026-09），例如 <Code>CONVERT(char(7), T0.DocDate, 120) = @{p.name}</Code>
        </p>
      )}
    </div>
  )
}

/** 提交体：示例问法按行拆分 */
function toBody(d: BiQueryAdmin, samplesText: string) {
  return {
    queryKey: d.queryKey.trim(),
    label: d.label.trim(),
    description: d.description,
    sqlText: d.sqlText,
    params: d.params,
    columns: d.columns,
    dimensions: d.dimensions,
    sampleQuestions: samplesText.split('\n').map((s) => s.trim()).filter(Boolean),
    caliberNote: d.caliberNote,
    cacheSecs: Number(d.cacheSecs) || 0,
    roles: d.roles,
    enabled: d.enabled,
  }
}

export default function QueryEditor({
  initial,
  isNew,
  availableRoles,
  availableQueries = [],
  initialTestValues,
  banner,
  onDone,
}: {
  initial: BiQueryAdmin
  isNew: boolean
  availableRoles: string[]
  /** 可作为「选项来自查询」来源的查询（公开元数据） */
  availableQueries?: QueryOption[]
  /** 试运行参数的初始值（AI 草稿带来的示例参数） */
  initialTestValues?: Record<string, string>
  /** 页面顶部的提示（如 AI 草稿说明） */
  banner?: React.ReactNode
  /** savedKey：保存过时为最终的 queryKey（AI 草稿据此接着打开图表编辑） */
  onDone: (changed: boolean, savedKey?: string) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const { roleOptions } = useRoleLabels()
  // 打开时即清掉误声明的系统变量参数（@_loginUser 等，旧数据或 AI 草稿里可能有）
  const [d, setD] = useState<BiQueryAdmin>(() => ({ ...initial, params: syncParamsWithSql(initial.params, initial.sqlText).params }))
  const [samplesText, setSamplesText] = useState(initial.sampleQuestions.join('\n'))
  const [created, setCreated] = useState(!isNew)
  const [savedOnce, setSavedOnce] = useState(false)
  const [saving, setSaving] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [testValues, setTestValues] = useState<Record<string, BiValue>>(() =>
    Object.fromEntries(initial.params.map((p) => [p.name, initialTestValues?.[p.name] ?? p.default ?? ''])),
  )
  const [openParam, setOpenParam] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState('')
  const [columnNote, setColumnNote] = useState('')
  // AI 修改 SQL / 补全语义：结果说明 + 撤销用的快照
  const [aiInstruction, setAiInstruction] = useState('')
  const [aiBusy, setAiBusy] = useState<'' | 'revise' | 'enrich'>('')
  const [aiNote, setAiNote] = useState<{ tone: 'info' | 'warning'; lines: string[]; undo: { d: BiQueryAdmin; samplesText: string } } | null>(null)
  const patch = (p: Partial<BiQueryAdmin>) => setD((cur) => ({ ...cur, ...p }))

  const unusedParams = useMemo(() => {
    const inSql = new Set(extractSqlParams(d.sqlText).map((n) => n.toLowerCase()))
    return new Set(d.params.filter((p) => !inSql.has(p.name.toLowerCase())).map((p) => p.name))
  }, [d.sqlText, d.params])
  const sessionUsed = useMemo(() => sessionParamsUsed(d.sqlText), [d.sqlText])
  const bareTables = useMemo(() => bareTableRefs(d.sqlText), [d.sqlText])

  // SQL 改动即同步参数表：新引用的参数自动加入，已有的保留设置
  const setSql = (sqlText: string) => setD((cur) => ({ ...cur, sqlText, params: syncParamsWithSql(cur.params, sqlText).params }))
  const patchParam = (name: string, p: Partial<BiParamDef>) =>
    setD((cur) => ({ ...cur, params: cur.params.map((x) => (x.name === name ? { ...x, ...p } : x)) }))
  const replaceParam = (name: string, next: BiParamDef) => setD((cur) => ({ ...cur, params: cur.params.map((x) => (x.name === name ? next : x)) }))
  const removeParam = (name: string) => setD((cur) => ({ ...cur, params: cur.params.filter((x) => x.name !== name) }))
  const patchColumn = (column: string, p: Partial<BiColumnSemantic>) =>
    setD((cur) => ({ ...cur, columns: cur.columns.map((c) => (c.column === column ? { ...c, ...p } : c)) }))

  const save = async () => {
    setSaving(true)
    try {
      const r = (await apiFetch('/admin/bi/queries', { method: 'POST', body: JSON.stringify(toBody(d, samplesText)) })) as { warnings?: string[] }
      const w = r.warnings || []
      if (w.length === 0) {
        showToast('已保存')
        onDone(true, d.queryKey.trim().toLowerCase())
        return
      }
      showToast('已保存，但有图表 / 看板需要调整')
      setWarnings(w)
      setCreated(true)
      setSavedOnce(true)
    } catch (err) {
      showToast(errMsg(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const currentParams = () => {
    const params: Record<string, BiValue> = {}
    for (const p of d.params) {
      const v = testValues[p.name]
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
      params[p.name] = typeof v === 'string' ? v.trim() : v
    }
    return params
  }
  const snapshot = () => ({ d: structuredClone(d), samplesText })
  const undoAi = () => {
    if (!aiNote) return
    setD(aiNote.undo.d)
    setSamplesText(aiNote.undo.samplesText)
    setAiNote(null)
  }

  /** 让 AI 改 SQL：改完自动试运行并同步参数、列、口径；可撤销 */
  const reviseByAi = async () => {
    const instruction = aiInstruction.trim()
    if (!instruction) return
    setAiBusy('revise')
    try {
      const r = (await apiFetch('/admin/bi/ai/revise-query', { method: 'POST', body: JSON.stringify({ query: toBody(d, samplesText), instruction }) })) as {
        revision: { query: BiQueryAdmin; sample: TestResult; sampleParams: Record<string, BiValue>; changes: string; notes: string; removedColumns: string[]; attempts: number }
      }
      const v = r.revision
      const undo = snapshot()
      setD((cur) => ({ ...cur, sqlText: v.query.sqlText, params: syncParamsWithSql(v.query.params, v.query.sqlText).params, columns: v.query.columns, caliberNote: v.query.caliberNote, description: v.query.description || cur.description }))
      setSamplesText(v.query.sampleQuestions.join('\n'))
      setTestValues((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(v.sampleParams).map(([k, x]) => [k, x ?? ''])) }))
      setTestResult({ ...v.sample, truncated: false, durationMs: 0 })
      setTestError('')
      setColumnNote('')
      const lines = [`AI 已修改并试运行通过${v.attempts > 1 ? `（自我修正 ${v.attempts - 1} 次）` : ''}：${v.changes || instruction}`]
      if (v.removedColumns.length) lines.push(`去掉了输出列：${v.removedColumns.join('、')}——用到它们的图表保存后会提示需要调整`)
      if (v.notes) lines.push(`需要确认：${v.notes}`)
      setAiNote({ tone: v.removedColumns.length || v.notes ? 'warning' : 'info', lines, undo })
      setAiInstruction('')
    } catch (err) {
      showToast(errMsg(err, 'AI 修改失败'))
    } finally {
      setAiBusy('')
    }
  }

  /** AI 补全语义：只填空着的（没写中文名的列连角色 / 格式一起采纳；已写的保留）；可撤销 */
  const enrichByAi = async () => {
    setAiBusy('enrich')
    try {
      const r = (await apiFetch('/admin/bi/ai/enrich-query', { method: 'POST', body: JSON.stringify({ query: toBody(d, samplesText), params: currentParams() }) })) as {
        semantics: { description: string; caliberNote: string; columns: BiColumnSemantic[]; sampleQuestions: string[]; outputColumns: string[] }
      }
      const sem = r.semantics
      const undo = snapshot()
      const ai = new Map(sem.columns.map((c) => [c.column, c]))
      const existing = new Map(d.columns.map((c) => [c.column, c]))
      let filled = 0
      const columns = sem.outputColumns.map((name) => {
        const old = existing.get(name)
        const got = ai.get(name)
        if (!got) return old ?? { column: name, label: '', role: 'attr' as const }
        if (old?.label) return old
        filled += 1
        return { ...old, ...got, column: name }
      })
      const curSamples = samplesText.split('\n').map((x) => x.trim()).filter(Boolean)
      const addSamples = sem.sampleQuestions.filter((q) => !curSamples.includes(q))
      setD((cur) => ({ ...cur, columns, description: cur.description.trim() || sem.description, caliberNote: cur.caliberNote.trim() || sem.caliberNote }))
      setSamplesText([...curSamples, ...addSamples].slice(0, 10).join('\n'))
      const parts = [
        filled ? `${filled} 列的中文名与角色` : '',
        !d.description.trim() && sem.description ? '说明' : '',
        !d.caliberNote.trim() && sem.caliberNote ? '口径' : '',
        addSamples.length ? `${addSamples.length} 条示例问法` : '',
      ].filter(Boolean)
      const lines = [parts.length ? `AI 补全了${parts.join('、')}。已填写的内容没有改动，请核对。` : 'AI 看过了：各项都已填写，没有需要补的。']
      setAiNote({ tone: 'info', lines, undo })
    } catch (err) {
      showToast(errMsg(err, 'AI 补全失败'))
    } finally {
      setAiBusy('')
    }
  }

  const runTest = async () => {
    const params = currentParams()
    setTesting(true)
    setTestError('')
    setColumnNote('')
    try {
      const r = (await apiFetch('/admin/bi/queries/test', {
        method: 'POST',
        body: JSON.stringify({ query: toBody(d, samplesText), params }),
      })) as TestResult
      setTestResult(r)
      // 用结果列更新列语义：已登记的保留，新列自动猜角色，消失的列移除
      const m = mergeDetectedColumns(d.columns, r.columns, r.columnTypes, r.rows[0])
      patch({ columns: m.columns })
      const notes: string[] = []
      if (m.added.length) notes.push(`新识别 ${m.added.length} 列：${m.added.join('、')}（已按类型预填角色，请核对）`)
      if (m.removed.length) notes.push(`结果中已没有：${m.removed.join('、')}，已从输出列移除`)
      setColumnNote(notes.join('；'))
    } catch (err) {
      setTestError(errMsg(err, '试运行失败'))
      setTestResult(null)
    } finally {
      setTesting(false)
    }
  }

  return (
    <AdminPage
      title={created ? `编辑查询：${d.label || d.queryKey}` : '新增查询'}
      description="SQL 只写一次；图表、下钻和 AI 追问都引用这条查询，口径一致"
      onBack={() => onDone(savedOnce)}
      withActionBar
    >
      {banner}
      {aiNote && (
        <Notice tone={aiNote.tone}>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              {aiNote.lines.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
            <Button size="sm" variant="ghost" className="whitespace-nowrap shrink-0" icon={<Undo2 className="w-3.5 h-3.5" />} onClick={undoAi}>
              撤销
            </Button>
          </div>
        </Notice>
      )}
      {warnings.length > 0 && (
        <Notice tone="warning">
          <p className="font-medium mb-1">已保存。以下图表 / 看板与新定义对不上，请到「图表」「看板」里调整：</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <Section title="① 基本信息">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="查询标识（queryKey）" hint="小写字母开头，仅小写字母/数字/下划线/连字符；创建后不可修改">
                <Input value={d.queryKey} disabled={created} onChange={(e) => patch({ queryKey: e.target.value })} placeholder="fin_ar_by_customer" />
              </Field>
              <Field label="显示名称">
                <Input value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="应收账款 · 按客户" />
              </Field>
              <Field label="回答什么问题" hint="给人和 AI 看：AI 靠它判断什么时候用这条查询" className="sm:col-span-2">
                <Textarea rows={2} value={d.description} onChange={(e) => patch({ description: e.target.value })} placeholder="各客户在指定期间末的应收余额，用于看谁欠款多、欠多久" />
              </Field>
              <Field label="口径说明" className="sm:col-span-2">
                <Textarea rows={3} maxLength={1024} value={d.caliberNote} onChange={(e) => patch({ caliberNote: e.target.value })} placeholder="按过账日期，含未清贷项，本币" />
              </Field>
            </div>
          </Section>

          <Section title="② SQL" hint="只允许一条 SELECT / WITH 只读查询；参数写成 @名称，右侧参数表自动同步。按当前登录用户过滤可直接写 @_loginUser（用户编码）/ @_loginDisplayName（显示名），由系统自动代入，不是参数。">
            <Textarea mono rows={14} value={d.sqlText} onChange={(e) => setSql(e.target.value)} spellCheck={false} placeholder="SELECT T0.CardCode, T0.CardName, SUM(T1.Balance) AS Balance&#10;FROM ... WHERE T1.Period = @period&#10;GROUP BY T0.CardCode, T0.CardName" />
            {bareTables.length > 0 && (
              <Notice tone="warning" className="mt-2">
                表名 {bareTables.map((n) => `@${n}`).join('、')} 需要加方括号，写成 {bareTables.map((n) => `[@${n}]`).join('、')}：SAP 自定义表以 @ 开头，不加括号数据库会当成变量报错（这里也不会把它当参数）。
              </Notice>
            )}
            {sessionUsed.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                按登录用户取数：{sessionUsed.map((n) => `@${n}`).join('、')} 由系统按看板的查看人自动代入（试运行用你自己的账号）；结果按人缓存，不同用户互不共享。
              </p>
            )}
            {d.sqlText.trim() && (
              <div className="flex gap-2 mt-3">
                <Input
                  value={aiInstruction}
                  disabled={!!aiBusy}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void reviseByAi()}
                  placeholder="让 AI 改：扣掉退货 / 改成不含税 / 加一个销售员参数"
                />
                <Button
                  variant="soft"
                  className="whitespace-nowrap"
                  disabled={!!aiBusy || !aiInstruction.trim()}
                  icon={aiBusy === 'revise' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  onClick={() => void reviseByAi()}
                >
                  {aiBusy === 'revise' ? '修改并试运行…' : 'AI 修改'}
                </Button>
              </div>
            )}
          </Section>

        </div>

        <div className="flex flex-col gap-4 min-w-0">
          <Section title="③ 参数" hint="从 SQL 自动识别。必填且无默认值的参数，看板上必须给它绑定筛选或固定值。">
            {d.params.length === 0 ? (
              <p className="text-[13px] text-subtle">SQL 中没有 @参数</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>参数</th>
                      <th className={thClass}>显示名</th>
                      <th className={thClass}>类型</th>
                      <th className={thClass}>必填</th>
                      <th className={thClass}>默认值</th>
                      <th className={thClass} />
                    </tr>
                  </thead>
                  <tbody>
                    {d.params.map((p) => {
                      const problems = paramDefProblems(p)
                      const open = openParam === p.name
                      return (
                        <Fragment key={p.name}>
                          <tr className="align-top">
                            <td className={tdClass}>
                              <Code>@{p.name}</Code>
                              {unusedParams.has(p.name) && (
                                <Badge tone="warning" className="ml-1">
                                  SQL 未使用
                                </Badge>
                              )}
                              <button
                                type="button"
                                className="mt-1 flex items-center gap-0.5 text-[11.5px] text-primary hover:underline whitespace-nowrap"
                                aria-expanded={open}
                                title="可选值、范围"
                                onClick={() => setOpenParam(open ? null : p.name)}
                              >
                                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                取值：{constraintSummary(p)}
                              </button>
                            </td>
                            <td className={tdClass}>
                              <input className={compactInputClass + ' min-w-[5rem]'} value={p.label || ''} placeholder={p.name} onChange={(e) => patchParam(p.name, { label: e.target.value })} />
                            </td>
                            <td className={tdClass}>
                              <select className={compactInputClass + ' min-w-[4.5rem]'} value={p.type} onChange={(e) => replaceParam(p.name, changeParamType(p, e.target.value as BiParamDef['type']))}>
                                {Object.entries(PARAM_TYPE_LABEL).map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className={tdClass}>
                              <input type="checkbox" className="accent-primary w-4 h-4" checked={!!p.required} onChange={(e) => patchParam(p.name, { required: e.target.checked })} aria-label={`${p.name} 必填`} />
                            </td>
                            <td className={tdClass + ' min-w-[7.5rem]'}>
                              <ParamValueInput
                                param={p}
                                ariaLabel={`参数 ${p.name} 默认值`}
                                value={p.default}
                                onChange={(v) => patchParam(p.name, { default: v === '' || v == null || (Array.isArray(v) && v.length === 0) ? undefined : v })}
                              />
                            </td>
                            <td className={tdClass + ' w-8'}>
                              {unusedParams.has(p.name) && (
                                <IconButton label="删除参数" className="hover:text-danger" onClick={() => removeParam(p.name)}>
                                  <Trash2 className="w-4 h-4" />
                                </IconButton>
                              )}
                            </td>
                          </tr>
                          {(open || problems.length > 0) && (
                            <tr>
                              <td className={tdClass} colSpan={6}>
                                {problems.length > 0 && <p className="text-[12px] text-danger">{problems.join('；')}</p>}
                                {open && <ParamConstraints p={p} selfKey={d.queryKey.trim().toLowerCase()} queries={availableQueries} onPatch={(next) => replaceParam(p.name, next)} />}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section title="④ 试运行" hint="用当前表单（无需先保存）执行，最多 50 行、不走缓存；同时识别输出列。">
            <div className="flex flex-col gap-3">
              <div className="flex items-end gap-2 flex-wrap">
                {d.params.map((p) => (
                  <label key={p.name} className="flex flex-col gap-0.5 min-w-[9rem]">
                    <span className="text-[11px] text-subtle">
                      {p.label || p.name}
                      {p.required && <span className="text-danger"> *</span>}
                    </span>
                    <ParamValueInput param={p} ariaLabel={`试运行参数 ${p.name}`} value={testValues[p.name]} onChange={(v) => setTestValues((cur) => ({ ...cur, [p.name]: v }))} />
                  </label>
                ))}
                <Button variant="soft" icon={<Play className="w-3.5 h-3.5" />} onClick={() => void runTest()} disabled={testing || !d.sqlText.trim()}>
                  {testing ? '执行中…' : '试运行'}
                </Button>
              </div>
              {testError && <Notice tone="danger">{testError}</Notice>}
              {testResult && (
                <div>
                  <p className="text-xs text-muted mb-1">
                    {testResult.rowCount} 行{testResult.truncated ? '（已截断）' : ''} · {testResult.durationMs} ms
                  </p>
                  <ResultTable columns={testResult.columns} rows={testResult.rows} maxHeight="max-h-56" />
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>

      <Section
        title="⑤ 输出列"
        hint="看板卡片只能从这里选列；格式、单位、缩放是卡片的默认展示。维度/时间列可作为下钻与 AI 解读的维度。"
        actions={
          d.sqlText.trim() && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="soft"
                className="whitespace-nowrap"
                icon={aiBusy === 'enrich' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                onClick={() => void enrichByAi()}
                disabled={!!aiBusy}
              >
                {aiBusy === 'enrich' ? '补全中…' : 'AI 补全语义'}
              </Button>
              {d.columns.length > 0 && (
                <Button size="sm" variant="ghost" className="whitespace-nowrap" icon={<Wand2 className="w-3.5 h-3.5" />} onClick={() => void runTest()} disabled={testing}>
                  重新识别
                </Button>
              )}
            </div>
          )
        }
      >
        {columnNote && (
          <Notice tone="info" className="mb-3">
            {columnNote}
          </Notice>
        )}
        {d.columns.length === 0 ? (
          <p className="text-[13px] text-subtle">先点「试运行」，自动识别输出列。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>列</th>
                  <th className={thClass}>中文名</th>
                  <th className={thClass}>角色</th>
                  <th className={thClass}>格式</th>
                  <th className={thClass}>单位</th>
                  <th className={thClass}>缩放</th>
                </tr>
              </thead>
              <tbody>
                {d.columns.map((c) => {
                  const measure = c.role === 'measure'
                  return (
                    <tr key={c.column}>
                      <td className={tdClass}>
                        <Code>{c.column}</Code>
                      </td>
                      <td className={tdClass}>
                        <input className={compactInputClass + ' min-w-[7rem]'} value={c.label || ''} placeholder={c.column} onChange={(e) => patchColumn(c.column, { label: e.target.value })} />
                      </td>
                      <td className={tdClass}>
                        <select className={compactInputClass + ' min-w-[5.5rem]'} value={c.role} onChange={(e) => patchColumn(c.column, { role: e.target.value as BiColumnRole })}>
                          {Object.entries(COLUMN_ROLE_LABEL).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={tdClass}>
                        <select
                          className={compactInputClass + ' min-w-[5.5rem]'}
                          disabled={!measure}
                          value={measure ? c.format || '' : ''}
                          onChange={(e) => patchColumn(c.column, { format: (e.target.value || undefined) as BiFormat | undefined })}
                        >
                          <option value="">—</option>
                          {Object.entries(FORMAT_LABEL).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={tdClass}>
                         <input className={compactInputClass + ' min-w-[4rem]'} disabled={!measure} value={measure ? c.unit || '' : ''} placeholder={measure ? '元' : ''} onChange={(e) => patchColumn(c.column, { unit: e.target.value || undefined })} />
                      </td>
                      <td className={tdClass}>
                        <select
                          className={compactInputClass + ' min-w-[5rem]'}
                          disabled={!measure}
                          value={c.scale ? String(c.scale) : ''}
                          onChange={(e) => patchColumn(c.column, { scale: e.target.value ? Number(e.target.value) : undefined })}
                        >
                          {SCALE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-subtle mt-2">
              角色：维度 = 分组/坐标轴（客户、物料）；度量 = 可汇总的数（金额、数量）；时间 = 日期/期间；属性 = 编码等只用于关联或明细的列。
            </p>
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Section title="⑥ 示例问法" hint="每行一个。用户会怎么问这条查询能回答的问题——AI 据此选对查询。">
          <Textarea rows={3} value={samplesText} onChange={(e) => setSamplesText(e.target.value)} placeholder={'本月应收余额多少？\n哪些客户欠款最多？'} />
        </Section>

        <Section title="⑦ 缓存与权限">
          <div className="flex flex-col gap-3">
            <Field label="结果缓存（秒）" hint="0 = 不缓存。缓存按「参数 + 用户角色组合」分别保存，不同角色不会共享结果">
              <Input type="number" className="max-w-[12rem]" value={d.cacheSecs} onChange={(e) => patch({ cacheSecs: Number(e.target.value) })} />
            </Field>
            <Field label="可见角色（未勾选 = 仅管理员）">
              <ChipSelect options={roleOptions(availableRoles)} selected={d.roles} onChange={(roles) => patch({ roles })} empty="暂无自定义角色" />
            </Field>
            <Checkbox label="启用" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          </div>
        </Section>
      </div>

      <EditorActions
        onCancel={() => onDone(savedOnce)}
        onSave={() => void save()}
        saving={saving}
        leading={d.columns.length === 0 && d.sqlText.trim() ? <span className="text-xs text-warning">尚未识别输出列：看板将无法从下拉选择列</span> : undefined}
      />
    </AdminPage>
  )
}
