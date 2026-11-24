import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, format, parseISO } from 'date-fns'
import { catchUpState, type CatchUpEvent } from '../catchUp'
import { getCarryoverOutlook, getCurrentBalanceSummary, projectBalance } from '../projection'
import { defaultPolicy } from '../defaultPolicy'
import { LEGACY_BANK_POLICY } from './legacyBankPolicy'
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

  it('resets sick hours on Jan 1, settles bank hours by Dec 31 and keeps accruing', () => {
    const { state, events } = openDaily(decemberState(), '2026-11-24', '2027-03-15')
    const on = (date: string, type: CatchUpEvent['type']) =>
      events.filter((e) => e.date === date && e.type === type).map((e) => e.delta)

    // 70h sick: capped to the 40h carry-over limit, then +40h grant (80h max).
    expect(on('2027-01-01', 'sick_carryover_forfeit')).toEqual([-30])
    expect(on('2027-01-01', 'sick_grant')).toEqual([40])
    // The Auto-sourced winter trip draws bank hours first (12h on Dec 28–29),
    // so nothing is left to pay out on Dec 31; the 6h banked Jan 12 is kept.
    expect(on('2026-12-28', 'vacation_deduction')).toEqual([-8])
    expect(events.filter((e) => e.date === '2026-12-28')[0].pool).toBe('bank')
    expect(events.filter((e) => e.type === 'bank_payout' && e.delta < 0)).toEqual([])
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
      currentBankHours: 6,
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

describe('what carries into the new year', () => {
  // 3 years of service → 3.076 h/period; carry-over cap 3.076 × 26 = 79.98h.
  const base = (profile: Partial<AppState['profile']>, extra: Partial<AppState> = {}): AppState => ({
    ...decemberState({ hireDate: '2023-06-01', lastSyncDate: '2026-12-31', lastPaydayDate: '2026-12-18', ...profile }),
    plannedVacations: [],
    bankHoursLog: [],
    ...extra,
  })
  const accrual = 3.076
  // Paydays Jan 1 → Feb 12 2027 (the carry-over payout payday): 4 accruals.
  const janToPayoutAccruals = 4 * accrual

  it('vacation under the cap carries over in full and new-year accruals stack on top', () => {
    const { events, state } = openDaily(base({ currentVacationHours: 70 }), '2026-12-31', '2027-02-12')
    expect(events.filter((e) => e.type === 'carryover_payout')).toEqual([])
    expect(state.profile.currentVacationHours).toBeCloseTo(70 + janToPayoutAccruals, 1)
  })

  it('vacation over the cap loses only the excess, and January usage counts against the excess first', () => {
    const plain = openDaily(base({ currentVacationHours: 100 }), '2026-12-31', '2027-02-12')
    const plainPayout = -plain.events.find((e) => e.type === 'carryover_payout')!.delta
    expect(plainPayout).toBeCloseTo(100 - 79.98, 1)
    // Keeps exactly the cap plus everything earned since Jan 1.
    expect(plain.state.profile.currentVacationHours).toBeCloseTo(79.98 + janToPayoutAccruals, 1)

    // Taking two days off in January means two fewer days are over the cap.
    const usedInJanuary = openDaily(
      base({ currentVacationHours: 100 }, {
        plannedVacations: [{ id: 'jan', startDate: '2027-01-11', endDate: '2027-01-12', hourSource: 'vacation', locked: false }],
      }),
      '2026-12-31',
      '2027-02-12',
    )
    const reducedPayout = -usedInJanuary.events.find((e) => e.type === 'carryover_payout')!.delta
    expect(reducedPayout).toBeCloseTo(plainPayout - 16, 1)
    expect(usedInJanuary.state.profile.currentVacationHours).toBeCloseTo(79.98 + janToPayoutAccruals, 1)
  })

  it('sick leave keeps everything up to the carry-over limit, then adds the yearly grant at once', () => {
    const jan1 = (sick: number, policy: Partial<AppState['policy']> = {}) => {
      const start = base({ currentSickHours: sick })
      start.policy = { ...start.policy, ...policy }
      return openDaily(start, '2026-12-31', '2027-01-01').state.profile.currentSickHours
    }
    expect(jan1(25)).toBe(65) // all 25 kept + 40
    expect(jan1(40)).toBe(80) // exactly at the limit: nothing lost
    expect(jan1(70)).toBe(80) // 30 over the 40h limit forfeited, then + 40
    expect(jan1(25, { sickLeaveAnnualGrant: 56, sickLeaveMaxBalance: 120 })).toBe(81) // custom grant
    expect(jan1(70, { sickLeaveCarryoverCap: undefined, sickLeaveMaxBalance: 200 })).toBe(110) // no limit
  })

  it('bank hours are all paid out at the end of Dec 31; new-year hours are kept', () => {
    const start = base({ currentBankHours: 10, lastSyncDate: '2026-12-01', lastPaydayDate: '2026-11-20' }, {
      bankHoursLog: [
        { id: 'late-dec', date: '2026-12-21', hours: 5, appliedToBalance: false },
        { id: 'new-years-eve', date: '2026-12-31', hours: 2, appliedToBalance: false },
        { id: 'january', date: '2027-01-05', hours: 3, appliedToBalance: false },
      ],
    })
    const { events, daily, state } = openDaily(start, '2026-12-01', '2027-03-31')
    const bankPayouts = events.filter((e) => e.type === 'bank_payout' && e.delta < 0)
    // Everything banked through Dec 31, including that day, is paid out once.
    expect(bankPayouts.map((e) => [e.date, e.delta])).toEqual([['2026-12-31', -17]])
    expect(daily.find((d) => d.iso === '2027-01-01')!.state.profile.currentBankHours).toBe(0)
    // No February payout: January hours stay until next Dec 31.
    expect(state.profile.currentBankHours).toBe(3)
  })

  it('the older Dec 15 + Feb 15 payday schedule still works when configured', () => {
    const start = base({ currentBankHours: 10, lastSyncDate: '2026-12-01', lastPaydayDate: '2026-11-20' }, {
      bankHoursLog: [{ id: 'late-dec', date: '2026-12-21', hours: 5, appliedToBalance: false }],
    })
    start.policy = { ...start.policy, ...LEGACY_BANK_POLICY }
    const { events, daily } = openDaily(start, '2026-12-01', '2027-02-26')
    expect(events.filter((e) => e.type === 'bank_payout' && e.delta < 0).map((e) => [e.date, e.delta])).toEqual([
      ['2026-12-18', -10], // first payday on/after Dec 15
      ['2027-02-26', -5], // first payday on/after Feb 15
    ])
    expect(daily.find((d) => d.iso === '2027-01-01')!.state.profile.currentBankHours).toBe(5)
  })
})

describe('getNextBankPayout', () => {
  it('defaults to Dec 31 each year', async () => {
    const { getNextBankPayout } = await import('../projection')
    const state: AppState = { ...decemberState(), plannedVacations: [], bankHoursLog: [] }
    at('2026-11-24')
    let next = getNextBankPayout(state)
    expect(format(next.payoutDate!, 'yyyy-MM-dd')).toBe('2026-12-31')
    expect(next.projectedPayout).toBe(12)
    at('2027-01-02')
    next = getNextBankPayout({ ...state, profile: { ...state.profile, currentBankHours: 3, lastSyncDate: '2027-01-02' } })
    expect(format(next.payoutDate!, 'yyyy-MM-dd')).toBe('2027-12-31')
  })

  it('follows the payday schedule when configured', async () => {
    const { getNextBankPayout } = await import('../projection')
    const base: AppState = { ...decemberState(), plannedVacations: [], bankHoursLog: [] }
    const state: AppState = { ...base, policy: { ...base.policy, ...LEGACY_BANK_POLICY } }
    at('2026-11-24')
    expect(format(getNextBankPayout(state).payoutDate!, 'yyyy-MM-dd')).toBe('2026-12-18')
    at('2026-12-20')
    expect(format(getNextBankPayout(state).payoutDate!, 'yyyy-MM-dd')).toBe('2027-02-26')
  })
})
