import { useMemo } from 'react'
import { format, parseISO, addDays, isBefore, isSameDay, startOfDay, differenceInDays } from 'date-fns'
import { CalendarDays, Gift, Clock, TrendingUp } from 'lucide-react'
import { useAppState } from '../context'
import { getNextPayday } from '../lib/projection'

export function UpcomingEvents() {
  const { state } = useAppState()
  const today = startOfDay(new Date())

  const events = useMemo(() => {
    const items: Array<{
      icon: React.ElementType
      label: string
      detail: string
      accent: string
    }> = []

    // Next payday
    const nextPayday = getNextPayday(
      parseISO(state.profile.lastPaydayDate),
      state.policy.payPeriodLengthDays,
    )
    const daysToPayday = differenceInDays(nextPayday, today)
    if (daysToPayday >= 0 && daysToPayday <= 30) {
      items.push({
        icon: TrendingUp,
        label: `Payday in ${daysToPayday === 0 ? 'today' : daysToPayday === 1 ? '1 day' : `${daysToPayday} days`}`,
        detail: format(nextPayday, 'EEE, MMM d'),
        accent: 'text-emerald-500',
      })
    }

    // Upcoming holidays (next 90 days)
    const lookAhead = addDays(today, 90)
    for (const rule of state.policy.holidays) {
      for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
        let holidayDate: Date
        try {
          // Compute the holiday date (simplified — reuse the rule logic)
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
            icon: Gift,
            label: rule.name,
            detail: `${format(holidayDate, 'EEE, MMM d')} — ${daysUntil} day${daysUntil !== 1 ? 's' : ''} away`,
            accent: 'text-amber-500',
          })
        }
      }
    }

    // Upcoming planned time off
    const upcomingVacations = state.plannedVacations
      .filter((v) => !isBefore(parseISO(v.endDate), today))
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .slice(0, 3)

    for (const v of upcomingVacations) {
      const start = parseISO(v.startDate)
      const daysUntil = differenceInDays(start, today)
      if (daysUntil > 0) {
        items.push({
          icon: CalendarDays,
          label: v.note || 'Planned time off',
          detail: `${format(start, 'EEE, MMM d')} — ${daysUntil} day${daysUntil !== 1 ? 's' : ''} away`,
          accent: 'text-blue-500',
        })
      }
    }

    // Hours used this year
    const totalPlannedHours = state.plannedVacations
      .filter((v) => {
        const s = parseISO(v.startDate)
        return s.getFullYear() === today.getFullYear()
      })
      .reduce((sum, v) => {
        const days = Math.max(1, differenceInDays(parseISO(v.endDate), parseISO(v.startDate)) + 1)
        const hrsPerDay = v.hoursPerDay ?? state.policy.hoursPerWorkDay
        return sum + days * hrsPerDay
      }, 0)

    if (totalPlannedHours > 0) {
      items.push({
        icon: Clock,
        label: `${totalPlannedHours.toFixed(0)} hrs planned this year`,
        detail: `${state.plannedVacations.filter((v) => parseISO(v.startDate).getFullYear() === today.getFullYear()).length} time-off entries`,
        accent: 'text-cyan-500',
      })
    }

    return items
  }, [state, today])

  if (events.length === 0) return null

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200/60 dark:border-gray-700/40">
        <h3 className="text-sm font-semibold">Upcoming</h3>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
        {events.map((event, i) => (
          <div key={i} className="px-5 py-3 flex items-start gap-3">
            <event.icon className={`w-4 h-4 mt-0.5 shrink-0 ${event.accent}`} />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{event.label}</div>
              <div className="text-xs text-gray-400 dark:text-gray-500">{event.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
