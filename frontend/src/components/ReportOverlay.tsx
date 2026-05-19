import { useEffect, useRef, type ReactNode } from 'react'

interface ReportOverlayProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export default function ReportOverlay({ title, onClose, children }: ReportOverlayProps) {
  const openedAt = useRef(Date.now())

  useEffect(() => {
    openedAt.current = Date.now()
  }, [])

  const handleBackdropClick = () => {
    if (Date.now() - openedAt.current > 450) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[800] flex items-end justify-center bg-black/60 modal"
      role="dialog"
      onClick={handleBackdropClick}
    >
      <div
        className="flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="text-2xl text-gray-400" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}
