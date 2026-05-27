import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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

  if (!toast || typeof document === 'undefined') return null

  // Render in a top-layer portal so toasts are always visible above modals
  // (Settings, day popovers, etc. sit at z-50). Anchoring this inline in the
  // header meant any toast fired from within a modal appeared behind it.
  return createPortal(
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 px-4 py-2 rounded-xl bg-white dark:bg-gray-800 text-sm shadow-2xl ring-1 ring-black/10 dark:ring-white/10 animate-slide-up max-w-[calc(100vw-2rem)]">
      <span className="min-w-0 break-words text-gray-700 dark:text-gray-200">{toast.message}</span>
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
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>,
    document.body,
  )
}
