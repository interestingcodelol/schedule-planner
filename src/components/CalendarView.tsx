import { useMemo, useState, useRef, useEffect } from 'react'
import {
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  getDay,
  setMonth,
  setYear,
} from 'date-fns'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { useAppState } from '../context'
import { CalendarDay } from './CalendarDay'
import { DayPopover } from './DayPopover'
import type { PlannedVacation } from '../lib/types'
import { isHoliday } from '../lib/holidays'

export function CalendarView() {
  const { state, addVacation, removeVacation } = useAppState()
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()))

  const days = useMemo(() => {
    const monthStart = startOfMonth(currentMonth)
    const monthEnd = endOfMonth(currentMonth)
    const calStart = startOfWeek(monthStart)
    const calEnd = endOfWeek(monthEnd)
    const allDays = eachDayOfInterval({ start: calStart, end: calEnd })
    // Always show 6 rows (42 days) so the calendar height is consistent
    while (allDays.length < 42) {
      const nextDay = new Date(allDays[allDays.length - 1])
      nextDay.setDate(nextDay.getDate() + 1)
      allDays.push(nextDay)
    }
    return allDays
  }, [currentMonth])

  const monthStats = useMemo(() => {
    const monthStart = startOfMonth(currentMonth)
    const monthEnd = endOfMonth(currentMonth)
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd })

    let plannedDays = 0
    for (const d of daysInMonth) {
      const dateStr = format(d, 'yyyy-MM-dd')
      const dow = getDay(d)
      const isWorkDay = state.policy.workDaysPerWeek.includes(dow)
      const isHol = isHoliday(state.policy, d)
      const isPlanned = state.plannedVacations.some(
        (v) => dateStr >= v.startDate && dateStr <= v.endDate,
      )
      if (isPlanned && isWorkDay && !isHol) {
        plannedDays++
      }
    }

    return {
      plannedDays,
      plannedHours: plannedDays * state.policy.hoursPerWorkDay,
    }
  }, [currentMonth, state.plannedVacations, state.policy])

  const [showMonthPicker, setShowMonthPicker] = useState(false)
  const monthPickerRef = useRef<HTMLDivElement>(null)
  const [popoverDate, setPopoverDate] = useState<Date | null>(null)
  const [popoverExisting, setPopoverExisting] = useState<PlannedVacation | undefined>()

  const handleDayClick = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd')
    const existing = state.plannedVacations.find(
      (v) => dateStr >= v.startDate && dateStr <= v.endDate,
    )
    if (existing?.locked) return

    setPopoverDate(date)
    setPopoverExisting(existing)
  }

  const handlePopoverSave = (config: {
    hoursPerDay?: number
    timeOffStart?: string
    timeOffEnd?: string
    hourSource: 'vacation' | 'sick' | 'bank' | 'any'
    note?: string
  }) => {
    if (!popoverDate) return
    const dateStr = format(popoverDate, 'yyyy-MM-dd')

    // Remove existing if editing
    if (popoverExisting) {
      removeVacation(popoverExisting.id)
    }

    addVacation({
      id: crypto.randomUUID(),
      startDate: dateStr,
      endDate: dateStr,
      hoursPerDay: config.hoursPerDay,
      timeOffStart: config.timeOffStart,
      timeOffEnd: config.timeOffEnd,
      hourSource: config.hourSource,
      note: config.note,
      locked: false,
    })

    setPopoverDate(null)
  }

  const handlePopoverRemove = () => {
    if (popoverExisting) {
      removeVacation(popoverExisting.id)
    }
    setPopoverDate(null)
  }

  // Close month picker on click outside
  useEffect(() => {
    if (!showMonthPicker) return
    const handleClick = (e: MouseEvent) => {
      if (monthPickerRef.current && !monthPickerRef.current.contains(e.target as Node)) {
        setShowMonthPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMonthPicker])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setCurrentMonth((m) => subMonths(m, 1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setCurrentMonth((m) => addMonths(m, 1))
    }
  }

  return (
    <div
      className="glass-card rounded-2xl overflow-hidden flex flex-col h-full"
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200/60 dark:border-gray-700/40 shrink-0">
        <div className="relative" ref={monthPickerRef}>
          <button
            onClick={() => setShowMonthPicker(!showMonthPicker)}
            className="text-left hover:bg-gray-100 dark:hover:bg-gray-800/60 rounded-lg px-2 py-1 -mx-2 -my-1 transition-colors"
            title="Click to jump to a month"
          >
            <h2 className="text-base font-semibold">{format(currentMonth, 'MMMM yyyy')}</h2>
            {monthStats.plannedDays > 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {monthStats.plannedDays} planned work day{monthStats.plannedDays !== 1 ? 's' : ''} ({monthStats.plannedHours} hours)
              </p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                No planned time off this month
              </p>
            )}
          </button>

          {showMonthPicker && (
            <div className="absolute top-full left-0 mt-2 z-30 glass-card rounded-xl shadow-xl p-3 w-64 animate-slide-up">
              {/* Year selector */}
              <div className="flex items-center justify-between mb-2">
                <button
                  onClick={() => setCurrentMonth((m) => setYear(m, m.getFullYear() - 1))}
                  className="p-1 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-all"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm font-bold">{currentMonth.getFullYear()}</span>
                <button
                  onClick={() => setCurrentMonth((m) => setYear(m, m.getFullYear() + 1))}
                  className="p-1 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-all"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              {/* Month grid */}
              <div className="grid grid-cols-3 gap-1">
                {Array.from({ length: 12 }, (_, i) => {
                  const isActive = currentMonth.getMonth() === i
                  const isCurrent = new Date().getMonth() === i && currentMonth.getFullYear() === new Date().getFullYear()
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        setCurrentMonth(startOfMonth(setMonth(currentMonth, i)))
                        setShowMonthPicker(false)
                      }}
                      className={`py-1.5 text-xs font-medium rounded-lg transition-all ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : isCurrent
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'
                      }`}
                    >
                      {format(new Date(2024, i, 1), 'MMM')}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setCurrentMonth((m) => subMonths(m, 1))}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label="Previous month"
            title="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setCurrentMonth(startOfMonth(new Date()))}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label="Go to current month"
            title="Go to current month"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setCurrentMonth((m) => addMonths(m, 1))}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label="Next month"
            title="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className="grid grid-cols-7 flex-1 min-h-0 border-l border-t border-gray-300/60 dark:border-gray-600/40"
        style={{ gridTemplateRows: `auto repeat(6, 1fr)` }}
      >
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
          <div
            key={day}
            className={`text-center text-[11px] font-bold uppercase tracking-wider py-1.5 border-r border-b border-gray-300/60 dark:border-gray-600/40 ${
              i === 0 || i === 6
                ? 'text-gray-400 dark:text-gray-500 bg-gray-100/30 dark:bg-white/[0.02]'
                : 'text-gray-600 dark:text-gray-300 bg-gray-50/50 dark:bg-gray-900/30'
            }`}
          >
            {day}
          </div>
        ))}
        {days.map((day) => (
          <CalendarDay
            key={day.toISOString()}
            date={day}
            currentMonth={currentMonth}
            onDayClick={handleDayClick}
          />
        ))}
      </div>

      {/* Day modal */}
      {popoverDate && (
        <DayPopover
          date={popoverDate}
          existing={popoverExisting}
          hoursPerWorkDay={state.policy.hoursPerWorkDay}
          onSave={handlePopoverSave}
          onRemove={handlePopoverRemove}
          onClose={() => setPopoverDate(null)}
        />
      )}

      <div className="px-3 py-2 border-t border-gray-200/60 dark:border-gray-700/40 flex items-center gap-5 text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          Planned
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          Holiday
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Payday
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Can't afford
        </span>
      </div>
    </div>
  )
}
