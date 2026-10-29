/**
 * 紧凑多选下拉（看板多选筛选、参数试运行 / 固定值）。
 * 弹出层同 ui/pickers（手机底部面板、PC 浮层）。勾选只改草稿，收起时才提交（避免每点一项全部卡片重查）；不选 = 全部。选项多时带搜索。
 */
import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CheckMark } from '../../ui'
import { cn } from '../../ui/classes'
import { PickerPopup } from '../../ui/pickers'
import { useIsPc } from '../../hooks/useMediaQuery'
import { joinValues, type BiOption } from '../../utils/bi'

type Item = string | number

export default function MultiSelect({
  id,
  options,
  value,
  onChange,
  className,
  allLabel = '全部',
  title,
  disabled,
}: {
  id?: string
  options: BiOption[]
  value: Item[] | null
  onChange: (v: Item[] | null) => void
  className?: string
  allLabel?: string
  /** 手机面板标题 */
  title?: string
  disabled?: boolean
}) {
  const isPc = useIsPc()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const selected = useMemo(() => (value || []).map(String), [value])

  const commit = (next: string[]) => {
    setOpen(false)
    if (next.length === selected.length && next.every((x) => selected.includes(x))) return
    // 还原成选项里的原始值（数字仍是数字）；按选项顺序
    const vals = options.filter((o) => next.includes(String(o.value))).map((o) => o.value as Item)
    const extra = next.filter((x) => !options.some((o) => String(o.value) === x))
    const all = [...vals, ...extra]
    onChange(all.length ? all : null)
  }

  const toggleOpen = () => {
    if (open) return commit(draft)
    setDraft(selected)
    setQ('')
    setOpen(true)
  }
  const labelOf = (v: string) => options.find((o) => String(o.value) === v)?.label ?? v
  const summary = selected.length === 0 ? allLabel : joinValues(selected.map(labelOf))
  const shown = q.trim() ? options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(q.trim().toLowerCase())) : options
  const flip = (v: string) => setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]))

  return (
    <div ref={setBox} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected.length > 3 ? selected.map(labelOf).join('、') : undefined}
        onClick={toggleOpen}
        className={cn('inline-flex items-center justify-between gap-1.5 text-left max-w-[16rem]', className)}
      >
        <span className={cn('truncate', selected.length === 0 && 'text-muted')}>{summary}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-subtle" />
      </button>
      {open && (
        <PickerPopup
          anchor={box}
          onClose={() => commit(draft)}
          title={title}
          footer={
            <>
              <button type="button" className="px-1 py-1 text-sm text-muted hover:text-fg" onClick={() => setDraft([])}>
                清空（{allLabel}）
              </button>
              <button type="button" className="px-1 py-1 text-sm font-medium text-primary" onClick={() => commit(draft)}>
                确定{draft.length ? `（${draft.length}）` : ''}
              </button>
            </>
          }
        >
          {options.length > 8 && (
            <div className={cn('border-b border-line', isPc ? 'p-2' : 'px-4 py-2.5')}>
              <input
                autoFocus={isPc}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索"
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-subtle focus:border-primary focus:outline-none"
              />
            </div>
          )}
          <ul role="listbox" aria-multiselectable className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', isPc ? 'p-1' : 'px-2 py-1')}>
            {shown.map((o) => {
              const v = String(o.value)
              const on = draft.includes(v)
              return (
                <li key={v} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => flip(v)}
                    className={cn('flex w-full items-center gap-2 rounded-lg text-left text-fg-2 hover:bg-surface-2', isPc ? 'px-2 py-1.5 text-[13px]' : 'px-3 py-3 text-[15px]')}
                  >
                    <CheckMark checked={on} />
                    <span className="min-w-0 break-all">{o.label}</span>
                  </button>
                </li>
              )
            })}
            {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-subtle">没有匹配的选项</li>}
          </ul>
        </PickerPopup>
      )}
    </div>
  )
}
