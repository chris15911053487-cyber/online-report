/**
 * 看板用的 ECharts 容器：支持点击事件（映射回数据行）与容器尺寸变化自适应。
 * 与 ChartRenderer 不同：option 由 biOption 在代码里生成，不做函数字符串还原。
 */
import { useCallback, useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useThemeChange } from '../../theme'
import { themedChartOption } from '../../utils/chartTheme'

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
    // 悬浮提示会盖住点击浮层；提示本身也在这次点击里弹出，所以推迟一拍再收起
    const hideTipSoon = () => setTimeout(() => chart.isDisposed() || chart.dispatchAction({ type: 'hideTip' }), 0)
    chart.on('click', (raw) => {
      const p = raw as EchartsClickParams
      if (p.componentType !== 'series' || typeof p.dataIndex !== 'number' || !onPickRef.current) return
      const native = p.event?.event
      const rect = el.getBoundingClientRect()
      hideTipSoon()
      onPickRef.current({
        dataIndex: p.dataIndex,
        seriesName: p.seriesName,
        x: native?.clientX ?? rect.left + rect.width / 2,
        y: native?.clientY ?? rect.top + rect.height / 2,
      })
    })
    // 没点中任何图形（折线的小圆点、矮柱子很难点中）：点在绘图区内就按所在类目算。
    // 点中图形时 e.target 有值，交给上面的系列 click 处理
    chart.getZr().on('click', (e) => {
      if (e.target || !onPickRef.current) return
      const pt = [e.offsetX, e.offsetY]
      if (!chart.containPixel({ gridIndex: 0 }, pt)) return
      const opt = chart.getOption() as { xAxis?: { type?: string }[]; series?: { name?: string }[] }
      const horizontal = opt.xAxis?.[0]?.type !== 'category'
      const v = chart.convertFromPixel({ gridIndex: 0 }, pt) as number[] | null
      const dataIndex = Math.round(Number(v?.[horizontal ? 1 : 0]))
      if (!Number.isFinite(dataIndex) || dataIndex < 0) return
      const series = opt.series ?? []
      const native = e.event as unknown as { clientX?: number; clientY?: number }
      hideTipSoon()
      onPickRef.current({
        dataIndex,
        seriesName: series.length === 1 ? series[0].name : undefined,
        x: native.clientX ?? 0,
        y: native.clientY ?? 0,
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
    chartRef.current?.setOption(themedChartOption(option), { notMerge: true })
  }, [option])

  // 切换主题：按新主题的颜色重绘
  const redraw = useCallback(() => chartRef.current?.setOption(themedChartOption(option), { notMerge: true }), [option])
  useThemeChange(redraw)

  return <div ref={elRef} style={{ height, width: '100%' }} role="img" aria-label={ariaLabel} />
}
