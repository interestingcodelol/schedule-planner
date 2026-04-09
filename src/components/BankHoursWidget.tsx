import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { Wallet, Plus, X, History } from 'lucide-react'
import { useAppState } from '../context'
import { showToast } from './Toast'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export function BankHoursWidget() {
  const { state, addBankHours, removeBankHours } = useAppState()
  const [hours, setHours] = useState('')
  const [note, setNote] = useState('')
  const [showHistory, setShowHistory] = useState(false)

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
    showToast({ message: `Added ${fmt(h)} bank hrs` })
  }

  const allEntries = [...(state.bankHoursLog || [])]
    .sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-teal-100 dark:bg-teal-900/30">
            <Wallet className="w-4 h-4 text-teal-600 dark:text-teal-400" />
          </div>
          <span className="text-base font-semibold">Bank Hours</span>
          <span className="text-base text-teal-600 dark:text-teal-400 font-bold tabular-nums">
            {fmt(state.profile.currentBankHours)} hrs
          </span>
        </div>
        {allEntries.length > 0 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`p-1.5 rounded-lg transition-all ${
              showHistory
                ? 'text-teal-500 bg-teal-500/10'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60'
            }`}
            title={showHistory ? 'Hide history' : 'Show history'}
          >
            <History className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Quick add */}
      <div className="px-5 py-3 border-t border-gray-200/60 dark:border-gray-700/40">
        <div className="flex gap-2">
          <input
            type="number"
            step="0.25"
            min="0"
            placeholder="Hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="flex-1 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent placeholder-gray-400"
          />
          <input
            type="text"
            placeholder="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="flex-1 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
          />
          <button
            onClick={handleAdd}
            disabled={!hours || Number(hours) <= 0}
            className="px-3 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 active:scale-95 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-xl transition-all flex items-center gap-1"
            title="Add bank hours"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>

      {/* History panel — toggled */}
      {showHistory && allEntries.length > 0 && (
        <div className="border-t border-gray-200/60 dark:border-gray-700/40 divide-y divide-gray-100 dark:divide-gray-800/60 max-h-[200px] overflow-y-auto scroll-panel">
          {allEntries.map((entry) => (
            <div key={entry.id} className="px-5 py-2 flex items-center justify-between group hover:bg-gray-50/50 dark:hover:bg-gray-800/20 transition-colors">
              <div className="text-sm flex items-center gap-2">
                <span className="font-medium text-teal-600 dark:text-teal-400 tabular-nums">
                  +{fmt(entry.hours)} hrs
                </span>
                {entry.note && (
                  <span className="text-gray-500 dark:text-gray-400 truncate max-w-[120px]">
                    {entry.note}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">{format(parseISO(entry.date), 'MMM d')}</span>
                <button
                  onClick={() => {
                    const deleted = { ...entry }
                    removeBankHours(entry.id)
                    showToast({
                      message: `Removed ${fmt(entry.hours)} bank hrs`,
                      action: {
                        label: 'Undo',
                        onClick: () => addBankHours(deleted),
                      },
                      duration: 5000,
                    })
                  }}
                  className="p-0.5 rounded text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                  title="Remove"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
