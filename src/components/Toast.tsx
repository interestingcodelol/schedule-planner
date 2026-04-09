import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'

type ToastData = {
  id: string
  message: string
  action?: { label: string; onClick: () => void }
  duration?: number
}

const toastListeners = new Set<(t: ToastData) => void>()

export function showToast(toast: Omit<ToastData, 'id'>) {
  const data: ToastData = { ...toast, id: crypto.randomUUID() }
  toastListeners.forEach((fn) => fn(data))
}

/**
 * Inline toast that sits in the header bar — not a floating overlay.
 * Shows the most recent notification, auto-dismisses.
 */
export function InlineToast() {
  const [toast, setToast] = useState<ToastData | null>(null)

  useEffect(() => {
    const handler = (t: ToastData) => setToast(t)
    toastListeners.add(handler)
    return () => { toastListeners.delete(handler) }
  }, [])

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
