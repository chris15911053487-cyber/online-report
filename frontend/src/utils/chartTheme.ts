/**
 * ECharts 跟随界面主题：在 setOption 前给 option 补上当前主题的系列色、文字色、轴线色、提示框底色。
 * 只补「option 里没写」的部分：AI 生成的图表若自带 color 等，按数据内容保留原样。
 * 主题切换时由图表组件重新调用（见 BiChart / ChartRenderer 的 useThemeChange）。
 */
import { readChartPalette } from '../theme'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** 只在目标里缺少时填入（浅层逐键，嵌套对象递归） */
function fill(target: Obj, defaults: Obj): Obj {
  const out: Obj = { ...target }
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] === undefined) out[k] = v
    else if (isObj(out[k]) && isObj(v)) out[k] = fill(out[k] as Obj, v)
  }
  return out
}

const mapAxes = (axes: unknown, defaults: Obj) => {
  if (Array.isArray(axes)) return axes.map((a) => (isObj(a) ? fill(a, defaults) : a))
  return isObj(axes) ? fill(axes, defaults) : axes
}

export function themedChartOption(option: Obj): Obj {
  const p = readChartPalette()
  const textStyle = { color: p.text, ...(p.font ? { fontFamily: p.font } : {}) }
  const axisDefaults: Obj = {
    axisLabel: { color: p.text },
    nameTextStyle: { color: p.text },
    axisLine: { lineStyle: { color: p.axisLine } },
    axisTick: { lineStyle: { color: p.axisLine } },
    splitLine: { lineStyle: { color: p.splitLine } },
  }
  let out = fill(option, {
    color: p.series,
    backgroundColor: 'transparent',
    textStyle,
    tooltip: { backgroundColor: p.tooltipBg, borderColor: p.tooltipBorder, textStyle: { color: p.strongText } },
    title: { textStyle: { color: p.strongText }, subtextStyle: { color: p.text } },
  })
  if (out.legend !== undefined) {
    out.legend = Array.isArray(out.legend)
      ? out.legend.map((l) => (isObj(l) ? fill(l, { textStyle: { color: p.text }, pageTextStyle: { color: p.text } }) : l))
      : isObj(out.legend)
        ? fill(out.legend, { textStyle: { color: p.text }, pageTextStyle: { color: p.text } })
        : out.legend
  }
  for (const key of ['xAxis', 'yAxis', 'radiusAxis', 'angleAxis']) {
    if (out[key] !== undefined) out = { ...out, [key]: mapAxes(out[key], axisDefaults) }
  }
  // 饼图标签、标线文字等默认用正文色
  if (Array.isArray(out.series)) {
    out.series = out.series.map((s) => (isObj(s) && s.type === 'pie' ? fill(s, { label: { color: p.strongText } }) : s))
  }
  return out
}
