/**
 * 自绘的下拉选择 / 日期选择，替代原生 <select> 与 <input type="date|month|datetime-local">：
 * 原生控件的弹出层由系统绘制（安卓 / 钉钉是带圆点的对话框、日历是浏览器默认蓝），不跟主题。
 *
 * - 手机：底部弹出面板；PC：触发框下方的浮层（放不下时翻到上方）。浮层挂在 body 上，避免被父级 overflow 裁掉，
 *   也避免在 <label> 里点浮层空白处又触发按钮。
 * - 语音助手（public/js/voice.js）按 data-voice-* 找原生 select / input 填值：传入 voice 时渲染一个隐藏的原生控件承接。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useIsPc } from '../hooks/useMediaQuery'
import { cn } from './classes'
import {
  addMonths,
  displayDateValue,
  formatDateValue,
  inRange,
  monthGrid,
  normalizeDateValue,
  parseDateValue,
  todayParts,
  type DateMode,
} from '../utils/datePick'

/** 语音助手用的标注，原样放到隐藏的原生控件上 */
export type VoiceAttrs = { [k: `data-voice-${string}`]: string | undefined }

export interface PickerOption {
  value: string
  label: string
}

const TRIGGER_BASE = 'inline-flex w-full items-center justify-between gap-1.5 text-left disabled:cursor-not-allowed'

// ─── 弹出层：手机底部面板 / PC 浮层 ─────────────────────────────────────────────

/** 选择器的弹出层（也给 bi/MultiSelect 用）：点外面 / Esc / 手机遮罩都调 onClose */
export function PickerPopup({
  anchor,
  onClose,
  title,
  minWidth = 240,
  children,
  footer,
}: {
  anchor: HTMLElement | null
  onClose: () => void
  title?: ReactNode
  minWidth?: number
  children: ReactNode
  footer?: ReactNode
}) {
  const isPc = useIsPc()
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  // PC：贴着触发框定位；滚动 / 缩放时跟随
  useLayoutEffect(() => {
    if (!isPc || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const width = Math.max(r.width, minWidth)
      const h = panel.current?.offsetHeight ?? 0
      const below = r.bottom + 4
      const top = below + h > window.innerHeight - 8 && r.top - 4 - h > 8 ? r.top - 4 - h : below
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setPos({ left, top, width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [isPc, anchor, minWidth])

  useEffect(() => {
    // 捕获阶段拦下 Esc：所在的 Modal 不跟着关
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    if (isPc) document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [isPc, anchor, onClose])

  if (isPc) {
    return createPortal(
      <div
        ref={panel}
        className="fixed z-[750] flex max-h-[min(24rem,70vh)] flex-col rounded-xl border border-line bg-surface shadow-lg"
        style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: 'hidden', left: 0, top: 0 }}
      >
        {children}
        {footer && <div className="flex items-center justify-between gap-2 border-t border-line px-2.5 py-2">{footer}</div>}
      </div>,
      document.body,
    )
  }
  return createPortal(
    <div className="fixed inset-0 z-[750] flex items-end bg-black/40" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className="flex max-h-[75vh] w-full flex-col rounded-t-2xl bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h3 className="truncate text-base font-semibold text-fg">{title}</h3>
          <button type="button" aria-label="关闭" className="-mr-1 p-1 text-muted" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
        {footer && <div className="safe-bottom flex items-center justify-between gap-3 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ─── 下拉选择 ─────────────────────────────────────────────────────────────────

/** 一次最多列出的选项数；更多的靠搜索 */
const MAX_SHOWN = 200

export function SelectPicker({
  value,
  options,
  onChange,
  emptyLabel,
  placeholder = '请选择',
  title,
  disabled,
  loading,
  error,
  id,
  className,
  'aria-label': ariaLabel,
  voice,
}: {
  value: string
  options: PickerOption[]
  onChange: (v: string) => void
  /** 提供时在最前面加一个空值选项（如「全部」） */
  emptyLabel?: string
  placeholder?: string
  /** 手机面板标题 */
  title?: string
  disabled?: boolean
  /** 选项加载中 / 加载失败：触发框显示提示且不可点 */
  loading?: boolean
  error?: string
  id?: string
  className?: string
  'aria-label'?: string
  voice?: VoiceAttrs
}) {
  const isPc = useIsPc()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // 触发框元素用 state 存（渲染时要传给弹出层定位）
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)

  const all = useMemo(() => (emptyLabel != null ? [{ value: '', label: emptyLabel }, ...options] : options), [emptyLabel, options])
  const current = all.find((o) => o.value === value)
  const searchable = options.length > 8
  const kw = q.trim().toLowerCase()
  const matched = kw ? all.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(kw)) : all
  const shown = matched.slice(0, MAX_SHOWN)

  const text = loading ? '加载中…' : error ? '（加载失败）' : current ? current.label : value || placeholder
  const muted = loading || !!error || (!current && !value) || (current?.value === '' && emptyLabel != null)

  const close = () => setOpen(false)
  const pick = (v: string) => {
    setOpen(false)
    if (v !== value) onChange(v)
  }

  return (
    <>
      <button
        ref={setBtn}
        id={id}
        type="button"
        disabled={disabled || loading || !!error}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={error || undefined}
        onClick={() => {
          setQ('')
          setOpen((o) => !o)
        }}
        className={cn(TRIGGER_BASE, className)}
      >
        <span className={cn('min-w-0 truncate', muted && 'text-muted')}>{text}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {voice && (
        <select tabIndex={-1} aria-hidden="true" className="sr-only" value={value} onChange={(e) => onChange(e.target.value)} {...voice}>
          {!current && <option value={value}>{value}</option>}
          {all.map((o, i) => (
            <option key={`${o.value}-${i}`} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {open && (
        <PickerPopup anchor={btn} onClose={close} title={title || ariaLabel || placeholder}>
          {searchable && (
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
          <ul role="listbox" className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', isPc ? 'p-1' : 'px-2 py-1')}>
            {shown.map((o, i) => {
              const on = o.value === value
              return (
                <li key={`${o.value}-${i}`} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => pick(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg text-left',
                      isPc ? 'px-2.5 py-1.5 text-[13px]' : 'px-3 py-3 text-[15px]',
                      on ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2 hover:bg-surface-2 active:bg-surface-2',
                      o.value === '' && emptyLabel != null && !on && 'text-muted',
                    )}
                  >
                    <span className="min-w-0 flex-1 break-all">{o.label || o.value}</span>
                    {on && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                </li>
              )
            })}
            {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-subtle">没有匹配的选项</li>}
            {matched.length > shown.length && (
              <li className="px-3 py-2 text-center text-xs text-subtle">还有 {matched.length - shown.length} 项，输入关键字搜索</li>
            )}
          </ul>
        </PickerPopup>
      )}
    </>
  )
}

// ─── 日期 / 月份 / 日期时间 ──────────────────────────────────────────────────

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const pad2 = (n: number) => String(n).padStart(2, '0')

export function DatePicker({
  value,
  onChange,
  mode = 'date',
  min,
  max,
  clearable = true,
  placeholder,
  title,
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
  voice,
}: {
  /** date = YYYY-MM-DD，month = YYYY-MM，datetime = YYYY-MM-DDTHH:mm；空串 = 未选 */
  value: string
  onChange: (v: string) => void
  mode?: DateMode
  min?: string
  max?: string
  clearable?: boolean
  placeholder?: string
  title?: string
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
  voice?: VoiceAttrs
}) {
  const isPc = useIsPc()
  const [open, setOpen] = useState(false)
  // 触发框元素用 state 存（渲染时要传给弹出层定位）
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const today = todayParts()
  const sel = parseDateValue(value)
  // 面板里正在看的年月；「选月」为 true 时显示 12 个月（月份模式固定如此）
  const [view, setView] = useState({ y: today.y, m: today.m })
  const [pickMonth, setPickMonth] = useState(false)
  // datetime 先选日期再选时间，点「确定」才提交
  const [draft, setDraft] = useState(sel)

  const ph = placeholder ?? (mode === 'month' ? '选择月份' : mode === 'datetime' ? '选择日期时间' : '选择日期')
  const text = value ? displayDateValue(value, mode) : ph

  const openPanel = () => {
    const base = sel ?? today
    setView({ y: base.y, m: base.m })
    setPickMonth(mode === 'month')
    setDraft(sel ?? (mode === 'datetime' ? { ...today, mm: 0 } : null))
    setOpen(true)
  }
  const close = () => setOpen(false)
  const commit = (v: string) => {
    setOpen(false)
    if (v !== value) onChange(v)
  }

  const okDay = (y: number, m: number, d: number) => inRange(formatDateValue({ y, m, d }, 'date'), min, max)
  const okMonth = (y: number, m: number) => inRange(formatDateValue({ y, m }, 'month'), min, max)

  const clickDay = (y: number, m: number, d: number) => {
    if (mode === 'datetime') {
      setDraft((p) => ({ y, m, d, hh: p?.hh ?? 0, mm: p?.mm ?? 0 }))
      setView({ y, m })
    } else commit(formatDateValue({ y, m, d }, 'date'))
  }
  const clickMonth = (m: number) => {
    if (mode === 'month') commit(formatDateValue({ y: view.y, m }, 'month'))
    else {
      setView({ y: view.y, m })
      setPickMonth(false)
    }
  }

  const step = (delta: number) => (pickMonth ? setView((v) => ({ ...v, y: v.y + delta })) : setView((v) => addMonths(v.y, v.m, delta)))
  const isSelDay = (y: number, m: number, d: number) => {
    const s = mode === 'datetime' ? draft : sel
    return !!s && s.y === y && s.m === m && s.d === d
  }
  const cell = isPc ? 'h-8 text-[13px]' : 'h-11 text-[15px]'

  const footer = (
    <>
      {clearable && value ? (
        <button type="button" className="px-1 py-1 text-sm text-muted hover:text-fg" onClick={() => commit('')}>
          清空
        </button>
      ) : (
        <span />
      )}
      {mode === 'datetime' ? (
        <button
          type="button"
          disabled={!draft}
          className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-fg disabled:opacity-40"
          onClick={() => draft && commit(formatDateValue(draft, 'datetime'))}
        >
          确定
        </button>
      ) : (
        <button
          type="button"
          className="px-1 py-1 text-sm font-medium text-primary"
          disabled={mode === 'month' ? !okMonth(today.y, today.m) : !okDay(today.y, today.m, today.d)}
          onClick={() => commit(formatDateValue(today, mode))}
        >
          {mode === 'month' ? '本月' : '今天'}
        </button>
      )}
    </>
  )

  return (
    <>
      <button
        ref={setBtn}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openPanel())}
        className={cn(TRIGGER_BASE, className)}
      >
        <span className={cn('num min-w-0 truncate', !value && 'text-muted')}>{text}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-subtle" />
      </button>
      {voice && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          value={value}
          onChange={(e) => {
            const v = e.target.value.trim() ? normalizeDateValue(e.target.value, mode) : ''
            if (v != null) onChange(v)
          }}
          {...voice}
        />
      )}
      {open && (
        <PickerPopup anchor={btn} onClose={close} title={title || ariaLabel || ph} minWidth={272} footer={footer}>
          <div className={cn('select-none', isPc ? 'p-2.5' : 'px-4 py-3')}>
            <div className="mb-2 flex items-center justify-between">
              <button type="button" aria-label="上一页" className="rounded-lg p-1.5 text-muted hover:bg-surface-2" onClick={() => step(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="num rounded-lg px-2 py-1 text-sm font-semibold text-fg hover:bg-surface-2"
                onClick={() => mode !== 'month' && setPickMonth((p) => !p)}
              >
                {pickMonth ? `${view.y} 年` : `${view.y} 年 ${view.m} 月`}
              </button>
              <button type="button" aria-label="下一页" className="rounded-lg p-1.5 text-muted hover:bg-surface-2" onClick={() => step(1)}>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {pickMonth ? (
              <div className="grid grid-cols-3 gap-1.5">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                  const on = mode === 'month' ? sel?.y === view.y && sel?.m === m : view.m === m
                  const isNow = today.y === view.y && today.m === m
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={!okMonth(view.y, m)}
                      onClick={() => clickMonth(m)}
                      className={cn(
                        'rounded-lg disabled:opacity-30',
                        isPc ? 'h-9 text-[13px]' : 'h-12 text-[15px]',
                        on ? 'bg-primary font-semibold text-primary-fg' : isNow ? 'font-semibold text-primary hover:bg-surface-2' : 'text-fg-2 hover:bg-surface-2',
                      )}
                    >
                      {m} 月
                    </button>
                  )
                })}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-7 text-center text-xs text-subtle">
                  {WEEK.map((w) => (
                    <div key={w} className="py-1">
                      {w}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-y-0.5 text-center">
                  {monthGrid(view.y, view.m).map((c) => {
                    const on = isSelDay(c.y, c.m, c.d)
                    const isNow = c.y === today.y && c.m === today.m && c.d === today.d
                    return (
                      <button
                        key={`${c.m}-${c.d}`}
                        type="button"
                        disabled={!okDay(c.y, c.m, c.d)}
                        onClick={() => clickDay(c.y, c.m, c.d)}
                        className={cn(
                          'num mx-auto aspect-square rounded-full disabled:opacity-25',
                          cell,
                          on
                            ? 'bg-primary font-semibold text-primary-fg'
                            : isNow
                              ? 'font-semibold text-primary ring-1 ring-primary/50 hover:bg-surface-2'
                              : c.inMonth
                                ? 'text-fg-2 hover:bg-surface-2'
                                : 'text-subtle hover:bg-surface-2',
                        )}
                      >
                        {c.d}
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {mode === 'datetime' && !pickMonth && (
              <TimeRow
                hh={draft?.hh ?? 0}
                mm={draft?.mm ?? 0}
                disabled={!draft}
                onChange={(hh, mm) => setDraft((p) => (p ? { ...p, hh, mm } : p))}
              />
            )}
          </div>
        </PickerPopup>
      )}
    </>
  )
}

/** 时、分两列滚动选择 */
function TimeRow({ hh, mm, disabled, onChange }: { hh: number; mm: number; disabled: boolean; onChange: (hh: number, mm: number) => void }) {
  return (
    <div className={cn('mt-2 flex items-center gap-2 border-t border-line pt-2', disabled && 'pointer-events-none opacity-40')}>
      <span className="text-xs text-muted">时间</span>
      <TimeColumn count={24} value={hh} onPick={(v) => onChange(v, mm)} />
      <span className="text-muted">:</span>
      <TimeColumn count={60} value={mm} onPick={(v) => onChange(hh, v)} />
    </div>
  )
}

function TimeColumn({ count, value, onPick }: { count: number; value: number; onPick: (v: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  // 打开时把当前值滚到中间
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-v="${value}"]`)
    if (el && box.current) box.current.scrollTop = el.offsetTop - box.current.clientHeight / 2 + el.offsetHeight / 2
    // 只在挂载时定位，之后由用户滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div ref={box} className="relative h-28 flex-1 overflow-y-auto overscroll-contain rounded-lg bg-surface-2 p-1">
      {Array.from({ length: count }, (_, i) => i).map((i) => (
        <button
          key={i}
          type="button"
          data-v={i}
          onClick={() => onPick(i)}
          className={cn('num block w-full rounded-md py-1.5 text-center text-sm', i === value ? 'bg-primary font-semibold text-primary-fg' : 'text-fg-2 hover:bg-surface-3')}
        >
          {pad2(i)}
        </button>
      ))}
    </div>
  )
}
