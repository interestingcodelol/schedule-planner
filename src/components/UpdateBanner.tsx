import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import { updateAvailable, onUpdateChange } from '../main'

export function UpdateBanner() {
  const [show, setShow] = useState(updateAvailable)

  useEffect(() => {
    const unsub = onUpdateChange(() => setShow(updateAvailable))
    return () => { unsub() }
  }, [])

  if (!show) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center py-2 px-4 bg-blue-600 text-white text-sm font-medium shadow-lg animate-slide-down">
      <span>A new version is available.</span>
      <button
        onClick={() => window.location.reload()}
        className="ml-3 inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 hover:bg-white/30 active:scale-95 rounded-lg transition-all text-sm font-semibold"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Refresh
      </button>
      <button
        onClick={() => setShow(false)}
        className="ml-2 px-2 py-1 text-white/70 hover:text-white transition-colors text-xs"
      >
        Later
      </button>
    </div>
  )
}
