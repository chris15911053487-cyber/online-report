/**
 * 按参数定义输入一个取值（试运行、图表固定值、看板卡片覆盖共用）：
 * 可选值 → 下拉（多选参数 → 多选下拉）；选项来自查询 → 取到后同上，取不到退回文本；
 * 是/否 → 下拉；月份 / 日期 / 年份类数字 → 可选「本月 / 上月 …」动态值或指定；数字带范围；多选无选项 → 逗号分隔文本。
 * 不合法的值标红并提示（与后端 bi-params.js 同规则）。
 */
import type { BiParamDef, BiValue } from '../../../utils/bi'
import { PARAM_TOKENS, paramValueProblem } from '../../../utils/biAdmin'
import { useBiOptions } from '../../../utils/biOptions'
import { cn, compactInputClass } from '../../../ui/classes'
import MultiSelect from '../MultiSelect'

export default function ParamValueInput({
  param,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  param: BiParamDef
  value: BiValue | undefined
  onChange: (v: BiValue) => void
  ariaLabel: string
  className?: string
}) {
  const { options, loading, error } = useBiOptions(param.options, param.optionsQuery)
  const problem = paramValueProblem(param, value)
  const cls = cn(compactInputClass, problem && 'border-danger', className)
  const text = value == null ? '' : Array.isArray(value) ? value.join(',') : String(value)
  const hasOptions = !!param.options?.length || !!param.optionsQuery

  if (hasOptions && options && !error) {
    if (param.type === 'list') {
      const arr = Array.isArray(value) ? value : value == null || value === '' ? null : String(value).split(',').map((x) => x.trim()).filter(Boolean)
      return <MultiSelect className={cn(cls, 'w-full')} options={options} value={arr} onChange={(v) => onChange(v)} allLabel="（空 = 全部）" />
    }
    const known = options.some((o) => String(o.value) === text)
    return (
      <select
        className={cls}
        aria-label={ariaLabel}
        title={problem || undefined}
        value={text}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value)
          onChange(opt ? opt.value : e.target.value)
        }}
      >
        <option value="">（空）</option>
        {text && !known && <option value={text}>{text}（不在可选值中）</option>}
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {String(o.value) === o.label ? o.label : `${o.label}（${o.value}）`}
          </option>
        ))}
      </select>
    )
  }
  if (hasOptions && loading) {
    return (
      <select className={cls} aria-label={ariaLabel} disabled>
        <option>选项加载中…</option>
      </select>
    )
  }
  if (param.type === 'bool') {
    return (
      <select className={cls} aria-label={ariaLabel} value={text} onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'true')}>
        <option value="">（空）</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    )
  }

  // 数字只有年份类参数才给「今年 / 去年」
  const tokens = param.type === 'number' && !/year|yr/i.test(param.name) ? undefined : PARAM_TOKENS[param.type]
  const isToken = !!tokens?.some((t) => t.value === text)
  const input = (
    <input
      className={cls}
      aria-label={ariaLabel}
      title={problem || error || undefined}
      type={param.type === 'date' ? 'date' : param.type === 'month' ? 'month' : param.type === 'number' ? 'number' : 'text'}
      min={param.min}
      max={param.max}
      placeholder={param.type === 'list' ? '多个用逗号分隔' : param.type === 'month' ? '2026-09' : undefined}
      value={text}
      onChange={(e) => {
        const v = e.target.value
        onChange(param.type === 'number' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v)
      }}
    />
  )
  if (!tokens) return input
  // 月份 / 日期 / 年份：可选动态值（按当天解析），或指定一个值
  return (
    <div className="flex gap-1.5 min-w-0">
      <select
        className={cn(compactInputClass, 'w-auto shrink-0')}
        aria-label={`${ariaLabel} 方式`}
        value={isToken ? text : 'custom'}
        onChange={(e) => onChange(e.target.value === 'custom' ? '' : e.target.value)}
      >
        <option value="custom">指定</option>
        {tokens.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      {!isToken && input}
    </div>
  )
}
