import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addDays, format, subYears, previousFriday } from 'date-fns'
import {
  analyzeTripImpact,
  computeAccrualTier,
  earliestAffordableDate,
  earliestAffordableTripStart,
  getEffectiveCurrentBalances,
  projectBalance,
} from '../projection'
import { computeHolidayDates } from '../holidays'
import { defaultPolicy } from '../defaultPolicy'
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

    // First payday after today (Jun 15) is Jun 27. By then yos = 5, so all
    // accruals should be at the 5–10 year tier (4.615 hrs/pp).
    expect(accrualEvents.length).toBeGreaterThan(0)
    accrualEvents.forEach((e) => {
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
    expect(carryoverEvents[0].date).toBe('2026-02-01')
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
