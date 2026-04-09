import { useMemo } from 'react'
import {
  addDays,
  differenceInDays,
  format,
  isBefore,
  isSameDay,
  parseISO,
  startOfDay,
} from 'date-fns'
import { Gift, TrendingUp } from 'lucide-react'
import type { ElementType } from 'react'
import { useAppState } from '../context'
import { getNextPayday } from './projection'
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
  const today = startOfDay(new Date())

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
  for (const rule of state.policy.holidays) {
    for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
      let holidayDate: Date
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

      if (
        !isBefore(holidayDate, today) &&
        isBefore(holidayDate, lookAhead) &&
        !isSameDay(holidayDate, today)
      ) {
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
}
