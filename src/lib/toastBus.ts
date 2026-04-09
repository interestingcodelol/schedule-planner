export type ToastData = {
  id: string
  message: string
  action?: { label: string; onClick: () => void }
  duration?: number
}

type Listener = (toast: ToastData) => void

const listeners = new Set<Listener>()

export function showToast(toast: Omit<ToastData, 'id'>): void {
  const data: ToastData = { ...toast, id: crypto.randomUUID() }
  listeners.forEach((fn) => fn(data))
}

export function subscribeToToasts(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
