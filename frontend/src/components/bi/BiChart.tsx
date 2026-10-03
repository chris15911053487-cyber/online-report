/**
 * 看板用的 ECharts 容器：支持点击事件（映射回数据行）与容器尺寸变化自适应。
 * 与 ChartRenderer 不同：option 由 biOption 在代码里生成，不做函数字符串还原。
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export interface BiChartClick {
  dataIndex: number
  seriesName?: string
  x: number
  y: number
}

interface Props {
  option: Record<string, unknown>
  height: number
  onPick?: (e: BiChartClick) => void
  /** 屏幕阅读器用的图表说明 */
  ariaLabel?: string
}

interface EchartsClickParams {
  componentType?: string
  dataIndex?: number
  seriesName?: string
  event?: { event?: { clientX?: number; clientY?: number } }
}

export default function BiChart({ option, height, onPick, ariaLabel }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const onPickRef = useRef(onPick)

  useEffect(() => {
    onPickRef.current = onPick
  })

  // 初始化一次；容器尺寸变化（左栏收起、页签切回可见）时自适应
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    chart.on('click', (raw) => {
      const p = raw as EchartsClickParams
      if (p.componentType !== 'series' || typeof p.dataIndex !== 'number') return
      const native = p.event?.event
      const rect = el.getBoundingClientRect()
      onPickRef.current?.({
        dataIndex: p.dataIndex,
        seriesName: p.seriesName,
        x: native?.clientX ?? rect.left + rect.width / 2,
        y: native?.clientY ?? rect.top + rect.height / 2,
      })
    })
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={elRef} style={{ height, width: '100%' }} role="img" aria-label={ariaLabel} />
}
