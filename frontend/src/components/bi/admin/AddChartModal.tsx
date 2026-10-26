/**
 * 看板「添加图表」弹窗：左侧图表库（搜索 / 按类型筛选），右侧选中图表的实时预览（真实数据）。
 *
 * 预览同图表编辑页：未固定的参数临时生成筛选条；看板里已有同名筛选时沿用它的默认值，预览更接近放进看板后的样子。
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { BiCardType, BiChartDef, BiFilter, BiQueryMeta, BiValue } from '../../../utils/bi'
import { chartPreviewDashboard, type QueryRef } from '../../../utils/biAdmin'
import { Badge, Button, Card, EmptyState, Input, Modal, Segmented } from '../../../ui'
import { cn } from '../../../ui/classes'
import { DashboardView } from '../DashboardPanel'

const TYPE_LABEL: Record<BiCardType, string> = { kpi: 'KPI', bar: '柱状', line: '折线', pie: '饼图', waterfall: '瀑布', table: '表格' }
type TypeFilter = 'all' | BiCardType

export default function AddChartModal({
  open,
  onClose,
  charts,
  usedKeys,
  filters,
  queryMap,
  queries,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  charts: BiChartDef[]
  /** 看板里已用的图表（chartKey → 张数） */
  usedKeys: Map<string, number>
  /** 看板当前的筛选（同名的默认值用于预览） */
  filters: BiFilter[]
  queryMap: Map<string, QueryRef>
  queries: Record<string, BiQueryMeta>
  onAdd: (chartKey: string) => void
}) {
  const [kw, setKw] = useState('')
  const [type, setType] = useState<TypeFilter>('all')
  const [picked, setPicked] = useState('')

  const list = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return charts.filter(
      (c) =>
        (type === 'all' || c.type === type) &&
        (!k || [c.label, c.chartKey, c.description, c.queryKey].some((s) => s?.toLowerCase().includes(k))),
    )
  }, [charts, kw, type])
  const typeOptions = useMemo(() => {
    const present = new Set(charts.map((c) => c.type))
    return [{ value: 'all' as TypeFilter, label: '全部' }, ...(Object.keys(TYPE_LABEL) as BiCardType[]).filter((t) => present.has(t)).map((t) => ({ value: t as TypeFilter, label: TYPE_LABEL[t] }))]
  }, [charts])

  // 当前选中：不在筛选结果里时退回第一张
  const chart = list.find((c) => c.chartKey === picked) ?? list[0]
  const defaults = useMemo(() => {
    const out: Record<string, BiValue> = {}
    for (const f of filters) if (f.default != null && f.default !== '') out[f.name] = f.default
    return out
  }, [filters])
  const preview = useMemo(() => (chart ? chartPreviewDashboard(chart, queryMap, queries, defaults) : null), [chart, queryMap, queries, defaults])

  const add = (key: string) => {
    onAdd(key)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="添加图表"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!chart} onClick={() => chart && add(chart.chartKey)}>
            添加到看板
          </Button>
        </>
      }
    >
      {charts.length === 0 ? (
        <EmptyState title="图表库为空" description="请先到「② 图表」新增图表" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] items-start">
          <div className="flex flex-col gap-2 min-w-0">
            <div className="relative">
              <Search className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input className="pl-8" placeholder="搜索名称 / 标识 / 说明" value={kw} onChange={(e) => setKw(e.target.value)} autoFocus />
            </div>
            <Segmented size="sm" value={type} onChange={setType} options={typeOptions} className="self-start flex-wrap" />
            <div className="flex flex-col gap-1 max-h-[55vh] overflow-y-auto pr-1" role="listbox" aria-label="图表库">
              {list.length === 0 && <p className="text-[12px] text-subtle py-6 text-center">没有匹配的图表</p>}
              {list.map((c) => {
                const active = c.chartKey === chart?.chartKey
                const used = usedKeys.get(c.chartKey) || 0
                return (
                  <button
                    key={c.chartKey}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => setPicked(c.chartKey)}
                    onDoubleClick={() => add(c.chartKey)}
                    className={cn(
                      'text-left rounded-lg border px-3 py-2 transition-colors',
                      active ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-2',
                    )}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Badge>{TYPE_LABEL[c.type]}</Badge>
                      <span className="text-[13px] font-medium text-fg truncate">{c.label}</span>
                    </span>
                    <span className="flex items-center gap-1.5 mt-1 text-[11.5px] text-subtle min-w-0">
                      <span className="font-mono truncate">{c.chartKey}</span>
                      {used > 0 && <Badge tone="info">已在看板{used > 1 ? ` ×${used}` : ''}</Badge>}
                      {!c.enabled && <Badge tone="warning">已停用</Badge>}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2 min-w-0">
            {chart ? (
              <>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-fg">{chart.label}</p>
                  {chart.description && <p className="text-[12px] text-muted mt-0.5">{chart.description}</p>}
                  <p className="text-[11.5px] text-subtle mt-0.5">
                    查询 <span className="font-mono">{chart.queryKey}</span> · 默认尺寸 宽 {chart.size.w}/12 · 高 {chart.size.h}
                  </p>
                </div>
                {preview ? (
                  <DashboardView key={chart.chartKey} dashboard={preview} pcMode showHeader={false} />
                ) : (
                  <Card className="p-6 text-center text-[13px] text-subtle">这张图表配置不完整，无法预览（请到「② 图表」检查）</Card>
                )}
                <p className="text-[11.5px] text-subtle">预览用真实数据；筛选条按图表未固定的参数临时生成，放进看板后由看板的同名筛选提供。双击列表项可直接添加。</p>
              </>
            ) : (
              <Card className="p-6 text-center text-[13px] text-subtle">在左侧选一张图表</Card>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
