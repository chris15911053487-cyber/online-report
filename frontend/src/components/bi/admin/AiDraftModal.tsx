/**
 * AI 起草：说一句需求 → AI 读表结构、写 SQL、试运行、自我修正 → 展示草稿（SQL、样例数据、图表、说明）。
 * 「采用」后由上层把草稿依次填进查询编辑器、图表编辑器，人逐项确认后保存——这里不保存任何东西。
 */
import { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { apiFetch } from '../../../utils/api'
import type { BiChartDef, BiScalar } from '../../../utils/bi'
import { COLUMN_ROLE_LABEL } from '../../../utils/biAdmin'
import { Badge, Button, Code, Field, Modal, Notice, ResultTable, Textarea } from '../../../ui'
import { errMsg, type BiQueryAdmin } from './types'

export interface BiDraft {
  query: BiQueryAdmin
  charts: BiChartDef[]
  sample: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number }
  sampleParams: Record<string, BiScalar>
  notes: string
  unlabeledColumns: string[]
  tables: string[]
  attempts: number
}

const EXAMPLES = ['本月各客户销售额前 10 名', '今年每月销售额趋势（扣除退货，不含税）', '本月各销售员的开票金额', '当前各仓库库存金额占比']
const STAGES = ['选表', '读表结构', '写 SQL 与图表', '试运行', '核对结果']
const TYPE_LABEL: Record<string, string> = { kpi: 'KPI', bar: '柱状图', line: '折线图', pie: '饼图', table: '表格' }

export default function AiDraftModal({ open, onClose, onAccept }: { open: boolean; onClose: () => void; onAccept: (d: BiDraft) => void }) {
  const [requirement, setRequirement] = useState('')
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState(0)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<BiDraft | null>(null)

  // 等待时轮换显示阶段（服务端一次返回，这里只是让人知道在做什么）
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 4000)
    return () => clearInterval(t)
  }, [loading])

  const run = async () => {
    setLoading(true)
    setStage(0)
    setError('')
    setDraft(null)
    try {
      const r = (await apiFetch('/admin/bi/ai/draft', { method: 'POST', body: JSON.stringify({ requirement }) })) as { draft: BiDraft }
      setDraft(r.draft)
    } catch (err) {
      setError(errMsg(err, 'AI 起草失败'))
    } finally {
      setLoading(false)
    }
  }

  const q = draft?.query
  const label = (col?: string) => q?.columns.find((c) => c.column === col)?.label || col
  const describe = (c: BiChartDef) =>
    c.encoding.dimension ? `按「${label(c.encoding.dimension)}」看「${label(c.encoding.value || c.encoding.values?.[0])}」` : `数值「${label(c.encoding.value)}」`

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" />
          AI 起草查询与图表
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          {draft ? (
            <>
              <Button variant="secondary" onClick={() => void run()} disabled={loading}>
                重新生成
              </Button>
              <Button onClick={() => onAccept(draft)}>采用，逐项确认</Button>
            </>
          ) : (
            <Button onClick={() => void run()} disabled={loading || requirement.trim().length < 4} icon={loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}>
              {loading ? `${STAGES[stage]}…` : '开始起草'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="想看什么？" hint="说清楚看什么数、按什么分、什么口径。AI 会直接读库里的表结构写 SQL 并试运行，结果只是草稿，保存前由你确认。">
          <Textarea
            rows={2}
            value={requirement}
            disabled={loading}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="例如：本月各客户销售额前 10 名"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && requirement.trim().length >= 4) void run()
            }}
          />
        </Field>
        {!draft && !loading && (
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setRequirement(x)}
                className="px-2.5 py-1 rounded-full border border-line text-[12px] text-fg-2 hover:border-primary hover:text-primary transition-colors"
              >
                {x}
              </button>
            ))}
          </div>
        )}
        {loading && (
          <p className="text-[12.5px] text-muted flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {STAGES.map((s, i) => (
              <span key={s} className={i === stage ? 'text-primary font-medium' : i < stage ? 'text-fg-2' : 'text-subtle'}>
                {s}
                {i < STAGES.length - 1 ? ' →' : ''}
              </span>
            ))}
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}

        {draft && q && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-fg">{q.label}</span>
              <Code>{q.queryKey}</Code>
              <span className="text-[12px] text-subtle">
                用到 {draft.tables.join('、')}
                {draft.attempts > 1 ? ` · AI 自我修正 ${draft.attempts - 1} 次` : ''}
              </span>
            </div>
            {q.description && <p className="text-[13px] text-fg-2">{q.description}</p>}
            {draft.notes && (
              <Notice tone="warning">
                <p className="font-medium mb-0.5">需要你确认的假设</p>
                <p className="whitespace-pre-wrap">{draft.notes}</p>
              </Notice>
            )}
            {q.caliberNote && (
              <p className="text-[12.5px] text-muted">
                <span className="font-medium text-fg-2">口径：</span>
                {q.caliberNote}
              </p>
            )}
            <div className="text-[12.5px] text-muted">
              <span className="font-medium text-fg-2">推荐 {draft.charts.length} 张图表</span>
              {Object.keys(draft.sampleParams).length > 0 && <> · 试运行参数 {Object.entries(draft.sampleParams).map(([k, v]) => `${k}=${String(v)}`).join('，')}</>}
              <ul className="mt-1 space-y-0.5">
                {draft.charts.map((c) => (
                  <li key={c.chartKey} className="flex items-center gap-1.5">
                    <Badge tone="info">{TYPE_LABEL[c.type] || c.type}</Badge>
                    <span className="text-fg-2">{c.label}</span>
                    <span className="text-subtle">· {describe(c)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-fg">SQL 与列语义</summary>
              <pre className="mt-2 p-3 rounded-lg bg-surface-2 border border-line text-[11.5px] text-fg-2 overflow-x-auto whitespace-pre-wrap font-mono">{q.sqlText}</pre>
              <p className="mt-2 text-muted">
                {q.columns.map((c) => `${c.label || c.column}（${COLUMN_ROLE_LABEL[c.role]}）`).join('、')}
              </p>
            </details>
            <div>
              <p className="text-[12px] text-subtle mb-1">
                样例数据（{draft.sample.rowCount} 行{draft.sample.rowCount > draft.sample.rows.length ? `，显示前 ${draft.sample.rows.length} 行` : ''}）
              </p>
              {draft.sample.rows.length > 0 ? (
                <ResultTable columns={draft.sample.columns} rows={draft.sample.rows} maxHeight="max-h-56" />
              ) : (
                <p className="text-[12.5px] text-warning">试运行没有数据：可能所选期间没有业务，采用后可在查询编辑器里换参数再试运行。</p>
              )}
            </div>
            <p className="text-[12px] text-subtle">采用后先打开查询编辑器确认保存，再并排预览这几张图表，勾选要保留的一次保存。</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
