import { useMemo, useState } from 'react'
import {
  format,
  parseISO,
  isBefore,
  startOfDay,
  differenceInDays,
  getDay,
  subDays,
} from 'date-fns'
import {
  Plus,
  CheckCircle,
  XCircle,
  CalendarSearch,
} from 'lucide-react'
import { useAppState } from '../context'
import { showToast } from '../lib/toastBus'
import {
  projectBalance,
  countWorkDays,
  earliestAffordableDate,
} from '../lib/projection'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export function VacationPlanner() {
  const { state, addVacation } = useAppState()
  const today = startOfDay(new Date())

  const [whatIfStart, setWhatIfStart] = useState('')
  const [whatIfEnd, setWhatIfEnd] = useState('')
  const [whatIfNote, setWhatIfNote] = useState('')
  const [whatIfSource, setWhatIfSource] = useState<'vacation' | 'sick' | 'bank' | 'any'>('any')
  const [whatIfHours, setWhatIfHours] = useState('') // empty = full day
  const [whatIfError, setWhatIfError] = useState('')

  const whatIfResult = useMemo(() => {
    if (!whatIfStart || !whatIfEnd) return null
    const start = parseISO(whatIfStart)
    const end = parseISO(whatIfEnd)

    if (isBefore(end, start)) return null

    const daySpan = differenceInDays(end, start)
    if (daySpan > 365) return { error: 'Vacation cannot exceed 1 year' }

    const workDays = countWorkDays(start, end, state.policy)
    const hrsPerDay = whatIfHours ? Number(whatIfHours) : state.policy.hoursPerWorkDay
    const hoursNeeded = workDays * hrsPerDay
    // Project to the day before the trip so the result reflects the balance
    // the user will have when the trip BEGINS, before any of its days have
    // been deducted.
    const projection = projectBalance(state, subDays(start, 1))
    const balanceOnStart = projection.totalAvailable
    const affordable = balanceOnStart >= hoursNeeded
    const isPartial = hrsPerDay < state.policy.hoursPerWorkDay

    let suggestion: Date | null = null
    if (!affordable) {
      suggestion = earliestAffordableDate(state, hoursNeeded, start)
    }

    // Contextual note for the result panel
    let funNote = ''
    if (workDays >= 5) funNote = '🌴 A full week — nice!'
    else if (workDays >= 3) funNote = '✨ Mini vacation!'
    else if (workDays === 1 && (getDay(start) === 5 || getDay(start) === 1))
      funNote = getDay(start) === 5 ? '🎉 Long weekend ahead!' : '😎 Extended weekend!'
    else if (isPartial) funNote = '⏰ Partial day — appointment time!'

    const balanceAfterTrip = balanceOnStart - hoursNeeded
    return {
      workDays,
      hoursNeeded,
      balanceOnStart,
      balanceAfterTrip,
      affordable,
      suggestion,
      funNote,
      isPartial,
      hrsPerDay,
    }
  }, [whatIfStart, whatIfEnd, whatIfHours, state])

  const handleCommit = () => {
    if (!whatIfStart || !whatIfEnd) return

    const start = parseISO(whatIfStart)
    const end = parseISO(whatIfEnd)
    const daySpan = differenceInDays(end, start)

    if (isBefore(end, start)) {
      setWhatIfError('End date must be after start date')
      return
    }
    if (daySpan > 365) {
      setWhatIfError('Vacation cannot exceed 1 year')
      return
    }

    setWhatIfError('')
    const hrsPerDay = whatIfHours ? Number(whatIfHours) : undefined
    addVacation({
      id: crypto.randomUUID(),
      startDate: whatIfStart,
      endDate: whatIfEnd,
      hoursPerDay: hrsPerDay && hrsPerDay < state.policy.hoursPerWorkDay ? hrsPerDay : undefined,
      hourSource: whatIfSource,
      note: whatIfNote || undefined,
      locked: false,
    })
    setWhatIfStart('')
    setWhatIfEnd('')
    setWhatIfNote('')
    setWhatIfHours('')
    showToast({ message: 'Time off added to plan' })
  }

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200/60 dark:border-gray-700/40">
        <h2 className="text-lg font-semibold">Time Off Planner</h2>
      </div>

      <div className="px-5 py-4 border-b border-gray-200/60 dark:border-gray-700/40 space-y-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 font-semibold">
            <CalendarSearch className="w-4 h-4" />
            Preview time off
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 leading-snug">
            Pick a date range to see if you have enough hours — nothing is added to your calendar until you click <span className="font-semibold">Add to calendar</span>.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1 font-medium">
              Start
            </label>
            <input
              type="date"
              value={whatIfStart}
              onChange={(e) => setWhatIfStart(e.target.value)}
              min={format(today, 'yyyy-MM-dd')}
              className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1 font-medium">
              End
            </label>
            <input
              type="date"
              value={whatIfEnd}
              onChange={(e) => setWhatIfEnd(e.target.value)}
              min={whatIfStart || format(today, 'yyyy-MM-dd')}
              className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Hour source + partial day */}
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1 font-medium">
              Use hours from
            </label>
            <select
              value={whatIfSource}
              onChange={(e) => setWhatIfSource(e.target.value as typeof whatIfSource)}
              className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="any">Auto (best available)</option>
              <option value="vacation">Vacation</option>
              <option value="sick">Sick</option>
              <option value="bank">Bank</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1 font-medium">
              Hrs/day
            </label>
            <input
              type="number"
              step="0.25"
              min="0.25"
              max={state.policy.hoursPerWorkDay}
              value={whatIfHours}
              onChange={(e) => setWhatIfHours(e.target.value)}
              placeholder={String(state.policy.hoursPerWorkDay)}
              title="Hours per day — leave blank for full day, or enter less for appointments"
              className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-400"
            />
          </div>
        </div>

        <input
          type="text"
          placeholder="Note (optional)"
          value={whatIfNote}
          onChange={(e) => setWhatIfNote(e.target.value)}
          className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />

        {whatIfError && <p className="text-red-400 text-sm">{whatIfError}</p>}

        {!whatIfResult && !whatIfError && (
          <div className="rounded-xl border border-dashed border-gray-300/60 dark:border-gray-700/60 px-4 py-3.5 text-center">
            <div className="text-xs text-gray-400 dark:text-gray-500">
              Preview appears here once you pick a start and end date.
            </div>
          </div>
        )}

        {whatIfResult && !('error' in whatIfResult) && (
          <div
            className={`relative overflow-hidden rounded-xl border-l-4 ${
              whatIfResult.affordable
                ? 'bg-emerald-50 dark:bg-emerald-900/15 text-emerald-700 dark:text-emerald-300 border-emerald-500'
                : 'bg-red-50 dark:bg-red-900/15 text-red-700 dark:text-red-300 border-red-500'
            }`}
          >
            <div className="px-4 py-3.5">
              {/* Big yes/no headline */}
              <div className="flex items-center gap-2.5">
                {whatIfResult.affordable ? (
                  <CheckCircle className="w-6 h-6 shrink-0" />
                ) : (
                  <XCircle className="w-6 h-6 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-base font-bold leading-tight">
                    {whatIfResult.affordable ? 'Yes — affordable' : 'Not yet affordable'}
                  </div>
                  {whatIfResult.funNote && (
                    <div className="text-xs font-normal opacity-80 mt-0.5">
                      {whatIfResult.funNote}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs opacity-90">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">
                    Needed
                  </div>
                  <div className="font-semibold tabular-nums">
                    {fmt(whatIfResult.hoursNeeded)} hrs
                  </div>
                  <div className="text-[10px] font-normal opacity-70">
                    {whatIfResult.workDays} day{whatIfResult.workDays === 1 ? '' : 's'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">
                    At start
                  </div>
                  <div className="font-semibold tabular-nums">
                    {fmt(whatIfResult.balanceOnStart)} hrs
                  </div>
                  <div className="text-[10px] font-normal opacity-70">
                    of trip
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">
                    After trip
                  </div>
                  <div className="font-semibold tabular-nums">
                    {fmt(whatIfResult.balanceAfterTrip)} hrs
                  </div>
                  <div className="text-[10px] font-normal opacity-70">
                    remaining
                  </div>
                </div>
              </div>

              {!whatIfResult.affordable && whatIfResult.suggestion && (
                <div className="mt-3 pt-2.5 border-t border-current/15 text-xs">
                  <span className="opacity-70">Earliest affordable: </span>
                  <span className="font-bold">
                    {format(whatIfResult.suggestion, 'EEE, MMM d, yyyy')}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {whatIfResult && 'error' in whatIfResult && (
          <p className="text-red-400 text-sm">{whatIfResult.error}</p>
        )}

        {whatIfResult && !('error' in whatIfResult) && (
          <button
            onClick={handleCommit}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white rounded-xl transition-all duration-150 shadow-md shadow-blue-600/20 hover:shadow-lg hover:shadow-blue-500/30"
            title="Add this time off to your plan"
          >
            <Plus className="w-4 h-4" />
            Add to calendar
          </button>
        )}
      </div>
    </div>
  )
}

