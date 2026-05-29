import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addDays, format, subYears, previousFriday } from 'date-fns'
import {
  analyzeTripImpact,
  computeAccrualTier,
  countWorkDays,
  earliestAffordableDate,
  earliestAffordableTripStart,
  firstPaydayOnOrAfter,
  getCarryoverPayoutDate,
  getEffectiveCurrentBalances,
  projectBalance,
} from '../projection'
import { computeHolidayDates } from '../holidays'
import { defaultPolicy } from '../defaultPolicy'
import { parseISO } from 'date-fns'
import type { AppState, PlannedVacation } from '../types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  const today = new Date()
  // Find the most recent Friday as last payday
  const lastFriday = previousFriday(today)

  return {
    profile: {
      displayName: 'Test User',
      hireDate: format(subYears(today, 2), 'yyyy-MM-dd'),
      currentVacationHours: 40,
      currentSickHours: 20,
      currentBankHours: 0,
      lastPaydayDate: format(lastFriday, 'yyyy-MM-dd'),
    },
    policy: { ...defaultPolicy },
    plannedVacations: [],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 1,
    ...overrides,
  }
}

// Mock the current date for deterministic tests
function mockToday(dateStr: string) {
  const fakeNow = new Date(dateStr + 'T12:00:00').getTime()
  vi.useFakeTimers()
  vi.setSystemTime(fakeNow)
}

beforeEach(() => {
  // Default to a fixed date for all tests
  mockToday('2025-06-15')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('projectBalance', () => {
  it('Test 1: Year-1 employee with no planned vacation, projected 6 months out — balance increases by correct number of accruals', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2025-01-01',
        currentVacationHours: 10,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13', // Friday before "today" (Jun 15)
      },
    })

    // Project 6 months out (~182 days)
    const targetDate = new Date('2025-12-15')
    const result = projectBalance(state, targetDate)

    // From Jun 13 to Dec 15 is ~185 days, ~13 pay periods.
    // Default Year-1 rate is 3.076 hrs/pp.
    const accrualEvents = result.events.filter((e) => e.type === 'accrual')
    expect(accrualEvents.length).toBeGreaterThan(0)
    accrualEvents.forEach((e) => {
      expect(e.delta).toBeCloseTo(3.076, 2)
    })

    const expectedBalance = 10 + accrualEvents.length * 3.076
    expect(result.vacationBalance).toBeCloseTo(expectedBalance, 1)
  })

  it('Test 2: Employee crossing a tier boundary mid-projection — verify tier change happens on the right payday', () => {
    // Hire date: Jun 15, 2020 — crosses the 5-year mark on Jun 15, 2025 (which is "today")
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-06-15',
        currentVacationHours: 20,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })

    const targetDate = new Date('2025-09-15')
    const result = projectBalance(state, targetDate)

    const accrualEvents = result.events.filter((e) => e.type === 'accrual')

    // First payday after today (Jun 15) is Jun 27. The pay-period
    // (Jun 13 → Jun 27) spans the Jun 15 anniversary, so that payday's
    // accrual is pro-rated across the two tiers — the rest are full
    // 5–10-year-tier rate (4.615 hrs/pp).
    expect(accrualEvents.length).toBeGreaterThan(1)
    const [first, ...rest] = accrualEvents
    // 2 days at year-1-5 tier (3.076), 12 days at year-5-10 tier (4.615),
    // weighted: (3.076 * 2 + 4.615 * 12) / 14 ≈ 4.395
    expect(first.delta).toBeGreaterThan(3.076)
    expect(first.delta).toBeLessThan(4.615)
    rest.forEach((e) => {
      expect(e.delta).toBeCloseTo(4.615, 2)
    })
  })

  it('Test 3: Employee whose projected balance would exceed carryover cap — verify Feb 1 haircut', () => {
    // Employee with a lot of hours, projection past Feb 1
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-01-01', // 5+ years
        currentVacationHours: 150, // Already high
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })

    const targetDate = new Date('2026-03-01') // Past Feb 1
    const result = projectBalance(state, targetDate)

    // The carryover cap with "annual_accrual" strategy and 5-10yr tier (4.62 hrs/pp):
    // periods per year = round(365/14) = 26
    // cap = 4.62 * 26 = 120.12
    // So balance of 150+ should be capped to ~120.12 on Feb 1

    const carryoverEvents = result.events.filter(
      (e) => e.type === 'carryover_adjustment',
    )
    expect(carryoverEvents.length).toBe(1)
    // lastPaydayDate is 2025-06-13 (Friday); biweekly paydays put the first
    // payday on/after Feb 1, 2026 at Feb 6, 2026.
    expect(carryoverEvents[0].date).toBe('2026-02-06')
    expect(carryoverEvents[0].delta).toBeLessThan(0) // It's a reduction
    // After the haircut, balance should be at cap
    expect(carryoverEvents[0].runningBalance).toBeCloseTo(120.12, 0)
  })

  it('Test 4: Planned vacation spanning a weekend and a holiday — verify only actual work days are deducted', () => {
    // Labor Day 2025 is Sep 1 (1st Monday of September)
    // Plan a vacation from Aug 29 (Fri) to Sep 3 (Wed)
    // That's Fri Aug 29, Sat Aug 30, Sun Aug 31, Mon Sep 1 (Labor Day), Tue Sep 2, Wed Sep 3
    // Work days to deduct: Aug 29 (Fri), Sep 2 (Tue), Sep 3 (Wed) = 3 days
    // NOT: Sat, Sun (weekend), NOT: Mon Sep 1 (holiday)
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 80,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
      plannedVacations: [
        {
          id: '1',
          startDate: '2025-08-29',
          endDate: '2025-09-03',
          hourSource: 'vacation' as const,
          locked: false,
        },
      ],
    })

    const targetDate = new Date('2025-09-15')
    const result = projectBalance(state, targetDate)

    const deductions = result.events.filter(
      (e) => e.type === 'vacation_deduction',
    )
    expect(deductions).toHaveLength(3) // Only 3 work days
    expect(deductions[0].delta).toBe(-8) // 8 hours per day
  })

  it('Test 5: earliestAffordableDate for someone who needs 80 hours but currently has 20', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01', // 1-5yr tier: 3.08 hrs/pp
        currentVacationHours: 20,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })

    const result = earliestAffordableDate(
      state,
      80,
      new Date('2025-06-15'),
    )

    expect(result).not.toBeNull()

    // Need 60 more hours at 3.08/pp = ~19.5 pay periods = ~273 days
    // So somewhere around March 2026
    if (result) {
      // Verify the total available reaches 80 on that date
      const projection = projectBalance(state, result)
      expect(projection.totalAvailable).toBeGreaterThanOrEqual(80)

      // And that one pay period earlier, it hadn't yet
      const oneBefore = addDays(result, -14)
      if (oneBefore > new Date('2025-06-15')) {
        const projBefore = projectBalance(state, oneBefore)
        expect(projBefore.totalAvailable).toBeLessThan(80)
      }
    }
  })

  it('Test 6: Holiday observance — Independence Day on Saturday observed on Friday, Christmas on Sunday observed on Monday', () => {
    // 2026: July 4 is a Saturday -> observed Friday July 3
    // 2022: Christmas Dec 25 is a Sunday -> observed Monday Dec 26
    // Holiday dates are local-midnight civil dates, so read their fields with
    // the LOCAL getters — this is correct in ANY runner timezone.
    const holidays2026 = computeHolidayDates(defaultPolicy, 2026)
    const july3 = holidays2026.find(
      (d) => d.getMonth() === 6 && d.getDate() === 3,
    )
    expect(july3).toBeDefined()
    // No July 4 in the observed list
    const july4 = holidays2026.find(
      (d) => d.getMonth() === 6 && d.getDate() === 4,
    )
    expect(july4).toBeUndefined()

    const holidays2022 = computeHolidayDates(defaultPolicy, 2022)
    const dec26 = holidays2022.find(
      (d) => d.getMonth() === 11 && d.getDate() === 26,
    )
    expect(dec26).toBeDefined()
  })

  it('Test 7: Zero-state — projectBalance with targetDate === today returns currentVacationHours unchanged', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 47.3,
        currentSickHours: 15,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })

    // Target = today (Jun 15, 2025)
    const result = projectBalance(state, new Date('2025-06-15'))
    expect(result.vacationBalance).toBe(47.3)
    expect(result.sickBalance).toBe(15)
    expect(result.events).toHaveLength(0)
    expect(result.carryoverAdjustment).toBe(0)
  })
})

describe('getEffectiveCurrentBalances (timezone-aware EOD cutoff)', () => {
  it('does NOT deduct same-day vacation before the local end-of-work-day', () => {
    // Mock current time to 10:00 ET (before 4 PM cutoff)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-16T14:00:00Z')) // 10 AM ET in summer (UTC-4)

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'today-vacation',
          startDate: '2025-06-16',
          endDate: '2025-06-16',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })

    const eff = getEffectiveCurrentBalances(state)
    // Before 4 PM ET — vacation balance should still be 40, not 32.
    expect(eff.vacation).toBe(40)
    expect(eff.total).toBe(60)
  })

  it('DOES deduct same-day vacation after the local end-of-work-day', () => {
    // Mock to 5 PM ET — past the 4 PM cutoff for an 8-hour day starting at 8 AM
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-16T21:00:00Z')) // 5 PM ET

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'today-vacation',
          startDate: '2025-06-16',
          endDate: '2025-06-16',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })

    const eff = getEffectiveCurrentBalances(state)
    expect(eff.vacation).toBe(32)
    expect(eff.total).toBe(52)
  })

  it('respects user timezone — PT user at 10 AM PT (1 PM ET) is still pre-cutoff', () => {
    // 10 AM PT = 5 PM UTC = 1 PM ET. Both ET and PT users see "before 4 PM local",
    // but specifically the PT user's clock should be honored.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-16T17:00:00Z')) // 10 AM PT

    const state = makeState({
      profile: {
        displayName: 'PT User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
        timezone: 'America/Los_Angeles',
      },
      plannedVacations: [
        {
          id: 'today-vacation',
          startDate: '2025-06-16',
          endDate: '2025-06-16',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })

    const eff = getEffectiveCurrentBalances(state)
    // Still pre-cutoff in PT — should not deduct
    expect(eff.vacation).toBe(40)
  })

  it('logged_past entries are NOT re-deducted (already mutated stored balances)', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 16, // already debited 4 by the logged-past entry
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'past-sick',
          startDate: '2025-06-10',
          endDate: '2025-06-10',
          hoursPerDay: 4,
          actualHoursUsed: 4,
          hourSource: 'sick',
          locked: false,
          kind: 'logged_past',
        },
      ],
    })

    const eff = getEffectiveCurrentBalances(state)
    // Sick should remain at 16, not 12 — the entry already drained it on creation.
    expect(eff.sick).toBe(16)
  })
})

describe('carryover payout date snapping', () => {
  it('firstPaydayOnOrAfter returns the anchor itself when it lines up with a payday', () => {
    const lastPayday = new Date(2025, 11, 26) // Dec 26, 2025 (Fri)
    const anchor = new Date(2026, 0, 9) // Jan 9, 2026 — exactly 14 days later
    const result = firstPaydayOnOrAfter(lastPayday, 14, anchor)
    expect(format(result, 'yyyy-MM-dd')).toBe('2026-01-09')
  })

  it('firstPaydayOnOrAfter walks forward to the next payday when the anchor is mid-cycle', () => {
    const lastPayday = new Date(2025, 5, 13) // Jun 13, 2025 (Fri)
    const anchor = new Date(2026, 1, 1) // Feb 1, 2026 (Sun)
    const result = firstPaydayOnOrAfter(lastPayday, 14, anchor)
    // 2025-06-13 + 17*14 days = 2026-02-06
    expect(format(result, 'yyyy-MM-dd')).toBe('2026-02-06')
  })

  it('getCarryoverPayoutDate snaps to the first Feb payday for the given year', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })
    const date = getCarryoverPayoutDate(state, 2026)
    expect(date).not.toBeNull()
    expect(format(date!, 'yyyy-MM-dd')).toBe('2026-02-06')
  })

  it('getCarryoverPayoutDate returns null when policy strategy is unlimited', () => {
    const state = makeState({
      policy: { ...defaultPolicy, carryoverCapStrategy: 'unlimited' },
    })
    expect(getCarryoverPayoutDate(state, 2026)).toBeNull()
  })

  it('firstPaydayOnOrAfter snaps backward when lastPayday is AFTER the anchor', () => {
    // Demo scenario: lastPayday May 15 2026, biweekly, carryover anchor Feb 1.
    // A forward-only walk never runs (May 15 is already >= Feb 1) and would
    // wrongly return May 15. The correct answer is the first payday on/after
    // Feb 1 on the 14-day cycle anchored at May 15.
    const lastPayday = parseISO('2026-05-15')
    const anchor = parseISO('2026-02-01')
    const result = firstPaydayOnOrAfter(lastPayday, 14, anchor)

    // On or after Feb 1, and strictly before Feb 1 + 14 days (i.e. it's the
    // FIRST payday that qualifies, not some later one).
    expect(result.getTime()).toBeGreaterThanOrEqual(anchor.getTime())
    expect(result.getTime()).toBeLessThan(addDays(anchor, 14).getTime())

    // It lands on the 14-day cycle from May 15: (result - May 15) is a
    // multiple of 14 days.
    const dayDelta = Math.round(
      (result.getTime() - lastPayday.getTime()) / (24 * 60 * 60 * 1000),
    )
    expect(Math.abs(dayDelta % 14)).toBe(0) // abs() avoids the -0 vs +0 quirk for negative deltas

    // And it is a February date, not May.
    expect(result.getMonth()).toBe(1) // Feb (0-indexed)
  })

  it('getCarryoverPayoutDate on a demo-like state returns FEBRUARY, not May', () => {
    const state = makeState({
      profile: {
        displayName: 'Demo User',
        hireDate: '2020-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2026-05-15', // demo's lastPaydayDate
      },
      policy: {
        ...defaultPolicy,
        payPeriodLengthDays: 14,
        carryoverPayoutDate: { month: 2, day: 1 },
      },
    })
    const date = getCarryoverPayoutDate(state, 2026)
    expect(date).not.toBeNull()
    // The bug returned May 15; the fix must return a February date.
    expect(date!.getMonth()).toBe(1) // February
    expect(date!.getFullYear()).toBe(2026)
  })
})

describe('bank payout fires ONCE per window, on the first payday after it opens', () => {
  it('emits exactly one bank_payout per year, dated on the next payday after the window opens', () => {
    // Default window: Dec 15 → Feb 15 (spans year boundary). Today: Dec 1 2025.
    // lastPayday Nov 28 (Fri), biweekly → paydays Nov 28, Dec 12, Dec 26… The
    // first payday on/after the Dec 15 window-open is Dec 26, so the payout
    // lands there (not on Dec 15, and not again at Feb 15).
    mockToday('2025-12-01')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 12,
        lastPaydayDate: '2025-11-28',
      },
    })

    const result = projectBalance(state, new Date('2026-03-01'))

    const payouts = result.events.filter((e) => e.type === 'bank_payout')
    expect(payouts).toHaveLength(1)
    expect(payouts[0].date).toBe('2025-12-26')
    expect(payouts[0].delta).toBe(-12)
    expect(result.bankBalance).toBe(0)
    // Total paid out reflects a single payout, not a double-count.
    expect(result.bankPayout).toBe(12)
  })
})

describe('sick leave carryover cap', () => {
  it('forfeits hours above the carryover cap, then grants the new annual amount, capped at max', () => {
    // Project across a year boundary so the sick_grant event fires.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-12-15T12:00:00'))

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 60, // above the 40-hour carryover cap
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
      },
      policy: {
        ...defaultPolicy,
        sickLeaveAnnualGrant: 40,
        sickLeaveCarryoverCap: 40,
        sickLeaveMaxBalance: 80,
      },
    })

    const result = projectBalance(state, new Date('2026-02-01'))
    // Carryover from 60 → cap to 40, then +40 grant = 80 (the max)
    expect(result.sickBalance).toBe(80)
  })

  it('does NOT forfeit hours when balance is within the carryover cap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-12-15T12:00:00'))

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 25, // below the 40-hour carryover cap
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
      },
      policy: {
        ...defaultPolicy,
        sickLeaveAnnualGrant: 40,
        sickLeaveCarryoverCap: 40,
        sickLeaveMaxBalance: 80,
      },
    })

    const result = projectBalance(state, new Date('2026-02-01'))
    // 25 carries over (below 40 cap), +40 grant = 65
    expect(result.sickBalance).toBe(65)
  })
})

describe('computeAccrualTier', () => {
  it('returns correct tier for each range', () => {
    expect(computeAccrualTier(defaultPolicy, 0).hoursPerPayPeriod).toBe(3.076)
    expect(computeAccrualTier(defaultPolicy, 0.5).hoursPerPayPeriod).toBe(3.076)
    expect(computeAccrualTier(defaultPolicy, 1).hoursPerPayPeriod).toBe(3.076)
    expect(computeAccrualTier(defaultPolicy, 3).hoursPerPayPeriod).toBe(3.076)
    expect(computeAccrualTier(defaultPolicy, 5).hoursPerPayPeriod).toBe(4.615)
    expect(computeAccrualTier(defaultPolicy, 10).hoursPerPayPeriod).toBe(6.153)
    expect(computeAccrualTier(defaultPolicy, 25).hoursPerPayPeriod).toBe(6.153)
  })
})

describe('computeHolidayDates', () => {
  it('generates correct number of holidays', () => {
    const holidays = computeHolidayDates(defaultPolicy, 2025)
    expect(holidays.length).toBe(12)
  })

  it('correctly computes MLK Day 2025 (3rd Monday in January)', () => {
    const holidays = computeHolidayDates(defaultPolicy, 2025)
    const mlk = holidays.find(
      (d) => d.getMonth() === 0 && d.getDate() === 20,
    )
    expect(mlk).toBeDefined()
  })

  it('correctly computes Memorial Day 2025 (last Monday in May)', () => {
    const holidays = computeHolidayDates(defaultPolicy, 2025)
    const memorial = holidays.find(
      (d) => d.getMonth() === 4 && d.getDate() === 26,
    )
    expect(memorial).toBeDefined()
  })

  it('correctly computes Thanksgiving 2025 (4th Thursday in November)', () => {
    const holidays = computeHolidayDates(defaultPolicy, 2025)
    const thanksgiving = holidays.find(
      (d) => d.getMonth() === 10 && d.getDate() === 27,
    )
    expect(thanksgiving).toBeDefined()
  })
})

describe('analyzeTripImpact (cross-year affordability)', () => {
  function tripFor(start: string, end: string, source: PlannedVacation['hourSource'] = 'any'): PlannedVacation {
    return { id: 'preview', startDate: start, endDate: end, hourSource: source, locked: false, kind: 'planned' }
  }

  it('Dec 28 → Jan 5 trip funded by the Jan 1 sick grant is affordable even when At-Start balance < hours needed', () => {
    // Today: Dec 27, 2025. Trip: Dec 29 (Mon) → Jan 5 (Mon). Work days:
    // Dec 29, 30, 31, Jan 2, Jan 5 = 5 work days (Jan 1 is a holiday) = 40 hrs.
    // Pre-Jan-1 balance: 24 vac (3 days × 8) + 0 sick + 0 bank — only enough
    // for 3 of the 5 days. Jan 1 grants +40 sick → covers Jan 2 and Jan 5.
    mockToday('2025-12-27')

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 24,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-26',
      },
      plannedVacations: [],
    })

    const trip = tripFor('2025-12-29', '2026-01-05')
    const impact = analyzeTripImpact(state, trip, new Date('2026-02-15'))

    // No leftover shortfall — Jan 1 sick grant covers the post-NYD portion.
    expect(impact.tripItselfShortfall).toBe(0)
    expect(impact.downstreamShortfall).toBe(0)
    // At-start balance is below the 40 hrs needed, but the trip is still
    // affordable thanks to the +40 sick grant in the middle.
    expect(impact.balanceBeforeTrip).toBeLessThan(40)
  })

  it('Dec 29 → Jan 5 trip is correctly flagged short when grant is too small', () => {
    // Same dates, but vacation balance is 16 (only 2 days of pre-Jan coverage)
    // and sick grant is reduced to 8 hrs. 5 work-days × 8 = 40 needed; only
    // 16 + 8 = 24 covered → 16 hrs short.
    mockToday('2025-12-27')

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 16,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-26',
      },
      policy: { ...defaultPolicy, sickLeaveAnnualGrant: 8 },
    })

    const trip = tripFor('2025-12-29', '2026-01-05')
    const impact = analyzeTripImpact(state, trip, new Date('2026-02-15'))
    expect(impact.tripItselfShortfall).toBeGreaterThan(0)
  })

  it('Trip itself fits but pushes a later trip into deficit → downstream shortfall reported', () => {
    mockToday('2025-12-27')

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 80,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-26',
      },
      policy: { ...defaultPolicy, sickLeaveAnnualGrant: 0 },
      plannedVacations: [
        // Existing 10-work-day trip in March needing 80 hrs of vacation.
        {
          id: 'march',
          startDate: '2026-03-09',
          endDate: '2026-03-20',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })

    // New trip Dec 29 → Jan 2 = 4 work days × 8 = 32 hrs from vacation.
    // Vacation goes 80 → 48; accruals between now and March add ≈ 15 hrs;
    // March trip needs 80 hrs but only ~63 will be available → ~17 hrs of
    // downstream shortfall.
    const newTrip = tripFor('2025-12-29', '2026-01-02', 'vacation')
    const impact = analyzeTripImpact(state, newTrip, new Date('2026-04-30'))
    expect(impact.tripItselfShortfall).toBe(0)
    expect(impact.downstreamShortfall).toBeGreaterThan(0)
  })

  it('Trip across Feb 1 carryover cap haircut still reports correct shortfall', () => {
    // Vacation balance 200, no other plans. Trip Jan 30 → Feb 3 needs 24 hrs
    // (Feb 2 is the only weekday between haircut + Feb 3 inclusive — wait:
    // Jan 30 (Fri), 31 (Sat), Feb 1 (Sun), Feb 2 (Mon), Feb 3 (Tue) →
    // 3 work days = 24 hrs. Feb 1 cap is 4.615 × 26 ≈ 120. 200 vac → cap to
    // 120 on Feb 1, then deduct 8 for Feb 2 and 8 for Feb 3 = 104 left. The
    // trip itself doesn't shortfall.
    mockToday('2026-01-15')

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-01-01',
        currentVacationHours: 200,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2026-01-09',
      },
    })

    const trip = tripFor('2026-01-30', '2026-02-03', 'vacation')
    const impact = analyzeTripImpact(state, trip, new Date('2026-03-15'))
    expect(impact.tripItselfShortfall).toBe(0)
  })

  it('earliestAffordableTripStart returns the original date for cross-year trip with mid-trip grant', () => {
    mockToday('2025-12-27')

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 24,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-26',
      },
    })

    const trip: PlannedVacation = {
      id: 'preview',
      startDate: '2025-12-29',
      endDate: '2026-01-05',
      hourSource: 'any',
      locked: false,
      kind: 'planned',
    }
    // Use a local-midnight date — `new Date('YYYY-MM-DD')` parses as UTC,
    // which can shift the day by one in non-UTC timezones.
    const start = new Date(2025, 11, 29)
    const earliest = earliestAffordableTripStart(state, trip, start)
    expect(earliest).not.toBeNull()
    if (earliest) {
      // Should NOT be pushed out — the requested date is already affordable
      // because of the Jan 1 sick grant.
      expect(format(earliest, 'yyyy-MM-dd')).toBe('2025-12-29')
    }
  })

  it('Same-year trip with insufficient hours is still flagged short (no false positives)', () => {
    mockToday('2025-06-15')

    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 8,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })

    const trip = tripFor('2025-07-07', '2025-07-11')
    const impact = analyzeTripImpact(state, trip, new Date('2025-12-31'))
    expect(impact.tripItselfShortfall).toBeGreaterThan(0)
  })
})

describe('returned balances are rounded to 2 decimals', () => {
  it('a known accrual sequence returns a clean 2-dp number (no float tail)', () => {
    // 3.076 hrs/period accumulated over many paydays produces a binary-float
    // tail (e.g. 71.53999999999999). The RETURNED balance must be rounded.
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })
    const result = projectBalance(state, new Date('2026-05-15'))

    // The returned value must equal its own 2-dp rounding — i.e. no long tail.
    for (const n of [
      result.vacationBalance,
      result.sickBalance,
      result.bankBalance,
      result.totalAvailable,
      result.carryoverAdjustment,
      result.bankPayout,
      result.shortfall,
    ]) {
      expect(n).toBe(Math.round(n * 100) / 100)
    }

    // Accrual events still carry full-precision deltas (e.g. 3.076); the raw
    // sum of them would have a long float tail. Proves rounding happens at the
    // boundary, not mid-loop: the raw accrual sum is NOT clean 2-dp, but the
    // returned balance is.
    const accruals = result.events.filter((e) => e.type === 'accrual')
    const rawAccrualSum = accruals.reduce((s, e) => s + e.delta, 0)
    expect(rawAccrualSum).not.toBe(Math.round(rawAccrualSum * 100) / 100)
    expect(result.vacationBalance).toBe(Math.round(result.vacationBalance * 100) / 100)
  })
})

describe('holiday dates + isWorkDay are civil-date-consistent regardless of runner TZ', () => {
  it('a fixed holiday (July 4) and an nth-weekday holiday (Thanksgiving) have exact ISO dates', () => {
    const h2025 = computeHolidayDates(defaultPolicy, 2025)
    // format() reads local civil fields, matching the local-midnight basis.
    const isoDates = h2025.map((d) => format(d, 'yyyy-MM-dd'))

    // July 4, 2025 is a Friday — no weekend shift, observed on the 4th.
    expect(isoDates).toContain('2025-07-04')
    // Thanksgiving = 4th Thursday of Nov 2025 = Nov 27.
    expect(isoDates).toContain('2025-11-27')
  })

  it("includes New Year's Day in its own year (regression: dropped for UTC+ users)", () => {
    // The old getUTCFullYear filter bucketed a UTC+ user's Jan 1 anchor into
    // the PREVIOUS year and dropped it. With the civil-date basis, Jan 1 is
    // present in its own year's holiday set in every timezone.
    const isoDates = computeHolidayDates(defaultPolicy, 2026).map((d) =>
      format(d, 'yyyy-MM-dd'),
    )
    // Jan 1 2026 is a Thursday — observed on the 1st (no weekend shift).
    expect(isoDates).toContain('2026-01-01')
  })

  it('isWorkDay (via countWorkDays) excludes the holiday and weekend days', () => {
    // Range: Thu Jul 3 → Wed Jul 9, 2025. Independence Day (Fri Jul 4) is a
    // holiday. Calendar: Jul 3 Thu, 4 Fri(holiday), 5 Sat, 6 Sun, 7 Mon,
    // 8 Tue, 9 Wed → work days = Jul 3, 7, 8, 9 = 4.
    const start = parseISO('2025-07-03')
    const end = parseISO('2025-07-09')

    // Expected work-day count computed independently via local getDay.
    const holidays = computeHolidayDates(defaultPolicy, 2025)
    const holidaySet = new Set(holidays.map((d) => format(d, 'yyyy-MM-dd')))
    let expected = 0
    for (let i = 0; i < 7; i++) {
      const day = addDays(parseISO('2025-07-03'), i)
      const dow = day.getDay()
      const key = format(day, 'yyyy-MM-dd')
      if (defaultPolicy.workDaysPerWeek.includes(dow) && !holidaySet.has(key)) {
        expected++
      }
    }

    expect(countWorkDays(start, end, defaultPolicy)).toBe(expected)
    expect(countWorkDays(start, end, defaultPolicy)).toBe(4)
  })
})

describe('projection does not double-add already-applied future bank entries', () => {
  it('a future bank entry with appliedToBalance true/undefined is NOT added by projection', () => {
    const base = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 10, // entry already credited into the stored balance
        lastPaydayDate: '2025-06-13',
      },
    })

    // appliedToBalance === true → already in currentBankHours, must not re-add.
    const applied = projectBalance(
      {
        ...base,
        bankHoursLog: [
          { id: 'b1', date: '2025-07-01', hours: 10, appliedToBalance: true },
        ],
      },
      new Date('2025-08-01'),
    )
    expect(applied.bankBalance).toBe(10)

    // appliedToBalance undefined (legacy entry) → treated as already applied.
    const legacy = projectBalance(
      {
        ...base,
        bankHoursLog: [{ id: 'b2', date: '2025-07-01', hours: 10 }],
      },
      new Date('2025-08-01'),
    )
    expect(legacy.bankBalance).toBe(10)

    // Sanity: an explicitly-unapplied future entry IS folded in.
    const unapplied = projectBalance(
      {
        ...base,
        profile: { ...base.profile, currentBankHours: 0 },
        bankHoursLog: [
          { id: 'b3', date: '2025-07-01', hours: 10, appliedToBalance: false },
        ],
      },
      new Date('2025-08-01'),
    )
    expect(unapplied.bankBalance).toBe(10)
  })
})

describe('tier comparison is by value, surviving a JSON round-trip', () => {
  it('a deep-cloned policy produces the same accrual as the original', () => {
    // Hire date crosses the 5-year mark mid-projection so the tier-transition
    // proration path runs. Object-identity comparison would mis-fire after a
    // clone and prorate every period.
    const base = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-06-15',
        currentVacationHours: 20,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
    })

    const cloned: AppState = {
      ...base,
      policy: JSON.parse(JSON.stringify(base.policy)),
    }

    const target = new Date('2025-12-15')
    const orig = projectBalance(base, target)
    const clone = projectBalance(cloned, target)

    expect(clone.vacationBalance).toBe(orig.vacationBalance)

    const origAccruals = orig.events.filter((e) => e.type === 'accrual')
    const cloneAccruals = clone.events.filter((e) => e.type === 'accrual')
    expect(cloneAccruals.length).toBe(origAccruals.length)
    cloneAccruals.forEach((e, i) => {
      expect(e.delta).toBeCloseTo(origAccruals[i].delta, 6)
    })

    // After the single anniversary period, all later accruals are the flat
    // 5–10yr rate (4.615) — NOT a per-period prorated value.
    const [, ...rest] = cloneAccruals
    rest.forEach((e) => expect(e.delta).toBeCloseTo(4.615, 3))
  })
})

describe('payPeriodLengthDays is clamped to >= 1 (no infinite loop)', () => {
  it('a zero pay-period length does not hang projectBalance', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 10,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
      policy: { ...defaultPolicy, payPeriodLengthDays: 0 },
    })
    // If the clamp were missing, addDays(d, 0) would never advance and this
    // would spin forever. The clamp makes it terminate.
    expect(() =>
      projectBalance(state, new Date('2025-07-15')),
    ).not.toThrow()
  })

  it('a negative pay-period length does not hang earliestAffordableDate', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 20,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-06-13',
      },
      policy: { ...defaultPolicy, payPeriodLengthDays: -5 },
    })
    expect(() =>
      earliestAffordableDate(state, 80, new Date('2025-06-15')),
    ).not.toThrow()
  })
})

describe('getEffectiveCurrentBalances — multi-day spanning entry', () => {
  it('deducts every elapsed work day of a vacation that spans today (not just one)', () => {
    // Thu Jan 8 2026. Vacation Mon Jan 5 → Fri Jan 9 spans today. Mon/Tue/Wed
    // are fully elapsed (3 work days × 8h = 24h); today (Thu) is before the
    // 16:00 work-day cutoff at the mocked noon, so it isn't charged yet. The
    // displayed balance must already reflect the 24h, not a single 8h — so it
    // doesn't silently drop by 16h on the next reopen.
    mockToday('2026-01-08')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'span',
          startDate: '2026-01-05',
          endDate: '2026-01-09',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })
    expect(getEffectiveCurrentBalances(state).vacation).toBe(16)
  })
})

describe('projectBalance — bank payout (both dates) + chronological credit', () => {
  it('pays out at both window dates and does NOT pay out hours banked after the last payout', () => {
    // Paydays from Nov 28: Dec 12, Dec 26, Jan 9, Jan 23, Feb 6, Feb 20.
    // Dec 15 → Dec 26 payout; Feb 15 → Feb 20 payout. A +20 bank entry lands
    // Feb 25 (AFTER both payouts). Folding it in up-front would let the Dec
    // payout pay out hours not yet banked; chronologically it survives.
    mockToday('2025-12-01')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 12,
        lastPaydayDate: '2025-11-28',
        timezone: 'America/New_York',
      },
      bankHoursLog: [
        { id: 'late', date: '2026-02-25', hours: 20, appliedToBalance: false },
      ],
    })
    const result = projectBalance(state, parseISO('2026-03-01'))
    // Dec 26 pays out the starting 12; Feb 20 pays out 0; the +20 banked Feb 25
    // survives because both payouts have already fired.
    expect(result.bankPayout).toBe(12)
    expect(result.bankBalance).toBe(20)
  })
})
