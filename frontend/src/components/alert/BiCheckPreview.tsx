import { Notice, ResultTable } from '../../ui'

export interface BiCheckPreviewData {
  summary?: string
  matched: Record<string, unknown>[]
  matchedCount: number
  total: number
  params: Record<string, unknown>
  prevParams?: Record<string, unknown>
}

const fmt = (p: Record<string, unknown>) => Object.entries(p).map(([k, v]) => `${k}=${String(v ?? '')}`).join('，')

/** 按当前数据试算的结果：哪些行现在就会触发 */
export default function BiCheckPreview({ data }: { data: BiCheckPreviewData }) {
  const cols = data.matched.length > 0 ? Object.keys(data.matched[0]) : []
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-muted">
        按当前数据试算（参数 {fmt(data.params) || '无'}
        {data.prevParams ? `；对比上期 ${fmt(data.prevParams)}` : ''}）：共 {data.total} 行，
        {data.matchedCount > 0 ? (
          <span className="text-warning font-medium">现在就会触发 {data.matchedCount} 行</span>
        ) : (
          <span className="text-success font-medium">现在不会触发</span>
        )}
      </p>
      {data.matched.length > 0 && <ResultTable columns={cols} rows={data.matched} maxHeight="max-h-56" />}
      {data.matchedCount > data.matched.length && <Notice tone="info">仅显示前 {data.matched.length} 行</Notice>}
    </div>
  )
}
