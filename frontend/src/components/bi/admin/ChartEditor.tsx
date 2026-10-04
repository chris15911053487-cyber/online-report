/**
 * 图表编辑页：基本信息 + 图表表单（ChartForm）+ 实时预览。
 *
 * 图表 = 引用一个查询 + 展示方式，可被多个看板复用。没写固定值的参数放进看板后由同名筛选提供；
 * 预览时为这些参数临时生成筛选条（期间 → 月份、日期 → 日期），用真实数据（POST /bi/query）。
 * 保存后若引用它的看板对不上，接口返回 warnings，编辑器保持打开并列出。
 */
import { useMemo, useState } from 'react'
import { useStore } from '../../../store'
import { apiFetch } from '../../../utils/api'
import type { BiChartDef, BiDashboard, BiQueryMeta, BiScalar } from '../../../utils/bi'
import { chartAsCard, chartProblems, filterFromParam, resolveCard, suggestFilterParams, type QueryRef } from '../../../utils/biAdmin'
import { AdminPage, Card, Checkbox, EditorActions, Field, Input, Notice, Section, Textarea } from '../../../ui'
import { DashboardView } from '../DashboardPanel'
import ChartForm from './ChartForm'
import { errMsg, type BiChartAdmin, type QueryOption } from './types'

export default function ChartEditor({
  initial,
  isNew,
  availableQueries,
  banner,
  previewDefaults,
  onDone,
}: {
  initial: BiChartAdmin
  isNew: boolean
  availableQueries: QueryOption[]
  /** 页面顶部的提示（如 AI 草稿说明） */
  banner?: React.ReactNode
  /** 预览筛选的默认值（AI 草稿试运行用过的参数，保证预览有数据） */
  previewDefaults?: Record<string, BiScalar>
  onDone: (changed: boolean) => void
}) {
  const showToast = useStore((s) => s.showToast)
  const [c, setC] = useState<BiChartDef>(initial)
  const [created, setCreated] = useState(!isNew)
  const [savedOnce, setSavedOnce] = useState(false)
  const [saving, setSaving] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const patch = (p: Partial<BiChartDef>) => setC((cur) => ({ ...cur, ...p }))

  const queryMap = useMemo(() => new Map<string, QueryRef>(availableQueries.map((q) => [q.queryKey, q])), [availableQueries])
  const problems = useMemo(() => chartProblems(c, queryMap), [c, queryMap])

  // 预览：为没有固定值的参数临时生成筛选，展开成一张整行卡片
  const preview = useMemo((): BiDashboard | null => {
    if (problems.length > 0) return null
    const filters = suggestFilterParams([chartAsCard(c)], queryMap, [])
      .map(filterFromParam)
      .map((f) => (previewDefaults?.[f.name] != null ? { ...f, default: previewDefaults[f.name] } : f))
    const queries: Record<string, BiQueryMeta> = {}
    for (const q of availableQueries) queries[q.queryKey] = q
    const card = resolveCard({ id: 'preview', chartKey: c.chartKey }, c, filters, queryMap)
    return { dashboardKey: '_preview', label: c.label, filters, cards: [{ ...card, layout: { ...card.layout, w: 12 } }], queries, hiddenCards: 0 }
  }, [c, problems, queryMap, availableQueries, previewDefaults])

  const save = async () => {
    if (problems.length > 0) return showToast(`还有 ${problems.length} 个问题`)
    setSaving(true)
    try {
      const r = (await apiFetch('/admin/bi/charts', {
        method: 'POST',
        body: JSON.stringify({ ...c, chartKey: c.chartKey.trim(), label: c.label.trim() }),
      })) as { warnings?: string[] }
      const w = r.warnings || []
      if (w.length === 0) {
        showToast('已保存')
        onDone(true)
        return
      }
      showToast('已保存，但有看板需要调整')
      setWarnings(w)
      setCreated(true)
      setSavedOnce(true)
    } catch (err) {
      showToast(errMsg(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AdminPage
      title={created ? `编辑图表：${c.label || c.chartKey}` : '新增图表'}
      description="图表 = 一条查询 + 怎么展示；可放进多个看板。没写固定值的参数，由看板里的同名筛选提供"
      onBack={() => onDone(savedOnce)}
      withActionBar
    >
      {banner}
      {warnings.length > 0 && (
        <Notice tone="warning">
          <p className="font-medium mb-1">已保存。以下看板与新定义对不上，请到「看板」里调整：</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <Section title="基本信息">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="图表标识（chartKey）" hint={created ? undefined : '小写字母开头；创建后不可修改'}>
                <Input value={c.chartKey} disabled={created} onChange={(e) => patch({ chartKey: e.target.value })} placeholder="sales_top_customers" />
              </Field>
              <Checkbox className="self-end mb-2" label="启用" checked={c.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
              <Field label="说明" className="sm:col-span-2" hint="给人和 AI 看：这张图回答什么问题">
                <Textarea rows={2} value={c.description || ''} onChange={(e) => patch({ description: e.target.value })} />
              </Field>
            </div>
          </Section>
          <Section title="图表">
            <ChartForm chart={c} queries={availableQueries} problems={problems} onChange={setC} />
          </Section>
        </div>

        <div className="lg:sticky lg:top-20 flex flex-col gap-2 min-w-0">
          <p className="text-[12px] text-subtle">实时预览（真实数据）。筛选条按未固定的参数临时生成，放进看板后由看板的同名筛选提供。</p>
          {preview ? (
            <DashboardView key={JSON.stringify([c.queryKey, c.params, c.type, c.drill, preview.filters])} dashboard={preview} pcMode showHeader={false} />
          ) : (
            <Card className="p-6 text-center text-[13px] text-subtle">{availableQueries.length === 0 ? '查询库为空：请先到「查询库」新增查询' : '配置完成后显示预览'}</Card>
          )}
        </div>
      </div>

      <EditorActions onCancel={() => onDone(savedOnce)} onSave={() => void save()} saving={saving} />
    </AdminPage>
  )
}
