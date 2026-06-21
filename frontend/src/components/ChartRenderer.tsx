import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart, LineChart, PieChart,
  TitleComponent, TooltipComponent, LegendComponent, GridComponent,
  CanvasRenderer,
])

interface ChartRendererProps {
  option: echarts.EChartsCoreOption
}

/** 递归将 option 中的 "function(...){...}" 字符串转为真正的函数 */
function reviveFunctions(obj: unknown): unknown {
  if (typeof obj === 'string' && /^function\s*\(/.test(obj.trim())) {
    try { return new Function('return (' + obj + ')')() } catch { return undefined }
  }
  if (Array.isArray(obj)) return obj.map(reviveFunctions)
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = reviveFunctions(v)
    return out
  }
  return obj
}

export default function ChartRenderer({ option }: ChartRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current)
    chartRef.current = chart
    chart.setOption(reviveFunctions(option) as echarts.EChartsCoreOption)
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [option])

  return <div ref={containerRef} className="w-full h-64 my-2 rounded-lg border border-slate-200 bg-white" />
}
