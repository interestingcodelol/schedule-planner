import { useMemo } from 'react'
import {
  format,
  isSameDay,
  isSameMonth,
  isBefore,
  startOfDay,
  getDay,
  parseISO,
  addDays,
  getWeek,
} from 'date-fns'
import { Lock, Unlock } from 'lucide-react'
import { useAppState } from '../context'
import { getCarryoverPayoutDate, projectBalance } from '../lib/projection'
import { getHolidayName } from '../lib/holidays'
import { formatTimeCompact, isWorkDayOverInZone } from '../lib/timeUtils'

type Props = {
  date: Date
  currentMonth: Date
  onDayClick: (date: Date) => void
}

// Holiday emoji map
const HOLIDAY_EMOJI: Record<string, string> = {
  "New Year's Day": '🎆',
  'Martin Luther King Jr. Day': '✊',
  "Presidents' Day": '🏛️',
  'Memorial Day': '⭐',
  'Juneteenth': '✊',
  'Independence Day': '🎇',
  'Labor Day': '⚒️',
  'Veterans Day': '🎖️',
  'Thanksgiving Day': '🦃',
  'Day after Thanksgiving': '🛍️',
  'Christmas Eve': '🎄',
  'Christmas Day': '🎁',
}

function getHolidayEmoji(name: string): string {
  return HOLIDAY_EMOJI[name] || '🏖️'
}

export function CalendarDay({ date, currentMonth, onDayClick }: Props) {
  const { state, updateVacation } = useAppState()
  const today = startOfDay(new Date())
  const isToday = isSameDay(date, today)
  const isCurrentMonth = isSameMonth(date, currentMonth)
  const isTodayWorkDayOver =
    isToday &&
    isWorkDayOverInZone(state.profile.timezone || 'America/New_York', state.policy.hoursPerWorkDay)
  const isPast = isBefore(date, today) || isTodayWorkDayOver
  const dow = getDay(date)
  const isWeekend = !state.policy.workDaysPerWeek.includes(dow)
  const weekNum = getWeek(date)
  const isEvenWeek = weekNum % 2 === 0

  const holidayName = useMemo(
    () => getHolidayName(state.policy, date),
    [state.policy, date],
  )
  const isHolidayDay = !!holidayName

  const plannedVacation = useMemo(() => {
    const dateStr = format(date, 'yyyy-MM-dd')
    return state.plannedVacations.find(
      (v) => dateStr >= v.startDate && dateStr <= v.endDate,
    )
  }, [date, state.plannedVacations])
  const isPlannedVacation = !!plannedVacation

  const isPartialDay = plannedVacation?.hoursPerDay !== undefined && plannedVacation.hoursPerDay < state.policy.hoursPerWorkDay

  const isPayday = useMemo(() => {
    const lastPayday = parseISO(state.profile.lastPaydayDate)
    const periodDays = state.policy.payPeriodLengthDays
    let payday = addDays(lastPayday, periodDays)
    while (isBefore(payday, date)) {
      payday = addDays(payday, periodDays)
    }
    return isSameDay(payday, date)
  }, [date, state.profile.lastPaydayDate, state.policy.payPeriodLengthDays])

  const projection = useMemo(() => {
    if (isPast && !isToday) return null
    return projectBalance(state, date)
  }, [state, date, isPast, isToday])
  const projectedBalances = projection
    ? {
        total: projection.totalAvailable,
        vacation: projection.vacationBalance,
        sick: projection.sickBalance,
        bank: projection.bankBalance,
      }
    : null
  const projectedBalance = projectedBalances?.total ?? null

  // Is this cell the vacation carryover payout day for its year? If so, find
  // the matching event (may be absent when the projected balance didn't
  // exceed the cap — in that case the anchor day is still shown, but with
  // "no payout this year").
  const carryoverPayout = useMemo(() => {
    const payoutDate = getCarryoverPayoutDate(state, date.getFullYear())
    if (!payoutDate || !isSameDay(payoutDate, date)) return null
    const isoDate = format(date, 'yyyy-MM-dd')
    const evt = projection?.events.find(
      (e) => e.type === 'carryover_adjustment' && e.date === isoDate,
    )
    return { amount: evt ? Math.abs(evt.delta) : 0 }
  }, [state, date, projection])

  const isLoggedPast = plannedVacation?.kind === 'logged_past'
  const deductHours =
    plannedVacation?.actualHoursUsed ??
    plannedVacation?.hoursPerDay ??
    state.policy.hoursPerWorkDay
  const isUnaffordable =
    isPlannedVacation && !isWeekend && !isHolidayDay &&
    projectedBalance !== null && projectedBalance < deductHours

  const isLocked = !!plannedVacation?.locked
  const canPlanNew = !isWeekend && !isHolidayDay && isCurrentMonth && !isPast
  const canEdit = isPlannedVacation && isCurrentMonth && !isWeekend && !isHolidayDay
  const canLogPast = !isWeekend && !isHolidayDay && isCurrentMonth && isPast && !isPlannedVacation
  const canClick = !isLocked && (canPlanNew || canEdit || canLogPast)

  const handleClick = () => {
    if (canClick) onDayClick(date)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (canClick) onDayClick(date)
    }
  }

  const buildTooltip = (): string => {
    const parts: string[] = []
    parts.push(format(date, 'EEEE, MMMM d'))

    if (isHolidayDay) {
      parts.push(`${getHolidayEmoji(holidayName!)} ${holidayName} — enjoy the day off!`)
    }

    if (isPayday && !isPast) {
      parts.push(`💰 Payday! +${fmt(state.policy.hoursPerWorkDay > 0 ? (() => {
        const hd = parseISO(state.profile.hireDate)
        const yos = Math.floor((date.getTime() - hd.getTime()) / (365.25 * 86400000))
        const tier = state.policy.accrualTiers.find(t => yos >= t.minYears && (t.maxYears === null || yos < t.maxYears))
        return tier?.hoursPerPayPeriod ?? 0
      })() : 0)} hrs vacation`)
    }

    if (carryoverPayout && !isPast) {
      if (carryoverPayout.amount > 0) {
        parts.push(
          `💵 Vacation carryover payout — ${fmt(carryoverPayout.amount)} hrs paid out (first pay date in ${format(date, 'MMMM')})`,
        )
      } else {
        parts.push(
          `💵 Carryover payout date (first pay date in ${format(date, 'MMMM')}) — no excess to pay out`,
        )
      }
    }

    if (isPlannedVacation && isPast) {
      const verb = isLoggedPast ? 'Logged absence' : 'Past time off'
      const noteSuffix = plannedVacation?.note ? ` (${plannedVacation.note})` : ''
      parts.push(`${isLoggedPast ? '🤒' : '✓'} ${verb} — ${fmt(deductHours)}h${noteSuffix}`)
      if (
        plannedVacation?.actualHoursUsed !== undefined &&
        plannedVacation.hoursPerDay !== undefined &&
        plannedVacation.actualHoursUsed !== plannedVacation.hoursPerDay
      ) {
        parts.push(`Originally planned: ${fmt(plannedVacation.hoursPerDay)}h`)
      }
      parts.push('Click to adjust hours actually used')
    } else if (canLogPast) {
      parts.push('Click to log a past absence')
    }

    if (isPlannedVacation && !isPast) {
      if (isPartialDay) {
        parts.push(`⏰ Partial day off (${fmt(deductHours)} hrs) — ${plannedVacation?.note || 'appointment'}`)
      } else if (dow === 5) {
        parts.push('🎉 Friday off — long weekend!')
      } else if (dow === 1) {
        parts.push('😎 Monday off — extended weekend!')
      } else {
        parts.push(`🏖️ Planned time off${plannedVacation?.note ? ` — ${plannedVacation.note}` : ''}`)
      }
      // Multi-day streak context
      if (plannedVacation && plannedVacation.startDate !== plannedVacation.endDate) {
        const days = Math.round((parseISO(plannedVacation.endDate).getTime() - parseISO(plannedVacation.startDate).getTime()) / 86400000) + 1
        if (days >= 7) parts.push('🌴 A full week+ vacation!')
        else if (days >= 4) parts.push('✨ Mini vacation!')
      }
      if (isUnaffordable) {
        parts.push(`⚠️ Not enough hours — only ${fmt(projectedBalance ?? 0)} hrs available, need ${fmt(deductHours)}`)
      }
    }

    if (projectedBalances !== null && !isPast) {
      const isWorkVacationDay = isPlannedVacation && !isWeekend && !isHolidayDay
      const header = isWorkVacationDay
        ? `Balance after this day's time off: ${fmt(projectedBalances.total)} hrs`
        : `Balance: ${fmt(projectedBalances.total)} hrs`
      parts.push(
        `${header}\n  • Vacation: ${fmt(projectedBalances.vacation)} hrs` +
          `\n  • Sick: ${fmt(projectedBalances.sick)} hrs` +
          `\n  • Bank: ${fmt(projectedBalances.bank)} hrs`,
      )
    }

    if (isLocked) {
      parts.push('🔒 Locked — click the lock icon to unlock')
    }

    return parts.join('\n')
  }

  // Cell background
  let bgClass = ''
  if (isHolidayDay && isCurrentMonth) {
    bgClass = 'bg-gradient-to-br from-amber-50/60 to-orange-50/40 dark:from-amber-950/25 dark:to-orange-950/15'
  } else if (isPlannedVacation && !isWeekend && !isHolidayDay && isCurrentMonth) {
    if (isLoggedPast) {
      bgClass = 'bg-rose-100/40 dark:bg-rose-900/15'
    } else if (isPast) {
      bgClass = 'bg-blue-100/30 dark:bg-blue-900/10'
    } else if (isUnaffordable) {
      bgClass = 'bg-gradient-to-br from-red-50 to-red-100/50 dark:from-red-950/30 dark:to-red-900/20'
    } else if (isPartialDay) {
      bgClass = 'bg-gradient-to-br from-blue-50/50 to-sky-50/30 dark:from-blue-950/20 dark:to-sky-950/10'
    } else {
      bgClass = 'bg-blue-50 dark:bg-blue-950/30'
    }
  } else if (carryoverPayout && carryoverPayout.amount > 0 && isCurrentMonth && !isPast) {
    bgClass = 'bg-gradient-to-br from-amber-50/40 to-yellow-50/30 dark:from-amber-950/20 dark:to-yellow-950/15'
  } else if (isPayday && isCurrentMonth && !isPast) {
    bgClass = 'bg-gradient-to-br from-emerald-50/30 to-green-50/20 dark:from-emerald-950/15 dark:to-green-950/10'
  } else if (isWeekend && isCurrentMonth) {
    bgClass = 'bg-gray-100/50 dark:bg-white/[0.02]'
  } else if (isEvenWeek && isCurrentMonth) {
    bgClass = 'bg-gray-50/30 dark:bg-white/[0.01]'
  }

  // Border
  const borderClass =
    isPlannedVacation && !isWeekend && !isHolidayDay && isCurrentMonth && !isPast
      ? isUnaffordable
        ? 'border-red-300/60 dark:border-red-700/40'
        : 'border-blue-300/60 dark:border-blue-700/40'
      : isHolidayDay && isCurrentMonth
        ? 'border-amber-200/60 dark:border-amber-800/30'
        : isPayday && isCurrentMonth && !isPast
          ? 'border-emerald-200/40 dark:border-emerald-800/20'
          : 'border-gray-300/60 dark:border-gray-600/40'

  return (
    <div
      role="button"
      tabIndex={isCurrentMonth ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`
        group relative p-1.5 min-h-0 border-r border-b
        ${borderClass}
        ${bgClass}
        ${!isCurrentMonth ? 'opacity-[0.08]' : ''}
        ${isPast && isCurrentMonth ? 'opacity-50' : ''}
        ${canClick ? 'cursor-pointer hover:bg-blue-50/60 dark:hover:bg-blue-900/15' : 'cursor-default'}
        transition-colors duration-75
      `}
      title={buildTooltip()}
      aria-label={`${format(date, 'MMMM d, yyyy')}${isToday ? ', today' : ''}${isHolidayDay ? `, ${holidayName}` : ''}${isPlannedVacation ? ', planned time off' : ''}${isPayday ? ', payday' : ''}${carryoverPayout && carryoverPayout.amount > 0 ? `, vacation carryover payout of ${fmt(carryoverPayout.amount)} hours` : ''}`}
    >
      {/* Day number row */}
      <div className="flex items-center justify-between">
        <span
          className={`
            inline-flex items-center justify-center w-8 h-8 text-base font-bold rounded-full
            ${isToday ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/40' : ''}
            ${isWeekend && !isToday && isCurrentMonth ? 'text-gray-400 dark:text-gray-500' : ''}
          `}
        >
          {format(date, 'd')}
        </span>
        {/* Indicator icons */}
        <div className="flex items-center gap-0.5">
          {isHolidayDay && isCurrentMonth && (
            <span className="text-sm leading-none">{getHolidayEmoji(holidayName!)}</span>
          )}
          {isPayday && isCurrentMonth && !isPast && (
            <span className="text-sm leading-none">💰</span>
          )}
          {carryoverPayout && isCurrentMonth && !isPast && (
            <span
              className="text-sm leading-none"
              title={
                carryoverPayout.amount > 0
                  ? `Vacation carryover payout — ${fmt(carryoverPayout.amount)} hrs paid out`
                  : 'Vacation carryover payout date (no excess this year)'
              }
            >
              💵
            </span>
          )}
          {isPlannedVacation && !isWeekend && !isHolidayDay && isCurrentMonth && !isPast && (
            <span
              className={`w-2 h-2 rounded-full ${isUnaffordable ? 'bg-red-500' : isPartialDay ? 'bg-sky-500' : 'bg-blue-500'}`}
            />
          )}
          {isPlannedVacation && !isWeekend && !isHolidayDay && isCurrentMonth && isPast && (
            <span className="text-xs leading-none" title={isLoggedPast ? 'Logged absence' : 'Past time off'}>
              {isLoggedPast ? '🤒' : '✓'}
            </span>
          )}
        </div>
      </div>

      {/* Lock toggle — bottom-left corner */}
      {isPlannedVacation && !isWeekend && !isHolidayDay && isCurrentMonth && plannedVacation && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            updateVacation(plannedVacation.id, { locked: !isLocked })
          }}
          className={`absolute bottom-1 left-1 p-0.5 rounded transition-all ${
            isLocked
              ? 'text-amber-500 hover:text-amber-400 hover:bg-amber-500/15'
              : 'text-gray-400/70 dark:text-gray-500/70 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-500/10 opacity-0 group-hover:opacity-100'
          }`}
          title={isLocked ? 'Locked — click to unlock' : 'Click to lock this time off'}
          aria-label={isLocked ? 'Unlock this time off' : 'Lock this time off'}
        >
          {isLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
        </button>
      )}

      {/* Time-off indicator — centered in cell */}
      {isPlannedVacation && !isWeekend && !isHolidayDay && isCurrentMonth && !isPast && (
        <div className="absolute inset-x-2 top-9 bottom-7 flex flex-col items-center justify-center pointer-events-none">
          {isPartialDay ? (
            <>
              <div className={`text-sm font-bold ${isUnaffordable ? 'text-red-400' : 'text-sky-400'}`}>
                {plannedVacation?.timeOffStart && plannedVacation?.timeOffEnd
                  ? `${formatTimeCompact(plannedVacation.timeOffStart)} – ${formatTimeCompact(plannedVacation.timeOffEnd)}`
                  : `${fmt(deductHours)}h`}
              </div>
              <div className={`w-8 h-[3px] rounded-full mt-1 ${isUnaffordable ? 'bg-red-400' : 'bg-sky-400'}`} />
              <div className={`text-xs mt-0.5 font-bold ${isUnaffordable ? 'text-red-400' : 'text-sky-300'}`}>
                {fmt(deductHours)}h off
              </div>
            </>
          ) : (
            <>
              <div className={`w-6 h-[3px] rounded-full ${isUnaffordable ? 'bg-red-400' : 'bg-blue-400'}`} />
            </>
          )}
        </div>
      )}

      {/* Balance badge — bottom right, hidden on holidays to avoid overlap
          with the holiday-name label (no balance change happens on a holiday
          anyway, so there's nothing useful to show). */}
      {isCurrentMonth && projectedBalance !== null && !isPast && !isWeekend && !isHolidayDay && (
        <div className="absolute bottom-1 right-1">
          <span
            className={`text-sm tabular-nums font-bold px-1.5 py-0.5 rounded ${
              isUnaffordable
                ? 'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400'
                : 'bg-gray-100/80 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400'
            }`}
          >
            {projectedBalance.toFixed(1)}h
          </span>
        </div>
      )}

      {/* Holiday name — bottom, full width since the balance badge is hidden */}
      {isHolidayDay && isCurrentMonth && (
        <div className="absolute bottom-0.5 left-1 right-1 text-[11px] text-amber-600 dark:text-amber-300 truncate font-bold drop-shadow-sm">
          {holidayName}
        </div>
      )}
    </div>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString()
}
