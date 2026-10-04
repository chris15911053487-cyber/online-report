/**
 * 查询库编辑器（语义层）：SQL → 自动识别参数 → 试运行 → 自动识别输出列 → 标注列语义 → 给 AI 的说明。
 *
 * 输出列语义是看板配置的基础：卡片的维度 / 度量只能从这里选，格式 / 单位默认从这里继承。
 * 保存后若用到它的图表 / 看板对不上（删了列、改了参数），接口返回 warnings，编辑器保持打开并列出。
 */
import { useMemo, useState } from 'react'
import { Play, Trash2, Wand2 } from 'lucide-react'
import { useStore } from '../../../store'
import { apiFetch } from '../../../utils/api'
import type { BiColumnRole, BiColumnSemantic, BiFormat, BiParamDef } from '../../../utils/bi'
import { COLUMN_ROLE_LABEL, FORMAT_LABEL, extractSqlParams, mergeDetectedColumns, syncParamsWithSql } from '../../../utils/biAdmin'
import { AdminPage, Badge, Button, Checkbox, ChipSelect, Code, EditorActions, Field, IconButton, Input, Notice, ResultTable, Section, Textarea } from '../../../ui'
import { compactInputClass, tableClass, tdClass, thClass } from '../../../ui/classes'
import { errMsg, type BiQueryAdmin, type TestResult } from './types'

const SCALE_OPTIONS = [
  { value: '', label: '原值' },
  { value: '1000', label: '千' },
  { value: '10000', label: '万' },
  { value: '1000000', label: '百万' },
  { value: '100000000', label: '亿' },
]

const PARAM_TYPE_LABEL: Record<BiParamDef['type'], string> = { string: '文本', number: '数字', date: '日期', bool: '是/否' }

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
  initialTestValues,
  banner,
  onDone,
}: {
  initial: BiQueryAdmin
  isNew: boolean
  availableRoles: string[]
  /** 试运行参数的初始值（AI 草稿带来的示例参数） */
  initialTestValues?: Record<string, string>
  /** 页面顶部的提示（如 AI 草稿说明） */
  banner?: React.ReactNode
  /** savedKey：保存过时为最终的 queryKey（AI 草稿据此接着打开图表编辑） */
  onDone: (changed: boolean, savedKey?: string) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [d, setD] = useState<BiQueryAdmin>(initial)
  const [samplesText, setSamplesText] = useState(initial.sampleQuestions.join('\n'))
  const [created, setCreated] = useState(!isNew)
  const [savedOnce, setSavedOnce] = useState(false)
  const [saving, setSaving] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [testValues, setTestValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.params.map((p) => [p.name, initialTestValues?.[p.name] ?? (p.default == null ? '' : String(p.default))])),
  )
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState('')
  const [columnNote, setColumnNote] = useState('')
  const patch = (p: Partial<BiQueryAdmin>) => setD((cur) => ({ ...cur, ...p }))

  const unusedParams = useMemo(() => {
    const inSql = new Set(extractSqlParams(d.sqlText).map((n) => n.toLowerCase()))
    return new Set(d.params.filter((p) => !inSql.has(p.name.toLowerCase())).map((p) => p.name))
  }, [d.sqlText, d.params])

  // SQL 改动即同步参数表：新引用的参数自动加入，已有的保留设置
  const setSql = (sqlText: string) => setD((cur) => ({ ...cur, sqlText, params: syncParamsWithSql(cur.params, sqlText).params }))
  const patchParam = (name: string, p: Partial<BiParamDef>) =>
    setD((cur) => ({ ...cur, params: cur.params.map((x) => (x.name === name ? { ...x, ...p } : x)) }))
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

  const runTest = async () => {
    const params: Record<string, string> = {}
    for (const p of d.params) if (testValues[p.name]?.trim()) params[p.name] = testValues[p.name].trim()
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
                <Input value={d.caliberNote} onChange={(e) => patch({ caliberNote: e.target.value })} placeholder="按过账日期，含未清贷项，本币" />
              </Field>
            </div>
          </Section>

          <Section title="② SQL" hint="只允许一条 SELECT / WITH 只读查询；参数写成 @名称，右侧参数表自动同步。">
            <Textarea mono rows={14} value={d.sqlText} onChange={(e) => setSql(e.target.value)} spellCheck={false} placeholder="SELECT T0.CardCode, T0.CardName, SUM(T1.Balance) AS Balance&#10;FROM ... WHERE T1.Period = @period&#10;GROUP BY T0.CardCode, T0.CardName" />
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
                    {d.params.map((p) => (
                      <tr key={p.name}>
                        <td className={tdClass}>
                          <Code>@{p.name}</Code>
                          {unusedParams.has(p.name) && (
                            <Badge tone="warning" className="ml-1">
                              SQL 未使用
                            </Badge>
                          )}
                        </td>
                        <td className={tdClass}>
                          <input className={compactInputClass} value={p.label || ''} placeholder={p.name} onChange={(e) => patchParam(p.name, { label: e.target.value })} />
                        </td>
                        <td className={tdClass}>
                          <select className={compactInputClass + ' min-w-[5.5rem]'} value={p.type} onChange={(e) => patchParam(p.name, { type: e.target.value as BiParamDef['type'] })}>
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
                        <td className={tdClass}>
                          <input
                            className={compactInputClass}
                            value={p.default == null ? '' : String(p.default)}
                            onChange={(e) => patchParam(p.name, { default: e.target.value === '' ? undefined : e.target.value })}
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
                    ))}
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
                    {p.type === 'bool' ? (
                      <select className={compactInputClass} value={testValues[p.name] ?? ''} onChange={(e) => setTestValues((v) => ({ ...v, [p.name]: e.target.value }))}>
                        <option value="">（空）</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input
                        className={compactInputClass}
                        type={p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}
                        value={testValues[p.name] ?? ''}
                        placeholder={p.name === 'period' ? '2026-09' : ''}
                        onChange={(e) => setTestValues((v) => ({ ...v, [p.name]: e.target.value }))}
                      />
                    )}
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
          d.columns.length > 0 && (
            <Button size="sm" variant="ghost" className="whitespace-nowrap" icon={<Wand2 className="w-3.5 h-3.5" />} onClick={() => void runTest()} disabled={testing}>
              重新识别
            </Button>
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
              <ChipSelect options={availableRoles.map((r) => ({ value: r, label: r }))} selected={d.roles} onChange={(roles) => patch({ roles })} empty="暂无自定义角色" />
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
