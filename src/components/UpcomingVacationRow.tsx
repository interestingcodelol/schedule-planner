import { useEffect, useRef, useState } from 'react'
import { differenceInDays, format, getDay, isBefore, parseISO, startOfDay } from 'date-fns'
import {
  CalendarDays,
  CheckCircle,
  Lock,
  Pencil,
  Trash2,
  Unlock,
  X,
  XCircle,
} from 'lucide-react'
import { useAppState } from '../context'
import { analyzeTripImpact, countWorkDays } from '../lib/projection'
import type { AppState, PlannedVacation } from '../lib/types'
import { showToast } from '../lib/toastBus'

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

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

type Props = {
  vacation: PlannedVacation
  /** Called when the user clicks the row body (not an action button). */
  onJump?: (date: Date) => void
}

export function UpcomingVacationRow({ vacation, onJump }: Props) {
  const { state, addVacation, removeVacation, updateVacation } = useAppState()
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editStart, setEditStart] = useState(vacation.startDate)
  const [editEnd, setEditEnd] = useState(vacation.endDate)
  const [editError, setEditError] = useState('')
  const emojiRef = useRef<HTMLSpanElement>(null)
  const today = startOfDay(new Date())
  const start = parseISO(vacation.startDate)
  const end = parseISO(vacation.endDate)
  const isPast = isBefore(end, today)
  const daysUntil = differenceInDays(start, today)

  const enterEdit = () => {
    setEditStart(vacation.startDate)
    setEditEnd(vacation.endDate)
    setEditError('')
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditError('')
  }

  const saveEdit = () => {
    if (!editStart || !editEnd) {
      setEditError('Both dates are required')
      return
    }
    if (editEnd < editStart) {
      setEditError('End date must be on or after start date')
      return
    }
    // Check for collisions with OTHER existing entries (not this one).
    const conflicts = state.plannedVacations.filter(
      (v) =>
        v.id !== vacation.id &&
        v.startDate <= editEnd &&
        v.endDate >= editStart,
    )
    if (conflicts.length > 0) {
      setEditError(
        `Overlaps with ${conflicts.length} existing entr${
          conflicts.length === 1 ? 'y' : 'ies'
        } — remove or merge those first`,
      )
      return
    }
    updateVacation(vacation.id, {
      startDate: editStart,
      endDate: editEnd,
    })
    showToast({ message: 'Dates updated' })
    setIsEditing(false)
  }

  useEffect(() => {
    if (!showEmojiPicker) return
    const handleClick = (e: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowEmojiPicker(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [showEmojiPicker])

  const workDays = countWorkDays(start, end, state.policy)
  const hrsPerDay = vacation.hoursPerDay ?? state.policy.hoursPerWorkDay
  const hoursNeeded = workDays * hrsPerDay
  const isPartial = hrsPerDay < state.policy.hoursPerWorkDay
  // Run the trip through analyzeTripImpact so cross-year trips get credit
  // for the Jan 1 sick grant, mid-trip paydays, etc. The vacation is
  // already in `state.plannedVacations`, so we evaluate it against state
  // sans-itself to avoid double-counting.
  const stateWithoutThis: AppState = {
    ...state,
    plannedVacations: state.plannedVacations.filter((v) => v.id !== vacation.id),
  }
  const impact = analyzeTripImpact(stateWithoutThis, vacation, end)
  const affordable = impact.tripItselfShortfall === 0
  const balanceOnStart = impact.balanceBeforeTrip
  const balanceAfterTrip = impact.balanceAfterTrip
  const replenishedDuringTrip = Math.max(
    0,
    balanceAfterTrip + hoursNeeded - balanceOnStart,
  )

  const sourceLabel = SOURCE_LABELS[vacation.hourSource] || ''

  let defaultEmoji = ''
  if (workDays >= 5) defaultEmoji = '🌴'
  else if (workDays >= 3) defaultEmoji = '✨'
  else if (workDays === 1 && (getDay(start) === 5 || getDay(start) === 1)) defaultEmoji = '🎉'
  else if (isPartial) defaultEmoji = '⏰'
  const displayEmoji = vacation.customEmoji || defaultEmoji

  const metaParts: string[] = []
  metaParts.push(`${workDays} day${workDays !== 1 ? 's' : ''}`)
  if (isPartial) {
    metaParts.push(`${fmt(hoursNeeded)} hrs (${fmt(hrsPerDay)}h/day)`)
  } else {
    metaParts.push(`${fmt(hoursNeeded)} hrs`)
  }
  if (sourceLabel) metaParts.push(sourceLabel)
  if (!isPast && daysUntil > 0) {
    metaParts.push(`${daysUntil}d away`)
  } else if (daysUntil === 0) {
    metaParts.push('today')
  }

  const handleRowClick = () => onJump?.(start)

  return (
    <div
      role={onJump ? 'button' : undefined}
      tabIndex={onJump ? 0 : undefined}
      onClick={onJump ? handleRowClick : undefined}
      onKeyDown={
        onJump
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleRowClick()
              }
            }
          : undefined
      }
      className={`px-5 py-3 group transition-colors ${
        isPast ? 'opacity-40' : ''
      } ${onJump ? 'cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-800/20' : ''}`}
      title={onJump ? `Jump to ${format(start, 'MMM d')} on the calendar` : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-1">
              {displayEmoji && (
                <span className="relative" ref={emojiRef}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowEmojiPicker(!showEmojiPicker)
                    }}
                    className="hover:scale-125 active:scale-95 transition-transform cursor-pointer"
                    title="Click to change emoji"
                  >
                    {displayEmoji}
                  </button>
                  {showEmojiPicker && (
                    <div
                      className="absolute top-7 left-0 z-20 glass-card rounded-xl shadow-xl p-2 grid grid-cols-5 gap-1 w-48 animate-in fade-in zoom-in-95 duration-150"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {EMOJI_OPTIONS.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={(e) => {
                            e.stopPropagation()
                            updateVacation(vacation.id, { customEmoji: emoji })
                            setShowEmojiPicker(false)
                          }}
                          className="text-lg hover:bg-gray-100 dark:hover:bg-gray-700/60 hover:scale-110 active:scale-90 rounded-lg p-1 transition-all"
                        >
                          {emoji}
                        </button>
                      ))}
                      {vacation.customEmoji && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
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
                {start.getFullYear() !== new Date().getFullYear() && `, ${start.getFullYear()}`}
              </span>
            </div>
            {vacation.note && (
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                {vacation.note}
              </div>
            )}
            <div className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
              {metaParts.join(' · ')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
          {!isPast && (
            <span
              className="cursor-help"
              title={
                affordable
                  ? `Affordable\n${fmt(balanceOnStart)} hrs at start of ${format(start, 'MMM d')}\n${fmt(balanceAfterTrip)} hrs left after ${format(end, 'MMM d')}\n${fmt(hoursNeeded)} hrs needed${
                      replenishedDuringTrip > 0 && balanceOnStart < hoursNeeded
                        ? `\n+${fmt(replenishedDuringTrip)} hrs added during trip (e.g. Jan 1 sick grant)`
                        : ''
                    }`
                  : `Not enough\n${fmt(balanceOnStart)} hrs at start of ${format(start, 'MMM d')}\n${fmt(hoursNeeded)} hrs needed (${fmt(impact.tripItselfShortfall)} short)`
              }
            >
              {affordable ? (
                <CheckCircle className="w-4 h-4 text-emerald-500" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
            </span>
          )}
          {!vacation.locked && !isPast && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                enterEdit()
              }}
              className="p-1 rounded-lg text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 active:scale-90 transition-all"
              title="Edit dates"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              updateVacation(vacation.id, { locked: !vacation.locked })
            }}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 active:scale-90 transition-all"
            title={vacation.locked ? 'Unlock' : 'Lock'}
          >
            {vacation.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          </button>
          {!vacation.locked && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                const deleted = { ...vacation }
                removeVacation(vacation.id)
                showToast({
                  message: 'Time off removed',
                  action: {
                    label: 'Undo',
                    onClick: () => addVacation(deleted),
                  },
                  duration: 5000,
                })
              }}
              className="p-1 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 active:scale-90 transition-all"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {isEditing && (
        <div
          className="mt-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-gray-200/60 dark:border-gray-700/40 p-2.5 space-y-2 animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                Start
              </label>
              <input
                type="date"
                value={editStart}
                onChange={(e) => setEditStart(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                End
              </label>
              <input
                type="date"
                value={editEnd}
                onChange={(e) => setEditEnd(e.target.value)}
                min={editStart || undefined}
                className="w-full px-2 py-1.5 text-sm bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          {editError && (
            <p className="text-xs text-red-500 dark:text-red-400">{editError}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={cancelEdit}
              className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-lg transition-colors flex items-center gap-1"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
            <button
              onClick={saveEdit}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white rounded-lg transition-colors"
            >
              <Pencil className="w-3 h-3" />
              Save dates
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
