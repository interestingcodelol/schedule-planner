import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { subscribeToToasts, type ToastData } from '../lib/toastBus'

export function InlineToast() {
  const [toast, setToast] = useState<ToastData | null>(null)

  useEffect(() => subscribeToToasts(setToast), [])

  const dismiss = useCallback(() => setToast(null), [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismiss, toast.duration ?? 4000)
    return () => clearTimeout(timer)
  }, [toast, dismiss])

  if (!toast) return null

  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-gray-100 dark:bg-gray-800/80 text-sm animate-slide-up">
      <span className="text-gray-600 dark:text-gray-300">{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick()
            dismiss()
          }}
          className="text-blue-500 hover:text-blue-400 font-semibold whitespace-nowrap transition-colors"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={dismiss}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}
