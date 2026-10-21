/**
 * 图表「选择查询」弹窗：左侧查询库（搜索），右侧选中查询的说明 / 参数 / 输出列 + 数据预览（真实数据）。
 *
 * 预览可切换「按当前图表类型」（自动选维度 / 数值列，与选定后的默认展示一致）和「表格」（看全部输出列）；
 * 未固定的参数临时生成筛选条（同图表编辑页的预览）。
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { defaultChartSize, type BiCardType, type BiChartDef, type BiQueryMeta } from '../../../utils/bi'
import { COLUMN_ROLE_LABEL, FORMAT_LABEL, chartPreviewDashboard, defaultEncoding, type QueryRef } from '../../../utils/biAdmin'
import { Badge, Button, Card, EmptyState, Input, Modal, Segmented } from '../../../ui'
import { cn } from '../../../ui/classes'
import { DashboardView } from '../DashboardPanel'
import type { QueryOption } from './types'

const TYPE_LABEL: Record<BiCardType, string> = { kpi: 'KPI', bar: '柱状', line: '折线', pie: '饼图', table: '表格' }

/** 用查询临时拼一张图表做预览 */
function previewChart(q: QueryOption, type: BiCardType): BiChartDef {
  return { chartKey: 'preview', label: q.label || q.queryKey, type, queryKey: q.queryKey, params: {}, encoding: defaultEncoding(type, q.columns), drill: [], size: defaultChartSize(type), enabled: true }
}

export default function QueryPickerModal({
  open,
  onClose,
  title = '选择查询',
  queries,
  value,
  chartType,
  onPick,
}: {
  open: boolean
  onClose: () => void
  title?: string
  queries: QueryOption[]
  /** 当前已选的查询 */
  value: string
  /** 当前图表类型（预览按它展示） */
  chartType: BiCardType
  onPick: (queryKey: string) => void
}) {
  const [kw, setKw] = useState('')
  const [picked, setPicked] = useState(value)
  const [view, setView] = useState<'chart' | 'table'>('chart')

  const list = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return queries.filter((q) => !k || [q.label, q.queryKey, q.description, ...q.columns.map((c) => c.label || c.column)].some((s) => s?.toLowerCase().includes(k)))
  }, [queries, kw])
  const q = list.find((x) => x.queryKey === picked) ?? list[0]

  const queryMap = useMemo(() => new Map<string, QueryRef>(queries.map((x) => [x.queryKey, x])), [queries])
  const metas = useMemo(() => {
    const out: Record<string, BiQueryMeta> = {}
    for (const x of queries) out[x.queryKey] = x
    return out
  }, [queries])
  const previewType: BiCardType = view === 'table' ? 'table' : chartType
  const preview = useMemo(() => {
    if (!q) return null
    // 当前类型配不出来（如没有数值列）时退回表格
    return chartPreviewDashboard(previewChart(q, previewType), queryMap, metas) ?? chartPreviewDashboard(previewChart(q, 'table'), queryMap, metas)
  }, [q, previewType, queryMap, metas])

  const pick = (key: string) => {
    onPick(key)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!q} onClick={() => q && pick(q.queryKey)}>
            {q && q.queryKey === value ? '保持当前查询' : '使用这条查询'}
          </Button>
        </>
      }
    >
      {queries.length === 0 ? (
        <EmptyState title="查询库为空" description="请先到「① 查询库」新增查询" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] items-start">
          <div className="flex flex-col gap-2 min-w-0">
            <div className="relative">
              <Search className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input className="pl-8" placeholder="搜索名称 / 标识 / 说明 / 列名" value={kw} onChange={(e) => setKw(e.target.value)} autoFocus />
            </div>
            <div className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto pr-1" role="listbox" aria-label="查询库">
              {list.length === 0 && <p className="text-[12px] text-subtle py-6 text-center">没有匹配的查询</p>}
              {list.map((x) => {
                const active = x.queryKey === q?.queryKey
                return (
                  <button
                    key={x.queryKey}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => setPicked(x.queryKey)}
                    onDoubleClick={() => pick(x.queryKey)}
                    className={cn('text-left rounded-lg border px-3 py-2 transition-colors', active ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-2')}
                  >
                    <span className="block text-[13px] font-medium text-fg truncate">{x.label || x.queryKey}</span>
                    <span className="flex items-center gap-1.5 mt-1 text-[11.5px] text-subtle min-w-0">
                      <span className="font-mono truncate">{x.queryKey}</span>
                      {x.queryKey === value && <Badge tone="primary">当前</Badge>}
                      {!x.enabled && <Badge tone="warning">已停用</Badge>}
                      {x.columns.length === 0 && <Badge tone="warning">未登记输出列</Badge>}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3 min-w-0">
            {q ? (
              <>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-fg">{q.label || q.queryKey}</p>
                  {q.description && <p className="text-[12px] text-muted mt-0.5">{q.description}</p>}
                  {q.caliberNote && <p className="text-[11.5px] text-subtle mt-0.5">口径：{q.caliberNote}</p>}
                </div>

                <div className="flex flex-col gap-1.5">
                  <p className="text-[12px] font-semibold text-muted">参数</p>
                  {q.params.length === 0 ? (
                    <p className="text-[12px] text-subtle">无</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {q.params.map((p) => (
                        <Badge key={p.name} tone={p.required ? 'accent' : 'neutral'}>
                          {p.label ? `${p.label}（${p.name}）` : p.name}
                          {p.required ? ' · 必填' : ''}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <p className="text-[12px] font-semibold text-muted">输出列</p>
                  {q.columns.length === 0 ? (
                    <p className="text-[12px] text-subtle">未登记输出列：请到「① 查询库」试运行后保存</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {q.columns.map((c) => (
                        <Badge key={c.column} tone={c.role === 'measure' ? 'info' : c.role === 'attr' ? 'neutral' : 'primary'}>
                          {c.label ? `${c.label}（${c.column}）` : c.column} · {COLUMN_ROLE_LABEL[c.role]}
                          {c.format ? ` · ${FORMAT_LABEL[c.format]}` : ''}
                          {c.unit ? ` · ${c.unit}` : ''}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-[12px] font-semibold text-muted">数据预览</p>
                  {chartType !== 'table' && (
                    <Segmented
                      size="sm"
                      value={view}
                      onChange={setView}
                      options={[
                        { value: 'chart', label: `按${TYPE_LABEL[chartType]}` },
                        { value: 'table', label: '表格' },
                      ]}
                    />
                  )}
                </div>
                {preview ? (
                  <DashboardView key={`${q.queryKey}:${previewType}`} dashboard={preview} pcMode showHeader={false} />
                ) : (
                  <Card className="p-6 text-center text-[13px] text-subtle">这条查询暂时无法预览</Card>
                )}
                <p className="text-[11.5px] text-subtle">预览用真实数据，列为自动选择；选定后可在表单里再改展示列。双击列表项可直接选用。</p>
              </>
            ) : (
              <Card className="p-6 text-center text-[13px] text-subtle">在左侧选一条查询</Card>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
