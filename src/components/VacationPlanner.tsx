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
  Trash2,
  Lock,
  Unlock,
  CheckCircle,
  XCircle,
  CalendarSearch,
  Palmtree,
} from 'lucide-react'
import { useAppState } from '../context'
import {
  projectBalance,
  countWorkDays,
  earliestAffordableDate,
} from '../lib/projection'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

const SOURCE_LABELS: Record<string, string> = {
  any: '',
  vacation: 'Vacation',
  sick: 'Sick',
  bank: 'Bank',
}

const EMOJI_OPTIONS = [
  '🌴', '✨', '🎉', '😎', '⏰', '🏖️', '🎄', '🏥', '✈️', '🎓',
  '💼', '🏠', '🎮', '🧘', '🏕️', '🎵', '🚗', '👶', '🐾', '💤',
]

export function VacationPlanner() {
  const { state, addVacation } = useAppState()
  const today = startOfDay(new Date())

  const [whatIfStart, setWhatIfStart] = useState('')
  const [whatIfEnd, setWhatIfEnd] = useState('')
  const [whatIfNote, setWhatIfNote] = useState('')
  const [whatIfSource, setWhatIfSource] = useState<'vacation' | 'sick' | 'bank' | 'any'>('any')
  const [whatIfHours, setWhatIfHours] = useState('') // empty = full day
  const [whatIfError, setWhatIfError] = useState('')

  const sortedVacations = useMemo(
    () =>
      [...state.plannedVacations].sort((a, b) =>
        a.startDate.localeCompare(b.startDate),
      ),
    [state.plannedVacations],
  )

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
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium">
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
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium">
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
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium">
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
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium">
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
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-xl transition-colors duration-150"
          title="Add this time off to your plan"
        >
          <Plus className="w-4 h-4" />
          Commit to plan
        </button>
      </div>

      {/* Planned list — capped height with scroll */}
      <div className="divide-y divide-gray-100 dark:divide-gray-800/60 max-h-[280px] overflow-y-auto scroll-panel">
        {sortedVacations.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <Palmtree className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-400 dark:text-gray-500">
              No planned time off yet
            </p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              Use the planner above or click days on the calendar
            </p>
          </div>
        ) : (
          sortedVacations.map((vacation) => (
            <VacationItem key={vacation.id} vacation={vacation} />
          ))
        )}
      </div>
    </div>
  )
}

function VacationItem({
  vacation,
}: {
  vacation: {
    id: string
    startDate: string
    endDate: string
    hoursPerDay?: number
    hourSource: 'vacation' | 'sick' | 'bank' | 'any'
    note?: string
    locked: boolean
    customEmoji?: string
  }
}) {
  const { state, removeVacation, updateVacation } = useAppState()
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const today = startOfDay(new Date())
  const start = parseISO(vacation.startDate)
  const end = parseISO(vacation.endDate)
  const isPast = isBefore(end, today)

  const workDays = countWorkDays(start, end, state.policy)
  const hrsPerDay = vacation.hoursPerDay ?? state.policy.hoursPerWorkDay
  const hoursNeeded = workDays * hrsPerDay
  const isPartial = hrsPerDay < state.policy.hoursPerWorkDay
  const projection = projectBalance(state, start)
  const affordable = projection.totalAvailable >= hoursNeeded

  const sourceLabel = SOURCE_LABELS[vacation.hourSource] || ''

  // Default emoji based on context
  let defaultEmoji = ''
  if (workDays >= 5) defaultEmoji = '🌴'
  else if (workDays >= 3) defaultEmoji = '✨'
  else if (workDays === 1 && (getDay(start) === 5 || getDay(start) === 1)) defaultEmoji = '🎉'
  else if (isPartial) defaultEmoji = '⏰'

  const displayEmoji = vacation.customEmoji || defaultEmoji

  // Build concise metadata: "3 days · 24 hrs" or "1 day · 3 hrs (3h/day)"
  const metaParts: string[] = []
  metaParts.push(`${workDays} day${workDays !== 1 ? 's' : ''}`)
  if (isPartial) {
    metaParts.push(`${fmt(hoursNeeded)} hrs (${fmt(hrsPerDay)}h/day)`)
  } else {
    metaParts.push(`${fmt(hoursNeeded)} hrs`)
  }
  if (sourceLabel) {
    metaParts.push(sourceLabel)
  }

  return (
    <div className={`px-6 py-4 ${isPast ? 'opacity-40' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold flex items-center gap-1">
            {displayEmoji && (
              <span className="relative">
                <button
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  className="hover:scale-125 transition-transform cursor-pointer"
                  title="Click to change emoji"
                >
                  {displayEmoji}
                </button>
                {showEmojiPicker && (
                  <div className="absolute top-7 left-0 z-20 glass-card rounded-xl shadow-xl p-2 grid grid-cols-5 gap-1 w-48">
                    {EMOJI_OPTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => {
                          updateVacation(vacation.id, { customEmoji: emoji })
                          setShowEmojiPicker(false)
                        }}
                        className="text-lg hover:bg-gray-100 dark:hover:bg-gray-700/60 rounded-lg p-1 transition-colors"
                      >
                        {emoji}
                      </button>
                    ))}
                    {vacation.customEmoji && (
                      <button
                        onClick={() => {
                          updateVacation(vacation.id, { customEmoji: undefined })
                          setShowEmojiPicker(false)
                        }}
                        className="col-span-5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-1 py-1"
                      >
                        Reset to default
                      </button>
                    )}
                  </div>
                )}
              </span>
            )}
            <span>
              {format(start, 'MMM d')}
              {vacation.startDate !== vacation.endDate && ` — ${format(end, 'MMM d')}`}
              {start.getFullYear() !== new Date().getFullYear() &&
                `, ${start.getFullYear()}`}
            </span>
          </div>
          {vacation.note && (
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {vacation.note}
            </div>
          )}
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            {metaParts.join(' · ')}
          </div>
        </div>
        <div className="flex items-center gap-1.5 ml-3 shrink-0">
          {!isPast && (
            <span
              className="mr-1 cursor-help"
              title={
                affordable
                  ? `Affordable — you'll have ${fmt(projection.totalAvailable)} hrs available (need ${fmt(hoursNeeded)} hrs for ${workDays} day${workDays !== 1 ? 's' : ''})`
                  : `Not enough hours — you'll only have ${fmt(projection.totalAvailable)} hrs available but need ${fmt(hoursNeeded)} hrs (${fmt(hoursNeeded - projection.totalAvailable)} hrs short)`
              }
            >
              {affordable ? (
                <CheckCircle className="w-5 h-5 text-emerald-500" />
              ) : (
                <XCircle className="w-5 h-5 text-red-500" />
              )}
            </span>
          )}
          <button
            onClick={() =>
              updateVacation(vacation.id, { locked: !vacation.locked })
            }
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label={vacation.locked ? 'Unlock this time off' : 'Lock this time off'}
            title={vacation.locked ? 'Unlock — allow editing' : 'Lock — prevent changes'}
          >
            {vacation.locked ? (
              <Lock className="w-4 h-4" />
            ) : (
              <Unlock className="w-4 h-4" />
            )}
          </button>
          {!vacation.locked && (
            <button
              onClick={() => removeVacation(vacation.id)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-150"
              aria-label="Delete this time off"
              title="Delete this time off"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
