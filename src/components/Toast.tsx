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

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([])

  useEffect(() => {
    const handler = (t: ToastData) => {
      setToasts((prev) => [...prev, t])
    }
    toastListeners.add(handler)
    return () => { toastListeners.delete(handler) }
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <div className="fixed top-4 right-48 z-50 flex flex-col gap-2 items-end">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration ?? 4000)
    return () => clearTimeout(timer)
  }, [toast.id, toast.duration, onDismiss])

  return (
    <div className="glass-card rounded-xl shadow-xl px-4 py-3 flex items-center gap-3 text-sm animate-slide-up max-w-xs">
      <span className="text-gray-700 dark:text-gray-200">{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick()
            onDismiss(toast.id)
          }}
          className="text-blue-500 hover:text-blue-400 font-semibold whitespace-nowrap transition-colors"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
