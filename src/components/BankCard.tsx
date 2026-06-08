import { useEffect, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { Wallet, Plus, X } from 'lucide-react'
import { useAppState } from '../context'
import { showToast } from '../lib/toastBus'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * Bank Hours status card with inline management. The compact card matches the
 * other status cards; clicking it expands a panel (anchored to the card) to
 * add hours + a note and see/remove the history — no separate right-hand panel,
 * and no inner scrollbar (the whole page scrolls). Only rendered when bank
 * hours are enabled.
 */
export function BankCard() {
  const { state, addBankHours, removeBankHours, updateProfile } = useAppState()
  const [open, setOpen] = useState(false)
  const [hours, setHours] = useState('')
  const [note, setNote] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleAdd = () => {
    const h = Number(hours)
    if (!h || h <= 0) return
    if (h > 16) {
      const ok = window.confirm(
        `Add ${fmt(h)} bank hours? That's a large entry — confirm to proceed.`,
      )
      if (!ok) return
    }
    addBankHours({
      id: crypto.randomUUID(),
      date: format(new Date(), 'yyyy-MM-dd'),
      hours: h,
      note: note || undefined,
    })
    setHours('')
    setNote('')
    showToast({ message: `Added ${fmt(h)} bank hrs` })
  }

  const entries = [...(state.bankHoursLog || [])].sort((a, b) =>
    b.date.localeCompare(a.date),
  )
  const balance = state.profile.currentBankHours
  const hasBalanceNoLog = entries.length === 0 && balance > 0

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-tour="bank-hours"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Bank hours: ${fmt(balance)} hours — click to manage`}
        className="glass-card w-full text-left rounded-xl px-3 py-2.5 sm:px-4 sm:py-3 relative overflow-hidden min-h-[4.5rem] sm:min-h-[5.5rem] flex flex-col hover:bg-white/90 dark:hover:bg-gray-900/70 transition-colors"
      >
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-cyan-500" />
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400 text-xs sm:text-sm font-medium">
            <Wallet className="w-3.5 h-3.5 shrink-0 text-teal-500" />
            <span className="truncate">Bank Hours</span>
          </div>
          {/* Clear, button-like affordance so it's obvious you can add/manage
              here (the whole card is the toggle; this is a styled span, not a
              nested button). */}
          <span className="flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-600 dark:text-teal-400 bg-teal-500/10 px-1.5 py-0.5 rounded-md shrink-0">
            <Plus className="w-3 h-3" />
            {open ? 'Close' : 'Add'}
          </span>
        </div>
        <div className="text-lg sm:text-xl font-bold tabular-nums tracking-tight">
          {fmt(balance)} hrs
        </div>
        <div className="text-xs sm:text-[13px] text-gray-400 dark:text-gray-500 mt-0.5 leading-snug truncate">
          Extra hours worked
        </div>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 z-40 w-72 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-3 animate-slide-up">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="number"
              step="0.25"
              min="0"
              placeholder="Hours"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 min-w-0 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 placeholder-gray-400"
            />
            <button
              onClick={handleAdd}
              disabled={!hours || Number(hours) <= 0}
              className="shrink-0 px-3 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 active:scale-95 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-xl transition-all flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
          <input
            type="text"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="mt-2 w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />

          {entries.length > 0 && (
            <div className="mt-3 border-t border-gray-200/60 dark:border-gray-700/40 -mx-3 px-1">
              <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="px-2 py-2.5 flex items-center justify-between gap-3 group"
                  >
                    <div className="text-sm flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-teal-600 dark:text-teal-400 tabular-nums shrink-0">
                        +{fmt(entry.hours)} hrs
                      </span>
                      {entry.note && (
                        <span className="text-gray-700 dark:text-gray-200 truncate">
                          {entry.note}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {format(parseISO(entry.date), 'MMM d')}
                      </span>
                      <button
                        onClick={() => {
                          const deleted = { ...entry }
                          removeBankHours(entry.id)
                          showToast({
                            message: `Removed ${fmt(entry.hours)} bank hrs`,
                            action: { label: 'Undo', onClick: () => addBankHours(deleted) },
                            duration: 5000,
                          })
                        }}
                        className="p-0.5 rounded text-gray-400 hover:text-red-500 transition-colors"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasBalanceNoLog && (
            <div className="mt-3 border-t border-gray-200/60 dark:border-gray-700/40 pt-2 text-center">
              <p className="text-xs text-gray-400 dark:text-gray-500">
                No log entries — this balance was set directly or restored from a backup.
              </p>
              <button
                onClick={() => {
                  if (window.confirm(`Reset bank balance from ${fmt(balance)} hrs to 0?`)) {
                    updateProfile({ currentBankHours: 0 })
                    showToast({ message: 'Bank balance reset to 0' })
                  }
                }}
                className="mt-1.5 text-xs font-semibold text-red-500 hover:text-red-400 transition-colors"
              >
                Reset balance to 0
              </button>
            </div>
          )}

          {entries.length === 0 && !hasBalanceNoLog && (
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500 text-center">
              No bank hours logged yet.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
