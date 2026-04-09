import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { Wallet, Plus } from 'lucide-react'
import { useAppState } from '../context'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export function BankHoursWidget() {
  const { state, addBankHours } = useAppState()
  const [hours, setHours] = useState('')
  const [note, setNote] = useState('')

  const handleAdd = () => {
    const h = Number(hours)
    if (!h || h <= 0) return

    addBankHours({
      id: crypto.randomUUID(),
      date: format(new Date(), 'yyyy-MM-dd'),
      hours: h,
      note: note || undefined,
    })
    setHours('')
    setNote('')
  }

  const recentEntries = [...(state.bankHoursLog || [])]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-5 py-3.5">
        <div className="p-1.5 rounded-lg bg-teal-100 dark:bg-teal-900/30">
          <Wallet className="w-4 h-4 text-teal-600 dark:text-teal-400" />
        </div>
        <span className="text-base font-semibold">Bank Hours</span>
        <span className="text-base text-teal-600 dark:text-teal-400 font-bold tabular-nums">
          {fmt(state.profile.currentBankHours)} hrs
        </span>
      </div>

      {/* Quick add */}
      <div className="px-5 py-3 border-t border-gray-200/60 dark:border-gray-700/40 space-y-2">
        <div className="flex gap-2">
          <input
            type="number"
            step="0.25"
            min="0"
            placeholder="Hours (e.g. 0.25)"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="flex-1 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent placeholder-gray-400"
          />
          <button
            onClick={handleAdd}
            disabled={!hours || Number(hours) <= 0}
            className="px-3 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-xl transition-colors duration-150 flex items-center gap-1"
            title="Add bank hours"
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
          className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
        />
      </div>

      {/* Recent log */}
      {recentEntries.length > 0 && (
        <div className="border-t border-gray-200/60 dark:border-gray-700/40 divide-y divide-gray-100 dark:divide-gray-800/60">
          {recentEntries.map((entry) => (
            <div key={entry.id} className="px-5 py-2 flex items-center justify-between">
              <div className="text-sm">
                <span className="font-medium text-teal-600 dark:text-teal-400">
                  +{fmt(entry.hours)} hrs
                </span>
                {entry.note && (
                  <span className="text-gray-500 dark:text-gray-400 ml-1.5 text-xs">
                    {entry.note}
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-400">{format(parseISO(entry.date), 'MMM d')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
