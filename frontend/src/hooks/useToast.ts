import { useStore } from '../store'

/** 全局轻提示（对应旧版 showToast） */
export function useToast() {
  const message = useStore((s) => s.toastMessage)
  const showToast = useStore((s) => s.showToast)
  const hideToast = useStore((s) => s.hideToast)
  return { message, showToast, hideToast }
}
