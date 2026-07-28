import { useEffect, useRef, useState, useCallback } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, GraphChart } from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart, LineChart, PieChart, GraphChart,
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
  const [fullscreen, setFullscreen] = useState(false)

  // Initialize / re-initialize chart whenever the container mounts or option changes
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // Dispose previous instance if any
    if (chartRef.current) {
      chartRef.current.dispose()
      chartRef.current = null
    }

    const chart = echarts.init(el)
    chartRef.current = chart
    chart.setOption(reviveFunctions(option) as echarts.EChartsCoreOption)

    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [option, fullscreen]) // re-run when fullscreen toggles (container DOM changes)

  // Close fullscreen on Escape key
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullscreen])

  // Prevent body scroll when fullscreen
  useEffect(() => {
    if (fullscreen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [fullscreen])

  const toggleFullscreen = useCallback(() => {
    setFullscreen((v) => !v)
  }, [])

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[9999] bg-white flex flex-col">
        {/* Header bar */}
        <div className="flex-none flex items-center justify-end px-4 py-2 border-b border-slate-200 bg-slate-50">
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-200 rounded-md transition-colors"
            aria-label="退出全屏"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            退出全屏
          </button>
        </div>
        {/* Chart container fills remaining space */}
        <div ref={containerRef} className="flex-1 min-h-0 w-full" />
      </div>
    )
  }

  return (
    <div className="relative w-full h-64 my-2 rounded-lg border border-slate-200 bg-white group">
      <div ref={containerRef} className="w-full h-full" />
      {/* Fullscreen button - visible on hover / tap */}
      <button
        onClick={toggleFullscreen}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-white/80 border border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-white shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="全屏查看"
        title="全屏查看"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0 0l-5-5m-7 14H4m0 0v-4m0 4l5-5m11 5h-4m4 0v-4m0 4l-5-5" />
        </svg>
      </button>
    </div>
  )
}
