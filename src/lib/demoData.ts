import { format, subYears, subDays, previousFriday, addDays } from 'date-fns'
import type { AppState } from './types'
import { defaultPolicy } from './defaultPolicy'

/**
 * Generate a realistic demo state for showcasing the app.
 * Uses generic names — no real personal data.
 */
export function generateDemoState(): AppState {
  const today = new Date()
  const hireDate = subYears(today, 3.5)
  const lastFriday = previousFriday(today)

  return {
    profile: {
      displayName: 'Demo User',
      hireDate: format(hireDate, 'yyyy-MM-dd'),
      currentVacationHours: 62.3,
      currentSickHours: 32,
      currentBankHours: 4.75,
      lastPaydayDate: format(lastFriday, 'yyyy-MM-dd'),
    },
    policy: { ...defaultPolicy },
    plannedVacations: [
      {
        id: 'demo-1',
        startDate: format(addDays(today, 45), 'yyyy-MM-dd'),
        endDate: format(addDays(today, 49), 'yyyy-MM-dd'),
        hourSource: 'any',
        note: 'Long weekend getaway',
        locked: false,
      },
      {
        id: 'demo-2',
        startDate: format(addDays(today, 120), 'yyyy-MM-dd'),
        endDate: format(addDays(today, 131), 'yyyy-MM-dd'),
        hourSource: 'vacation',
        note: 'Holiday trip',
        locked: false,
      },
      {
        id: 'demo-3',
        startDate: format(addDays(today, 200), 'yyyy-MM-dd'),
        endDate: format(addDays(today, 204), 'yyyy-MM-dd'),
        hourSource: 'any',
        note: 'Winter break',
        locked: true,
      },
    ],
    bankHoursLog: [
      {
        id: 'demo-bank-1',
        date: format(subDays(today, 10), 'yyyy-MM-dd'),
        hours: 1.5,
        note: 'Stayed late for release',
      },
      {
        id: 'demo-bank-2',
        date: format(subDays(today, 3), 'yyyy-MM-dd'),
        hours: 0.75,
        note: 'Early morning meeting',
      },
    ],
    theme: 'dark',
    showTour: true,
    version: 1,
  }
}
