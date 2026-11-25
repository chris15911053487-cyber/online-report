import { useSyncExternalStore } from 'react'

/** 不弹键盘的 input 类型 */
const NON_TEXT_INPUT = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** 当前聚焦的元素会弹出软键盘（文本输入框 / 多行框 / 可编辑区域） */
function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT.has(el.type) && !el.readOnly && !el.disabled
  return el.isContentEditable
}

function subscribe(cb: () => void) {
  // focusout 时 activeElement 还没切走，下一帧再判断
  const onOut = () => window.setTimeout(cb, 0)
  document.addEventListener('focusin', cb)
  document.addEventListener('focusout', onOut)
  return () => {
    document.removeEventListener('focusin', cb)
    document.removeEventListener('focusout', onOut)
  }
}

/**
 * 手机软键盘是否弹出（按「有文本输入框聚焦」判断）。
 * 用于键盘弹出时收起底部 Tab：安卓会把视口缩到键盘上方，fixed 在底部的 Tab 会被顶到键盘上面。
 * PC 上调用方自行忽略。
 */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, editableFocused, () => false)
}
