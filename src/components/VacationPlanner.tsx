import { useMemo, useState } from 'react'
import {
  format,
  parseISO,
  isBefore,
  startOfDay,
  differenceInDays,
  getDay,
} from 'date-fns'
import {
  Plus,
  CheckCircle,
  XCircle,
  CalendarSearch,
} from 'lucide-react'
import { useAppState } from '../context'
import { showToast } from './Toast'
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
    const projection = projectBalance(state, start)
    const balanceOnStart = projection.totalAvailable
    const affordable = balanceOnStart >= hoursNeeded
    const isPartial = hrsPerDay < state.policy.hoursPerWorkDay

    let suggestion: Date | null = null
    if (!affordable) {
      suggestion = earliestAffordableDate(state, hoursNeeded, start)
    }

    // Fun message for multi-day ranges
    let funNote = ''
    if (workDays >= 5) funNote = '🌴 A full week — nice!'
    else if (workDays >= 3) funNote = '✨ Mini vacation!'
    else if (workDays === 1 && (getDay(start) === 5 || getDay(start) === 1))
      funNote = getDay(start) === 5 ? '🎉 Long weekend ahead!' : '😎 Extended weekend!'
    else if (isPartial) funNote = '⏰ Partial day — appointment time!'

    return { workDays, hoursNeeded, balanceOnStart, affordable, suggestion, funNote, isPartial, hrsPerDay }
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
      <div className="px-6 py-5 border-b border-gray-200/60 dark:border-gray-700/40">
        <h2 className="text-lg font-semibold">Time Off Planner</h2>
      </div>

      {/* What-if planner */}
      <div className="px-6 py-5 border-b border-gray-200/60 dark:border-gray-700/40 space-y-3">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 font-medium">
          <CalendarSearch className="w-4 h-4" />
          What-if planner
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

        {whatIfResult && !('error' in whatIfResult) && (
          <div
            className={`p-4 rounded-xl text-sm ${
              whatIfResult.affordable
                ? 'bg-emerald-50 dark:bg-emerald-900/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/30'
                : 'bg-red-50 dark:bg-red-900/15 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800/30'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {whatIfResult.affordable ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              {whatIfResult.affordable ? 'Affordable' : 'Not yet affordable'}
              {whatIfResult.funNote && (
                <span className="font-normal text-xs ml-1">{whatIfResult.funNote}</span>
              )}
            </div>
            <div className="mt-2 text-sm space-y-0.5 opacity-80">
              <div>
                {whatIfResult.workDays} work days &middot; {fmt(whatIfResult.hoursNeeded)} hrs
                needed
              </div>
              <div>Total available on start: {fmt(whatIfResult.balanceOnStart)} hrs</div>
              {!whatIfResult.affordable && whatIfResult.suggestion && (
                <div className="font-medium">
                  Earliest affordable: {format(whatIfResult.suggestion, 'MMM d, yyyy')}
                </div>
              )}
            </div>
          </div>
        )}

        {whatIfResult && 'error' in whatIfResult && (
          <p className="text-red-400 text-sm">{whatIfResult.error}</p>
        )}

        <button
          onClick={handleCommit}
          disabled={!whatIfStart || !whatIfEnd}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-500 active:scale-[0.98] disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-xl transition-all duration-150 shadow-md shadow-blue-600/20 hover:shadow-lg hover:shadow-blue-500/30"
          title="Add this time off to your plan"
        >
          <Plus className="w-4 h-4" />
          Commit to plan
        </button>
      </div>

    </div>
  )
}

