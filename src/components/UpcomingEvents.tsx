import { useMemo, useState, useEffect, useRef } from 'react'
import {
  format,
  parseISO,
  addDays,
  isBefore,
  isSameDay,
  startOfDay,
  differenceInDays,
  getDay,
} from 'date-fns'
import {
  CalendarDays,
  Gift,
  TrendingUp,
  Lock,
  Unlock,
  Trash2,
  CheckCircle,
  XCircle,
  Palmtree,
} from 'lucide-react'
import { useAppState } from '../context'
import { projectBalance, countWorkDays, getNextPayday } from '../lib/projection'
import { showToast } from './Toast'

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

export function UpcomingEvents() {
  const { state } = useAppState()
  const today = startOfDay(new Date())

  // Sorted planned vacations (future + current)
  const sortedVacations = useMemo(
    () =>
      [...state.plannedVacations]
        .filter((v) => !isBefore(parseISO(v.endDate), today))
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [state.plannedVacations, today],
  )

  // Info events (holidays, paydays) — non-interactive
  const infoEvents = useMemo(() => {
    const items: Array<{
      key: string
      icon: React.ElementType
      label: string
      detail: string
      accent: string
      sortDate: Date
    }> = []

    // Next payday
    const nextPayday = getNextPayday(
      parseISO(state.profile.lastPaydayDate),
      state.policy.payPeriodLengthDays,
    )
    const daysToPayday = differenceInDays(nextPayday, today)
    if (daysToPayday >= 0 && daysToPayday <= 30) {
      items.push({
        key: `payday-${format(nextPayday, 'yyyy-MM-dd')}`,
        icon: TrendingUp,
        label: `Payday${daysToPayday === 0 ? ' today' : ''}`,
        detail: `${format(nextPayday, 'EEE, MMM d')}${daysToPayday > 0 ? ` — ${daysToPayday}d away` : ''}`,
        accent: 'text-emerald-500',
        sortDate: nextPayday,
      })
    }

    // Upcoming holidays (next 90 days)
    const lookAhead = addDays(today, 90)
    for (const rule of state.policy.holidays) {
      for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
        let holidayDate: Date
        try {
          if (rule.type === 'fixed') {
            holidayDate = new Date(year, rule.month - 1, rule.day)
          } else if (rule.type === 'nth_weekday') {
            const firstOfMonth = new Date(year, rule.month - 1, 1)
            const firstDow = firstOfMonth.getDay()
            let dayOffset = rule.weekday - firstDow
            if (dayOffset < 0) dayOffset += 7
            holidayDate = addDays(firstOfMonth, dayOffset + (rule.n - 1) * 7)
          } else {
            continue
          }
        } catch {
          continue
        }

        if (!isBefore(holidayDate, today) && isBefore(holidayDate, lookAhead) && !isSameDay(holidayDate, today)) {
          const daysUntil = differenceInDays(holidayDate, today)
          items.push({
            key: `holiday-${rule.name}-${year}`,
            icon: Gift,
            label: rule.name,
            detail: `${format(holidayDate, 'EEE, MMM d')} — ${daysUntil}d away`,
            accent: 'text-amber-500',
            sortDate: holidayDate,
          })
        }
      }
    }

    return items.sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime())
  }, [state, today])

  const hasContent = sortedVacations.length > 0 || infoEvents.length > 0

  return (
    <div className="glass-card rounded-2xl overflow-hidden h-full flex flex-col">
      <div className="px-5 py-3.5 border-b border-gray-200/60 dark:border-gray-700/40">
        <h3 className="text-base font-semibold">Upcoming</h3>
      </div>

      {!hasContent ? (
        <div className="px-5 py-8 text-center">
          <Palmtree className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
          <p className="text-sm text-gray-400 dark:text-gray-500">
            No upcoming events
          </p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800/60 flex-1 min-h-0 overflow-y-auto scroll-panel">
          {/* Planned vacations — with full controls */}
          {sortedVacations.map((vacation) => (
            <VacationRow key={vacation.id} vacation={vacation} />
          ))}

          {/* Info events — holidays, paydays */}
          {infoEvents.map((event) => (
            <div key={event.key} className="px-5 py-3.5 flex items-start gap-3">
              <event.icon className={`w-4.5 h-4.5 mt-0.5 shrink-0 ${event.accent}`} />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{event.label}</div>
                <div className="text-sm text-gray-400 dark:text-gray-500">{event.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function VacationRow({ vacation }: { vacation: {
  id: string
  startDate: string
  endDate: string
  hoursPerDay?: number
  hourSource: 'vacation' | 'sick' | 'bank' | 'any'
  note?: string
  locked: boolean
  customEmoji?: string
}}) {
  const { state, addVacation, removeVacation, updateVacation } = useAppState()
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const emojiRef = useRef<HTMLSpanElement>(null)
  const today = startOfDay(new Date())
  const start = parseISO(vacation.startDate)
  const end = parseISO(vacation.endDate)
  const isPast = isBefore(end, today)
  const daysUntil = differenceInDays(start, today)

  // Close emoji picker on click outside
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
  const projection = projectBalance(state, start)
  const affordable = projection.totalAvailable >= hoursNeeded

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

  return (
    <div className={`px-5 py-3 group hover:bg-gray-50/50 dark:hover:bg-gray-800/20 transition-colors ${isPast ? 'opacity-40' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-1">
              {displayEmoji && (
                <span className="relative" ref={emojiRef}>
                  <button
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    className="hover:scale-125 active:scale-95 transition-transform cursor-pointer"
                    title="Click to change emoji"
                  >
                    {displayEmoji}
                  </button>
                  {showEmojiPicker && (
                    <div className="absolute top-7 left-0 z-20 glass-card rounded-xl shadow-xl p-2 grid grid-cols-5 gap-1 w-48 animate-in fade-in zoom-in-95 duration-150">
                      {EMOJI_OPTIONS.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => {
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
                  ? `Affordable — you'll have ${fmt(projection.totalAvailable)} hrs by ${format(start, 'MMM d')} (need ${fmt(hoursNeeded)})`
                  : `Not enough — you'll have ${fmt(projection.totalAvailable)} hrs by ${format(start, 'MMM d')} but need ${fmt(hoursNeeded)} (${fmt(hoursNeeded - projection.totalAvailable)} short)`
              }
            >
              {affordable ? (
                <CheckCircle className="w-4 h-4 text-emerald-500" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
            </span>
          )}
          <button
            onClick={() => updateVacation(vacation.id, { locked: !vacation.locked })}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 active:scale-90 transition-all"
            title={vacation.locked ? 'Unlock' : 'Lock'}
          >
            {vacation.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          </button>
          {!vacation.locked && (
            <button
              onClick={() => {
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
    </div>
  )
}
