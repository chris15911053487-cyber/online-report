/** 通用样式类名常量与 cn 工具（与 ui/index.tsx 的组件配套；单独成文件以便组件文件只导出组件） */

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ')

export const inputClass =
  'w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg placeholder:text-subtle transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-surface-2 disabled:text-muted'
export const monoInputClass = inputClass + ' font-mono text-[12px] leading-relaxed'

export const tableClass = 'w-full border-collapse text-sm'
export const thClass = 'px-3 py-2.5 text-left text-xs font-medium text-muted bg-surface-2 whitespace-nowrap border-b border-line'
export const tdClass = 'px-3 py-2.5 text-fg-2 border-b border-line'
