import { useToast } from '../hooks/useToast'

export default function Toast() {
  const { message } = useToast()

  if (!message) return null

  return (
    <div
      className="fixed bottom-20 left-1/2 z-[100] max-w-[90vw] -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-3 text-center text-sm text-white shadow-lg"
      role="status"
    >
      {message}
    </div>
  )
}
