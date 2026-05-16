import { useStore } from '../store'

export default function Toast() {
  const { toastMessage } = useStore()
  if (!toastMessage) return null
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-6 py-3 rounded-2xl shadow-lg text-sm z-[999] max-w-[85vw] text-center whitespace-pre-wrap">
      {toastMessage}
    </div>
  )
}
