import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, format, parseISO } from 'date-fns'
import { catchUpState, type CatchUpEvent } from '../catchUp'
import { getCarryoverOutlook, getCurrentBalanceSummary, projectBalance } from '../projection'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'

afterEach(() => vi.useRealTimers())
const at = (iso: string) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${iso}T15:00:00Z`))
}

function decemberState(overrides: Partial<AppState['profile']> = {}): AppState {
  return {
    profile: {
      displayName: 'Rollover fixture',
      hireDate: '2021-03-10', // 5 years in Dec 2026 → "Years 6–10" tier
      currentVacationHours: 110,
      currentSickHours: 70,
      currentBankHours: 12,
      lastPaydayDate: '2026-11-20',
      lastSyncDate: '2026-11-24',
      timezone: 'America/New_York',
      ...overrides,
    },
    policy: { ...defaultPolicy },
    plannedVacations: [
      // A trip that straddles New Year's Day (a holiday) and the sick reset.
      { id: 'winter', startDate: '2026-12-28', endDate: '2027-01-06', hourSource: 'any', locked: false },
      { id: 'appt', startDate: '2027-01-20', endDate: '2027-01-20', hourSource: 'sick', locked: false, hoursPerDay: 4 },
    ],
    bankHoursLog: [{ id: 'ot', date: '2027-01-12', hours: 6, appliedToBalance: false }],
    theme: 'dark',
    showTour: false,
    version: 2,
  }
}

/** Open the app once per day from `fromIso` through `toIso`. */
function openDaily(state: AppState, fromIso: string, toIso: string) {
  const events: CatchUpEvent[] = []
  const daily: Array<{ iso: string; state: AppState }> = []
  for (let d = parseISO(fromIso); d <= parseISO(toIso); d = addDays(d, 1)) {
    const iso = format(d, 'yyyy-MM-dd')
    at(iso)
    const result = catchUpState(state)
    state = result.state
    events.push(...result.events)
    daily.push({ iso, state })
  }
  return { state, events, daily }
}

describe('December → January rollover (2026 → 2027)', () => {
  it('the balance you see each day matches what was projected in November', () => {
    const start = decemberState()
    const { daily } = openDaily(start, '2026-11-24', '2027-03-15')
    for (const { iso, state } of daily) {
      at(iso)
      const seen = getCurrentBalanceSummary(state).available
      at('2026-11-24')
      const projected = projectBalance(start, parseISO(iso))
      // Stored balances are kept in hundredths each day, so allow a cent.
      const drift = Math.max(
        Math.abs(seen.vacation - projected.vacationBalance),
        Math.abs(seen.sick - projected.sickBalance),
        Math.abs(seen.bank - projected.bankBalance),
      )
      expect({ iso, drift: drift <= 0.011 }).toEqual({ iso, drift: true })
    }
  })

  it('resets sick hours on Jan 1, pays out bank hours twice and keeps accruing', () => {
    const { state, events } = openDaily(decemberState(), '2026-11-24', '2027-03-15')
    const on = (date: string, type: CatchUpEvent['type']) =>
      events.filter((e) => e.date === date && e.type === type).map((e) => e.delta)

    // 70h sick: capped to the 40h carry-over limit, then +40h grant (80h max).
    expect(on('2027-01-01', 'sick_carryover_forfeit')).toEqual([-30])
    expect(on('2027-01-01', 'sick_grant')).toEqual([40])
    // Bank pays out on the first payday after Dec 15 and after Feb 15.
    expect(on('2026-12-18', 'bank_payout')).toEqual([-12])
    expect(on('2027-02-26', 'bank_payout')).toEqual([-6])
    // Biweekly accruals continue straight through the holidays.
    const accrualDates = events.filter((e) => e.type === 'accrual').map((e) => e.date)
    expect(accrualDates).toEqual([
      '2026-12-04', '2026-12-18', '2027-01-01', '2027-01-15', '2027-01-29',
      '2027-02-12', '2027-02-26', '2027-03-12',
    ])
    // New Year's Day is a holiday, so the winter trip charges 7 workdays, not 8.
    const trip = state.plannedVacations.find((v) => v.id === 'winter')!
    expect(trip.kind).toBe('logged_past')
    expect(trip.appliedDeductions?.map((d) => d.date)).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
      '2027-01-04', '2027-01-05', '2027-01-06',
    ])
    expect(state.profile).toMatchObject({
      currentSickHours: 76, // 80 after the reset, minus the 4h appointment
      currentBankHours: 0,
      lastPaydayDate: '2027-03-12',
      lastSyncDate: '2027-03-15',
    })
  })

  it('carry-over payout only takes last year\'s excess, not January accruals', () => {
    // 200h vacation, no plans: cap for the 6–10 tier is 4.615 × 26 = 119.99h.
    const start: AppState = { ...decemberState({ currentVacationHours: 200 }), plannedVacations: [], bankHoursLog: [] }
    at('2026-11-24')
    const outlook = getCarryoverOutlook(start)
    expect(format(outlook.payoutDate!, 'yyyy-MM-dd')).toBe('2027-02-12')
    // Dec 31 balance = 200 + two December accruals; that excess over the cap is paid.
    const dec31 = projectBalance(start, parseISO('2026-12-31')).vacationBalance
    expect(outlook.projectedPayout).toBeCloseTo(dec31 - 119.99, 2)

    const { events } = openDaily(start, '2026-11-24', '2027-02-12')
    const payout = events.find((e) => e.type === 'carryover_payout')!
    expect(payout.date).toBe('2027-02-12')
    expect(Math.abs(-payout.delta - outlook.projectedPayout)).toBeLessThan(0.05)
  })

  it('catching up after weeks away gives the same result as opening every day', () => {
    const daily = openDaily(decemberState(), '2026-11-24', '2027-03-15').state
    at('2027-03-15')
    const once = catchUpState(decemberState()).state
    expect(once.profile).toEqual(daily.profile)
    expect(once.plannedVacations).toEqual(daily.plannedVacations)
  })
})
