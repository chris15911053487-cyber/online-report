/**
 * 关系图节点的示意缩略图数据：只看配置、不查数据。
 * - 图表：类型 + 横向 / 堆叠 / 系列数（画成对应形状）
 * - 看板：卡片按 12 栅格真实排版拼成小方块（packDashboard，与看板 CSS grid 自动排布一致）
 * - 查询：前几个输出列名 + 列数 / 参数数
 * 画法在 components/bi/admin/LineageThumbs.tsx。
 */
import { defaultChartSize, type BiCardType } from './bi'

export type ChartThumb = { kind: 'chart'; type: string; horizontal: boolean; stack: boolean; series: number }
export type DashboardThumb = { kind: 'dashboard'; blocks: { x: number; y: number; w: number; h: number; type: string }[]; rows: number }
export type QueryThumb = { kind: 'query'; columns: string[]; columnCount: number; paramCount: number }
export type Thumb = ChartThumb | DashboardThumb | QueryThumb

const GRID = 12

export function chartThumb(chart: { type: string; encoding?: { horizontal?: boolean; stack?: string; values?: string[]; series?: string } }): ChartThumb {
  const e = chart.encoding || {}
  const series = e.series ? 3 : Math.max(1, Math.min(3, e.values?.length || 1))
  return { kind: 'chart', type: chart.type, horizontal: !!e.horizontal, stack: !!e.stack, series }
}

/**
 * 与看板 DashboardPanel 的 12 列 CSS grid 一致：卡片从左到右排，放不下换行；
 * 每行高度 = 该行最高的卡片，图表 / 表格撑满行高，KPI 保持自身高度（顶部对齐）。
 * 返回每块的坐标（y、h 以高度档位为单位）与总高度。
 */
export function packDashboard(cards: { w: number; h: number; type: string }[]): DashboardThumb {
  const rowsOf: { w: number; h: number; type: string }[][] = []
  let row: { w: number; h: number; type: string }[] = []
  let used = 0
  for (const card of cards) {
    const w = Math.max(1, Math.min(GRID, Math.round(card.w) || GRID))
    const h = Math.max(1, Math.min(4, Math.round(card.h) || 2))
    if (used + w > GRID && row.length) {
      rowsOf.push(row)
      row = []
      used = 0
    }
    row.push({ w, h, type: card.type })
    used += w
  }
  if (row.length) rowsOf.push(row)
  const blocks: DashboardThumb['blocks'] = []
  let y = 0
  for (const r of rowsOf) {
    const rowH = Math.max(...r.map((c) => c.h))
    let x = 0
    for (const c of r) {
      blocks.push({ x, y, w: c.w, h: c.type === 'kpi' ? c.h : rowH, type: c.type })
      x += c.w
    }
    y += rowH
  }
  return { kind: 'dashboard', blocks, rows: y }
}

export function dashboardThumb(
  dashboard: { cards: { chartKey: string; layout?: { w: number; h: number } }[] },
  charts: Map<string, { type: string; size?: { w: number; h: number } }>,
): DashboardThumb {
  return packDashboard(
    dashboard.cards.map((c) => {
      const chart = charts.get(c.chartKey)
      const type = chart?.type || 'missing'
      const size = c.layout || chart?.size || defaultChartSize((chart?.type || 'bar') as BiCardType)
      return { ...size, type }
    }),
  )
}

export function queryThumb(query: { columns: { column: string; label?: string }[]; params: unknown[] }): QueryThumb {
  return { kind: 'query', columns: query.columns.slice(0, 3).map((c) => c.label || c.column), columnCount: query.columns.length, paramCount: query.params.length }
}
