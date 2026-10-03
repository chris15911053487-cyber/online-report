/**
 * 通用界面组件。只用语义色（见 tailwind.config.js / theme/themes.css），六套主题下自动跟随。
 * 新页面优先组合这些组件；需要新的外观变体时在这里加，不要在页面里写颜色。
 */
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Check, Inbox, X } from 'lucide-react'
import { cn, inputClass, monoInputClass } from './classes'


// ─── 按钮 ─────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
  secondary: 'bg-surface text-fg border border-line hover:bg-surface-2',
  ghost: 'text-fg-2 hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
  soft: 'bg-primary-soft text-primary hover:opacity-90',
}
const BUTTON_SIZES = { sm: 'h-8 px-3 text-[13px] gap-1', md: 'h-10 px-4 text-sm gap-1.5', lg: 'h-12 px-5 text-[15px] gap-2' }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: keyof typeof BUTTON_SIZES
  block?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'primary', size = 'md', block, icon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none select-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({ className, label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn('inline-flex items-center justify-center w-8 h-8 rounded-lg text-muted hover:text-fg hover:bg-surface-2 transition-colors', className)}
      {...rest}
    >
      {children}
    </button>
  )
}

// ─── 卡片 / 区块 / 页头 ──────────────────────────────────────────────────────

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('bg-surface border border-line rounded-xl shadow-sm', className)} {...rest}>
      {children}
    </div>
  )
}

export function Section({ title, hint, actions, children, className }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-4', className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {hint && <p className="text-xs text-muted mt-0.5">{hint}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </Card>
  )
}

export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-end justify-between gap-3 flex-wrap', className)}>
      <div className="min-w-0">
        <h2 className="font-display text-lg font-semibold text-fg">{title}</h2>
        {description && <p className="text-[13px] text-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

// ─── 徽标 ─────────────────────────────────────────────────────────────────────

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'accent'
const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
}
export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap', BADGE_TONES[tone], className)}>{children}</span>
}

// ─── 分段切换 / 页签 ──────────────────────────────────────────────────────────

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  dataAttrs?: Record<string, string>
}

export function Segmented<T extends string>({ options, value, onChange, className, size = 'md' }: { options: SegmentOption<T>[]; value: T | null | undefined; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="tablist" className={cn('flex p-1 gap-1 bg-surface-2 border border-line rounded-lg', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            {...o.dataAttrs}
            className={cn(
              'flex-1 rounded-md transition-colors whitespace-nowrap',
              size === 'sm' ? 'py-1 text-xs' : 'py-1.5 text-[13px]',
              on ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Tabs<T extends string>({ options, value, onChange, className }: { options: SegmentOption<T>[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('flex gap-1 border-b border-line', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn('px-3 py-2 text-[13px] -mb-px border-b-2 transition-colors', on ? 'border-primary text-fg font-semibold' : 'border-transparent text-muted hover:text-fg')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── 表单 ─────────────────────────────────────────────────────────────────────


export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <label className="block text-[13px] font-medium text-fg-2 mb-1">{label}</label>}
      {children}
      {error ? <p className="text-[11px] text-danger mt-1">{error}</p> : hint ? <p className="text-[11px] text-subtle mt-1">{hint}</p> : null}
    </div>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...rest} />
}
export function Textarea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cn(mono ? monoInputClass : inputClass, className)} {...rest} />
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputClass, 'pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

/** 视觉复选框（不含 input，用于整行可点的列表/表格） */
export function CheckMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] border-[1.5px] flex-shrink-0 transition-colors',
        checked ? 'bg-primary border-primary text-primary-fg' : 'bg-surface border-line-strong',
        className,
      )}
    >
      {checked && <Check className="w-3 h-3" strokeWidth={3} />}
    </span>
  )
}

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cn('inline-flex items-center gap-2 cursor-pointer text-sm text-fg-2', className)}>
      <input type="checkbox" className="w-4 h-4 accent-[rgb(var(--c-primary))]" {...rest} />
      {label}
    </label>
  )
}

// ─── 表格 ─────────────────────────────────────────────────────────────────────

/** 表格外壳：横向滚动容器；表头/单元格样式用 ui/classes.ts 的 thClass / tdClass */
export function TableWrap({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('overflow-x-auto bg-surface border border-line rounded-xl', className)}>{children}</div>
}

// ─── 列表行 ───────────────────────────────────────────────────────────────────

export function ListRow({ icon, title, description, trailing, onClick, danger, className, ...rest }: { id?: string; icon?: ReactNode; title: ReactNode; description?: ReactNode; trailing?: ReactNode; onClick?: () => void; danger?: boolean; className?: string } & { [k: `data-${string}`]: string }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn('w-full flex items-center gap-3 px-4 py-3 text-left border-t border-line first:border-t-0 transition-colors', onClick && 'hover:bg-surface-2', className)}
      {...rest}
    >
      {icon && <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', danger ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary')}>{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className={cn('block text-sm font-medium truncate', danger ? 'text-danger' : 'text-fg')}>{title}</span>
        {description && <span className="block text-xs text-muted truncate mt-0.5">{description}</span>}
      </span>
      {trailing}
    </Tag>
  )
}

// ─── 弹窗 ─────────────────────────────────────────────────────────────────────

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  const width = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-3xl' : 'max-w-lg'
  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cn('w-full bg-surface border border-line shadow-lg rounded-t-2xl sm:rounded-2xl max-h-[90vh] flex flex-col', width)}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-line">
            <h3 className="font-display text-base font-semibold text-fg">{title}</h3>
            <IconButton label="关闭" onClick={onClose}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-4 py-3 border-t border-line safe-bottom">{footer}</div>}
      </div>
    </div>
  )
}

// ─── 空状态 / 骨架 / KPI ──────────────────────────────────────────────────────

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-4 gap-2', className)}>
      <span className="w-11 h-11 rounded-xl bg-surface-2 text-subtle flex items-center justify-center">{icon ?? <Inbox className="w-5 h-5" />}</span>
      <p className="text-sm font-medium text-fg-2">{title}</p>
      {description && <p className="text-xs text-muted max-w-xs">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-3', className)} />
}

export function KpiCard({ label, value, unit, delta, deltaTone = 'neutral', onClick, className }: { label: ReactNode; value: ReactNode; unit?: ReactNode; delta?: ReactNode; deltaTone?: 'good' | 'bad' | 'neutral'; onClick?: () => void; className?: string }) {
  const tone = deltaTone === 'good' ? 'text-success' : deltaTone === 'bad' ? 'text-danger' : 'text-muted'
  return (
    <Card className={cn('p-3.5 flex flex-col gap-0.5', onClick && 'cursor-pointer hover:border-primary/40 transition-colors', className)} onClick={onClick}>
      <span className="text-xs text-muted">{label}</span>
      <span className="num text-[22px] font-semibold text-fg leading-tight">
        {value}
        {unit && <small className="font-sans text-xs font-normal text-muted ml-0.5">{unit}</small>}
      </span>
      {delta && <span className={cn('num text-xs font-medium', tone)}>{delta}</span>}
    </Card>
  )
}
