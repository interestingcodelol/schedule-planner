import { useEffect, useRef } from 'react'
import { Sparkles, X } from 'lucide-react'
import { changelog, type ChangeType } from '../lib/changelog'
import { useFocusTrap } from '../lib/useFocusTrap'

type Props = { onClose: () => void }

const TAG: Record<ChangeType, { label: string; className: string }> = {
  new: {
    label: 'New',
    className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  improved: {
    label: 'Improved',
    className: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  },
  fixed: {
    label: 'Fixed',
    className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
}

export function WhatsNew({ onClose }: Props) {
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="What's new"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="glass-card rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden focus:outline-none"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-200/60 dark:border-gray-700/60">
          <Sparkles className="w-4 h-4 text-blue-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-200">
            What's New
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-6">
          {changelog.map((entry) => (
            <section key={entry.id}>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">
                  {entry.title}
                </h3>
                <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
                  {entry.date}
                </span>
              </div>
              <ul className="space-y-2">
                {entry.changes.map((c, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span
                      className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${TAG[c.type].className}`}
                    >
                      {TAG[c.type].label}
                    </span>
                    <span className="text-xs leading-snug text-gray-600 dark:text-gray-300">
                      {c.text}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
