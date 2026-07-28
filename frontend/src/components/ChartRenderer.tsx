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

  // Initialize chart once
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

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
  }, [option])

  // Resize chart when toggling fullscreen (container dimensions change)
  useEffect(() => {
    // Small delay to let CSS transition / layout complete
    const timer = setTimeout(() => {
      chartRef.current?.resize()
    }, 60)
    return () => clearTimeout(timer)
  }, [fullscreen])

  // Close fullscreen on Escape key
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setFullscreen(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
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

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-[9999] bg-white flex flex-col'
          : 'relative w-full h-64 my-2 rounded-lg border border-slate-200 bg-white group'
      }
    >
      {/* Fullscreen header */}
      {fullscreen && (
        <div className="flex-none flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 active:bg-blue-100 rounded-lg transition-colors"
            aria-label="返回"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            返回
          </button>
          <span className="text-sm text-slate-500">图表全屏</span>
          <div className="w-16" />
        </div>
      )}

      {/* Chart container - always the same element */}
      <div
        ref={containerRef}
        className={fullscreen ? 'flex-1 min-h-0 w-full' : 'w-full h-full'}
      />

      {/* Fullscreen toggle button (normal mode) */}
      {!fullscreen && (
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
      )}
    </div>
  )
}
