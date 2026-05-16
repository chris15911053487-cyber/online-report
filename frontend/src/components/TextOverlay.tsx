import { useStore } from '../store'
import ReportOverlay from './ReportOverlay'

interface TextOverlayProps {
  title: string
  text: string
  onClose: () => void
}

export default function TextOverlay({ title, text, onClose }: TextOverlayProps) {
  const showToast = useStore((s) => s.showToast)

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        showToast('已复制到剪贴板')
        return
      }
    } catch { /* fallback below */ }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      showToast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制')
    } catch {
      showToast('复制失败，请手动选择文本复制')
    }
  }

  return (
    <ReportOverlay title={title} onClose={onClose}>
      <div className="mb-3 flex justify-end">
        <button
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white active:bg-sky-600"
          onClick={handleCopy}
        >
          复制全部
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words text-sm text-slate-800">{text}</pre>
    </ReportOverlay>
  )
}
