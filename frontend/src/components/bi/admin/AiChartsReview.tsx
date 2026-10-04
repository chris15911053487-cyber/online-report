/**
 * AI 草稿第 2 步：查询已保存，确认 AI 推荐的图表。
 * 每张图表并排显示真实数据预览（参数默认取 AI 试运行用过的值），勾选后一次保存；也可以单独打开图表编辑器细调。
 */
import { useMemo, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { useStore } from '../../../store'
import { apiFetch } from '../../../utils/api'
import type { BiChartDef, BiQueryMeta, BiScalar } from '../../../utils/bi'
import { chartPreviewDashboard, chartProblems, type QueryRef } from '../../../utils/biAdmin'
import { AdminPage, Badge, Button, Card, Checkbox, EditorActions, Notice } from '../../../ui'
import { DashboardView } from '../DashboardPanel'
import ChartEditor from './ChartEditor'
import { errMsg, type QueryOption } from './types'

const TYPE_LABEL: Record<string, string> = { kpi: 'KPI', bar: '柱状', line: '折线', pie: '饼图', table: '表格' }

type Item = { chart: BiChartDef; include: boolean; saved: boolean; error?: string }

export default function AiChartsReview({
  charts,
  availableQueries,
  sampleParams,
  onDone,
}: {
  charts: BiChartDef[]
  availableQueries: QueryOption[]
  sampleParams: Record<string, BiScalar>
  onDone: (changed: boolean) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [items, setItems] = useState<Item[]>(() => charts.map((chart) => ({ chart, include: true, saved: false })))
  const [editing, setEditing] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const queryMap = useMemo(() => new Map<string, QueryRef>(availableQueries.map((q) => [q.queryKey, q])), [availableQueries])
  const queries = useMemo(() => {
    const out: Record<string, BiQueryMeta> = {}
    for (const q of availableQueries) out[q.queryKey] = q
    return out
  }, [availableQueries])
  const patchItem = (i: number, p: Partial<Item>) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const anySaved = items.some((x) => x.saved)
  const pending = items.filter((x) => x.include && !x.saved)

  if (editing != null) {
    return (
      <ChartEditor
        initial={items[editing].chart}
        isNew
        availableQueries={availableQueries}
        previewDefaults={sampleParams}
        onDone={(changed) => {
          if (changed) patchItem(editing, { saved: true, include: true })
          setEditing(null)
        }}
      />
    )
  }

  const saveAll = async () => {
    if (pending.length === 0) return onDone(anySaved)
    setSaving(true)
    let failed = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it.include || it.saved) continue
      try {
        await apiFetch('/admin/bi/charts', { method: 'POST', body: JSON.stringify(it.chart) })
        patchItem(i, { saved: true, error: undefined })
      } catch (err) {
        failed += 1
        patchItem(i, { error: errMsg(err, '保存失败') })
      }
    }
    setSaving(false)
    if (failed === 0) {
      showToast('图表已保存，可到「③ 看板」里加进看板')
      onDone(true)
    } else showToast(`${failed} 张图表保存失败，见卡片上的提示`)
  }

  return (
    <AdminPage title="AI 草稿 · 第 2 步：确认图表" description="查询已保存。勾选要保留的图表一次保存；想细调的点「编辑」单独打开。" onBack={() => onDone(anySaved)} backLabel="完成" withActionBar>
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        {items.map((it, i) => {
          const preview = chartPreviewDashboard(it.chart, queryMap, queries, sampleParams)
          const problems = chartProblems(it.chart, queryMap)
          return (
            <Card key={it.chart.chartKey} className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {it.saved ? (
                    <Badge tone="success">
                      <Check className="w-3 h-3 inline" /> 已保存
                    </Badge>
                  ) : (
                    <Checkbox label="" aria-label={`保留 ${it.chart.label}`} checked={it.include} onChange={(e) => patchItem(i, { include: e.target.checked })} />
                  )}
                  <span className="font-semibold text-fg truncate">{it.chart.label}</span>
                  <Badge tone="info">{TYPE_LABEL[it.chart.type] || it.chart.type}</Badge>
                  <span className="text-[11px] text-subtle font-mono truncate">{it.chart.chartKey}</span>
                </div>
                {!it.saved && (
                  <Button size="sm" variant="ghost" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditing(i)}>
                    编辑
                  </Button>
                )}
              </div>
              {it.error && <Notice tone="danger">{it.error}</Notice>}
              {preview ? (
                <div className={it.include || it.saved ? '' : 'opacity-40'}>
                  <DashboardView key={it.chart.chartKey} dashboard={preview} pcMode showHeader={false} />
                </div>
              ) : (
                <Notice tone="warning">{problems.join('；') || '无法预览'}</Notice>
              )}
            </Card>
          )
        })}
      </div>
      <EditorActions onCancel={() => onDone(anySaved)} onSave={() => void saveAll()} saving={saving} saveLabel={pending.length ? `保存选中的 ${pending.length} 张` : '完成'} />
    </AdminPage>
  )
}
