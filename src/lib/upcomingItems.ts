import { useMemo } from 'react'
import {
  addDays,
  differenceInDays,
  format,
  isBefore,
  parseISO,
  startOfDay,
} from 'date-fns'
import { Gift, TrendingUp } from 'lucide-react'
import type { ElementType } from 'react'
import { useAppState } from '../context'
import { getNextPayday } from './projection'
import { getNowInZone } from './timeUtils'
import { computeHolidayDates, getHolidayName } from './holidays'
import type { AppState, PlannedVacation } from './types'

export type InfoEvent = {
  key: string
  icon: ElementType
  label: string
  detail: string
  accent: string
  sortDate: Date
}

export function useUpcomingItems(): {
  sortedVacations: PlannedVacation[]
  infoEvents: InfoEvent[]
} {
  const { state } = useAppState()
  // Anchor "today" to the profile timezone so payday/relative-day math matches
  // projectBalance for a traveling user, instead of the browser's local clock.
  const today = startOfDay(
    parseISO(getNowInZone(state.profile.timezone || 'America/New_York').isoDate),
  )

  const sortedVacations = useMemo(
    () =>
      [...state.plannedVacations]
        .filter((v) => v.kind !== 'logged_past' && !isBefore(parseISO(v.endDate), today))
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [state.plannedVacations, today],
  )

  const infoEvents = useMemo(() => computeInfoEvents(state, today), [state, today])

  return { sortedVacations, infoEvents }
}

function computeInfoEvents(state: AppState, today: Date): InfoEvent[] {
  const items: InfoEvent[] = []

  const nextPayday = getNextPayday(
    parseISO(state.profile.lastPaydayDate),
    state.policy.payPeriodLengthDays,
    today,
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

  const lookAhead = addDays(today, 90)
  // Reuse the calendar's observed dates: includes last-weekday rules,
  // weekend shifts, start years, and New Year spillover without duplicates.
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    for (const holidayDate of computeHolidayDates(state.policy, year)) {
      if (isBefore(holidayDate, today) || !isBefore(holidayDate, lookAhead)) continue
      const name = getHolidayName(state.policy, holidayDate) ?? 'Holiday'
      const daysUntil = differenceInDays(holidayDate, today)
      items.push({
        key: `holiday-${format(holidayDate, 'yyyy-MM-dd')}`,
        icon: Gift,
        label: name,
        detail: `${format(holidayDate, 'EEE, MMM d')} — ${daysUntil === 0 ? 'today' : `${daysUntil}d away`}`,
        accent: 'text-amber-500',
        sortDate: holidayDate,
      })
    }
  }

  return items.sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime())
}
