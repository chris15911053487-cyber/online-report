/**
 * 关系图节点的示意缩略图（SVG，只按配置画，不查数据）。颜色取图表调色板 --c-chart-*，跟随主题。
 * 数据在 utils/biLineageThumb.ts。
 */
import type { ReactNode } from 'react'
import type { ChartThumb, DashboardThumb, QueryThumb, Thumb } from '../../../utils/biLineageThumb'

export const THUMB_W = 192
export const THUMB_H = 64

const c = (token: string, alpha?: number) => (alpha == null ? `rgb(var(--c-${token}))` : `rgb(var(--c-${token}) / ${alpha})`)
const SERIES = ['chart-1', 'chart-2', 'chart-3']

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width={THUMB_W} height={THUMB_H} viewBox={`0 0 ${THUMB_W} ${THUMB_H}`} className="block" aria-hidden>
      {children}
    </svg>
  )
}

const BARS = [0.45, 0.7, 0.55, 0.9, 0.65, 0.8, 0.5]
const LINE = [0.35, 0.5, 0.42, 0.68, 0.6, 0.82, 0.74, 0.9]

function BarThumb({ t }: { t: ChartThumb }) {
  const pad = 8
  const base = THUMB_H - 6
  if (t.horizontal) {
    const rows = 4
    const bh = (THUMB_H - 12) / rows - 3
    return (
      <Svg>
        {Array.from({ length: rows }, (_, i) => {
          const len = (THUMB_W - pad * 2) * [0.92, 0.74, 0.58, 0.4][i]
          const y = 6 + i * (bh + 3)
          if (!t.stack) return <rect key={i} x={pad} y={y} width={len} height={bh} rx={2} style={{ fill: c('chart-1') }} />
          return (
            <g key={i}>
              <rect x={pad} y={y} width={len * 0.6} height={bh} rx={2} style={{ fill: c('chart-1') }} />
              <rect x={pad + len * 0.6} y={y} width={len * 0.4} height={bh} rx={2} style={{ fill: c('chart-2') }} />
            </g>
          )
        })}
      </Svg>
    )
  }
  const n = BARS.length
  const slot = (THUMB_W - pad * 2) / n
  const groups = t.stack ? 1 : t.series
  const bw = Math.min(14, (slot - 6) / groups)
  return (
    <Svg>
      <line x1={pad} y1={base} x2={THUMB_W - pad} y2={base} style={{ stroke: c('line-strong') }} strokeWidth={1} />
      {BARS.map((v, i) => {
        const x0 = pad + i * slot + (slot - bw * groups) / 2
        const h = (base - 6) * v
        if (t.stack) {
          return (
            <g key={i}>
              <rect x={x0} y={base - h} width={bw} height={h * 0.6} rx={1.5} style={{ fill: c('chart-2') }} />
              <rect x={x0} y={base - h * 0.4} width={bw} height={h * 0.4} rx={1.5} style={{ fill: c('chart-1') }} />
            </g>
          )
        }
        return Array.from({ length: groups }, (_, g) => {
          const hh = h * (g === 0 ? 1 : 0.7 - g * 0.12)
          return <rect key={`${i}-${g}`} x={x0 + g * bw} y={base - hh} width={bw - 1} height={hh} rx={1.5} style={{ fill: c(SERIES[g]) }} />
        })
      })}
    </Svg>
  )
}

function LineThumb({ t }: { t: ChartThumb }) {
  const pad = 8
  const pts = (shift: number) =>
    LINE.map((v, i) => [pad + (i * (THUMB_W - pad * 2)) / (LINE.length - 1), THUMB_H - 8 - (THUMB_H - 16) * Math.max(0.05, v - shift)] as const)
  const path = (p: readonly (readonly [number, number])[]) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const main = pts(0)
  return (
    <Svg>
      <path d={`${path(main)} L${THUMB_W - pad},${THUMB_H - 6} L${pad},${THUMB_H - 6} Z`} style={{ fill: c('chart-1', 0.14) }} />
      {Array.from({ length: t.series }, (_, g) => (
        <path key={g} d={path(pts(g * 0.22))} fill="none" style={{ stroke: c(SERIES[g]) }} strokeWidth={g ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      <circle cx={main.at(-1)![0]} cy={main.at(-1)![1]} r={2.6} style={{ fill: c('chart-1') }} />
    </Svg>
  )
}

function PieThumb() {
  const r = 20
  const cx = 34
  const cy = THUMB_H / 2
  const len = 2 * Math.PI * r
  const parts = [0.45, 0.3, 0.25]
  let acc = 0
  return (
    <Svg>
      {parts.map((p, i) => {
        const el = (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            style={{ stroke: c(`chart-${i + 1}`) }}
            strokeWidth={10}
            strokeDasharray={`${len * p - 1.5} ${len}`}
            strokeDashoffset={-len * acc}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        )
        acc += p
        return el
      })}
      {parts.map((p, i) => (
        <g key={`l${i}`}>
          <rect x={76} y={14 + i * 14} width={8} height={8} rx={2} style={{ fill: c(`chart-${i + 1}`) }} />
          <rect x={90} y={16 + i * 14} width={60 * p + 30} height={4} rx={2} style={{ fill: c('line-strong') }} />
        </g>
      ))}
    </Svg>
  )
}

function KpiThumb() {
  const spark = [0.4, 0.55, 0.45, 0.7, 0.62, 0.85]
  const sx = (i: number) => 112 + i * 14
  const sy = (v: number) => 46 - v * 26
  return (
    <Svg>
      <rect x={10} y={10} width={44} height={5} rx={2.5} style={{ fill: c('line-strong') }} />
      <text x={10} y={42} className="num" style={{ fill: c('fg'), fontSize: 22, fontWeight: 700 }}>
        128.6
      </text>
      <text x={10} y={56} style={{ fill: c('success'), fontSize: 9, fontWeight: 600 }}>
        ▲ 12.4%
      </text>
      <path d={spark.map((v, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(v)}`).join(' ')} fill="none" style={{ stroke: c('chart-1') }} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

function WaterfallThumb() {
  const steps = [0.8, -0.18, -0.12, 0.1, -0.2]
  const pad = 8
  const n = steps.length + 1
  const slot = (THUMB_W - pad * 2) / n
  const bw = slot - 8
  const base = THUMB_H - 6
  const scale = base - 8
  let level = 0
  const bars = steps.map((d, i) => {
    const from = level
    level += d
    const top = Math.max(from, level)
    return <rect key={i} x={pad + i * slot + 4} y={base - top * scale} width={bw} height={Math.abs(d) * scale} rx={1.5} style={{ fill: c(i === 0 ? 'chart-1' : d >= 0 ? 'success' : 'danger', i === 0 ? 1 : 0.8) }} />
  })
  return (
    <Svg>
      <line x1={pad} y1={base} x2={THUMB_W - pad} y2={base} style={{ stroke: c('line-strong') }} strokeWidth={1} />
      {bars}
      <rect x={pad + steps.length * slot + 4} y={base - level * scale} width={bw} height={level * scale} rx={1.5} style={{ fill: c('chart-2') }} />
    </Svg>
  )
}

function SankeyThumb() {
  const left = [
    [6, 18],
    [28, 14],
    [46, 12],
  ] as const
  const right = [
    [8, 26],
    [40, 18],
  ] as const
  const lx = 14
  const rx = THUMB_W - 20
  const band = (y1: number, h: number, y2: number, i: number) => {
    const m = (lx + rx) / 2
    return (
      <path
        key={`${y1}-${y2}`}
        d={`M${lx + 6},${y1} C${m},${y1} ${m},${y2} ${rx},${y2} L${rx},${y2 + h} C${m},${y2 + h} ${m},${y1 + h} ${lx + 6},${y1 + h} Z`}
        style={{ fill: c(`chart-${i + 1}`, 0.35) }}
      />
    )
  }
  return (
    <Svg>
      {band(6, 12, 8, 0)}
      {band(18, 6, 40, 0)}
      {band(28, 14, 20, 1)}
      {band(46, 12, 46, 2)}
      {left.map(([y, h], i) => (
        <rect key={`l${i}`} x={lx} y={y} width={6} height={h} rx={1} style={{ fill: c(`chart-${i + 1}`) }} />
      ))}
      {right.map(([y, h], i) => (
        <rect key={`r${i}`} x={rx} y={y} width={6} height={h} rx={1} style={{ fill: c('chart-4') }} />
      ))}
    </Svg>
  )
}

function TableThumb() {
  const cols = [0, 64, 128]
  return (
    <Svg>
      <rect x={6} y={6} width={THUMB_W - 12} height={11} rx={2} style={{ fill: c('surface-3') }} />
      {[0, 1, 2].map((r) => (
        <g key={r}>
          {cols.map((x, i) => (
            <rect key={i} x={12 + x} y={23 + r * 13} width={i === 2 ? 26 : 40 - r * 6} height={4} rx={2} style={{ fill: c('line-strong') }} />
          ))}
          <rect x={150} y={22 + r * 13} width={[30, 20, 12][r]} height={6} rx={1.5} style={{ fill: c('chart-1', 0.5) }} />
          <line x1={6} y1={32 + r * 13} x2={THUMB_W - 6} y2={32 + r * 13} style={{ stroke: c('line') }} />
        </g>
      ))}
    </Svg>
  )
}

const TYPE_TOKEN: Record<string, string> = { kpi: 'chart-3', line: 'chart-1', bar: 'chart-2', pie: 'chart-4', waterfall: 'chart-5', sankey: 'chart-6', table: 'line-strong' }

function DashboardThumbView({ t }: { t: DashboardThumb }) {
  if (t.blocks.length === 0) return <Empty text="没有卡片" />
  const pad = 4
  const gap = 2
  const unitW = (THUMB_W - pad * 2) / 12
  // 高度按比例缩放，最多铺满缩略图高度；行太多时整体压扁
  const unitH = Math.min(14, (THUMB_H - pad * 2) / Math.max(1, t.rows))
  const ox = pad
  const oy = pad
  return (
    <Svg>
      {t.blocks.map((b, i) => {
        const missing = b.type === 'missing'
        const token = TYPE_TOKEN[b.type] || 'chart-2'
        return (
          <rect
            key={i}
            x={ox + b.x * unitW + gap / 2}
            y={oy + b.y * unitH + gap / 2}
            width={b.w * unitW - gap}
            height={b.h * unitH - gap}
            rx={2}
            style={missing ? { fill: c('danger', 0.12), stroke: c('danger') } : { fill: c(token, b.type === 'table' ? 0.35 : 0.3), stroke: c(token, 0.9) }}
            strokeWidth={0.8}
            strokeDasharray={missing ? '3 2' : undefined}
          />
        )
      })}
    </Svg>
  )
}

function QueryThumbView({ t }: { t: QueryThumb }) {
  if (t.columnCount === 0) return <Empty text="未登记输出列" />
  const w = (THUMB_W - 12) / Math.max(1, t.columns.length)
  return (
    <div className="w-full h-full px-1.5 py-1.5 flex flex-col gap-1 text-[10px] leading-none">
      <div className="flex gap-0.5">
        {t.columns.map((col, i) => (
          <span key={i} style={{ width: w }} className="truncate rounded-sm bg-info-soft text-info px-1 py-1 font-medium">
            {col}
          </span>
        ))}
      </div>
      {[0, 1].map((r) => (
        <div key={r} className="flex gap-0.5 px-1">
          {t.columns.map((_, i) => (
            <span key={i} style={{ width: w - 4 }} className="h-[5px] my-[2px] rounded-full bg-line-strong/70" />
          ))}
        </div>
      ))}
      <div className="mt-auto text-muted">
        {t.columnCount} 列{t.columnCount > t.columns.length ? `（显示前 ${t.columns.length} 列）` : ''}
        {t.paramCount > 0 ? ` · ${t.paramCount} 个参数` : ''}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="w-full h-full grid place-items-center text-[11px] text-subtle">{text}</div>
}

export function ThumbView({ thumb, missing, consumer }: { thumb?: Thumb; missing?: boolean; consumer?: 'agent' | 'home' }) {
  if (missing) return <div className="w-full h-full grid place-items-center text-[11px] text-danger">已删除，引用它的地方需要修改</div>
  if (consumer === 'agent') {
    return (
      <Svg>
        <rect x={10} y={10} width={110} height={16} rx={8} style={{ fill: c('surface-3') }} />
        <rect x={70} y={32} width={112} height={16} rx={8} style={{ fill: c('success', 0.25) }} />
        <rect x={10} y={52} width={70} height={6} rx={3} style={{ fill: c('line-strong') }} />
      </Svg>
    )
  }
  if (consumer === 'home') {
    return (
      <Svg>
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={8 + i * 45} y={8} width={41} height={18} rx={3} style={{ fill: c('success', 0.18), stroke: c('success', 0.6) }} strokeWidth={0.8} />
        ))}
        <rect x={8} y={30} width={86} height={26} rx={3} style={{ fill: c('chart-1', 0.2), stroke: c('chart-1', 0.6) }} strokeWidth={0.8} />
        <rect x={98} y={30} width={86} height={26} rx={3} style={{ fill: c('chart-2', 0.2), stroke: c('chart-2', 0.6) }} strokeWidth={0.8} />
      </Svg>
    )
  }
  if (!thumb) return null
  if (thumb.kind === 'dashboard') return <DashboardThumbView t={thumb} />
  if (thumb.kind === 'query') return <QueryThumbView t={thumb} />
  switch (thumb.type) {
    case 'line':
      return <LineThumb t={thumb} />
    case 'pie':
      return <PieThumb />
    case 'kpi':
      return <KpiThumb />
    case 'waterfall':
      return <WaterfallThumb />
    case 'sankey':
      return <SankeyThumb />
    case 'table':
      return <TableThumb />
    default:
      return <BarThumb t={thumb} />
  }
}
