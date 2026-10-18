/**
 * 紧凑多选下拉（看板多选筛选、参数试运行 / 固定值）。
 * 勾选只改草稿，收起时才提交（避免每点一项全部卡片重查）；不选 = 全部。选项多时带搜索。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CheckMark } from '../../ui'
import { cn } from '../../ui/classes'
import { joinValues, type BiOption } from '../../utils/bi'

type Item = string | number

export default function MultiSelect({
  id,
  options,
  value,
  onChange,
  className,
  allLabel = '全部',
  disabled,
}: {
  id?: string
  options: BiOption[]
  value: Item[] | null
  onChange: (v: Item[] | null) => void
  className?: string
  allLabel?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) commit(draft)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && commit(draft)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // commit 依赖最新 draft，随 draft 重新挂载即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft])

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
    <div ref={box} className="relative">
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
        <div className="absolute left-0 top-full mt-1 z-30 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-lg p-1.5">
          {options.length > 8 && (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索"
              className="w-full h-7 px-2 mb-1 rounded-md border border-line bg-surface text-[12.5px] text-fg focus:outline-none focus:border-primary"
            />
          )}
          <ul role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto">
            {shown.map((o) => {
              const v = String(o.value)
              const on = draft.includes(v)
              return (
                <li key={v} role="option" aria-selected={on}>
                  <button type="button" onClick={() => flip(v)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[12.5px] text-fg-2 hover:bg-surface-2">
                    <CheckMark checked={on} />
                    <span className="truncate">{o.label}</span>
                  </button>
                </li>
              )
            })}
            {shown.length === 0 && <li className="px-2 py-2 text-[12px] text-subtle">没有匹配的选项</li>}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-line mt-1 pt-1.5 px-1">
            <button type="button" className="text-[12px] text-muted hover:text-fg" onClick={() => setDraft([])}>
              清空（{allLabel}）
            </button>
            <button type="button" className="text-[12px] font-medium text-primary hover:underline" onClick={() => commit(draft)}>
              确定{draft.length ? `（${draft.length}）` : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
