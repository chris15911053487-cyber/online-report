/**
 * 使用说明书侧栏：从右侧滑出，边看说明边操作页面。
 * 内容来自 server/help/*.md（GET /help/docs/:slug），与 AI 助手检索的是同一批文件；
 * 配图写相对路径 images/xxx.png，这里改写到 /api/help/images/。
 */
import { useEffect, useState } from 'react'
import { BookOpen, X } from 'lucide-react'
import HelpDocContent from './HelpDocContent'
import { IconButton, Tabs } from '../ui'

export interface HelpDocTab {
  slug: string
  label: string
}

export default function HelpDocPanel({ open, onClose, tabs }: { open: boolean; onClose: () => void; tabs: HelpDocTab[] }) {
  const [slug, setSlug] = useState(tabs[0]?.slug ?? '')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <aside
      role="dialog"
      aria-label="使用说明"
      className="fixed top-0 right-0 bottom-0 z-[650] w-full sm:w-[min(44rem,92vw)] bg-surface border-l border-line shadow-lg flex flex-col"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <h3 className="font-display text-base font-semibold text-fg flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary" />
          使用说明
        </h3>
        <IconButton label="关闭" onClick={onClose}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>
      {tabs.length > 1 && <Tabs className="px-4 mt-1" value={slug} onChange={setSlug} options={tabs.map((t) => ({ value: t.slug, label: t.label }))} />}
      <div className="flex-1 overflow-y-auto px-5 py-4">{slug && <HelpDocContent slug={slug} />}</div>
    </aside>
  )
}
