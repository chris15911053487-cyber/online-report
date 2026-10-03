/**
 * 应用内确认弹窗（替代 window.confirm）：`if (!(await confirmAsync({ message: '确定删除？' }))) return`
 * 弹窗本身由 ui/index.tsx 的 <ConfirmHost /> 渲染（App 根部挂载一次）。
 */
import { create } from 'zustand'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（删除等）：确认按钮用 danger 样式 */
  danger?: boolean
}

interface ConfirmState {
  request: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  settle: (ok: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  settle: (ok) => {
    const req = get().request
    set({ request: null })
    req?.resolve(ok)
  },
}))

export function confirmAsync(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === 'string' ? { message: opts } : opts
  // 同时只有一个确认框：新请求到来时，旧的按取消处理
  useConfirmStore.getState().request?.resolve(false)
  return new Promise((resolve) => useConfirmStore.setState({ request: { ...o, resolve } }))
}

/** 删除确认的常用写法 */
export const confirmDelete = (what: string) =>
  confirmAsync({ title: '确认删除', message: `确定删除${what}？此操作不可恢复。`, confirmLabel: '删除', danger: true })
