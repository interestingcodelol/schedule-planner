import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { catchUpState, summarizeCatchUp } from '../catchUp'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    profile: {
      displayName: 'Test User',
      hireDate: '2023-01-01',
      currentVacationHours: 40,
      currentSickHours: 20,
      currentBankHours: 0,
      lastPaydayDate: '2025-12-12', // Friday
      lastSyncDate: '2025-12-12',
      timezone: 'America/New_York',
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

function mockToday(iso: string) {
  vi.useFakeTimers()
  // Pick a time well past the EOD cutoff so timezone wobble doesn't move us
  // across a day boundary.
  vi.setSystemTime(new Date(`${iso}T15:00:00Z`))
}

beforeEach(() => {
  mockToday('2025-12-12')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('catchUpState', () => {
  it('is a no-op when today equals lastSyncDate', () => {
    const state = makeState()
    const result = catchUpState(state)
    expect(result.applied).toBe(false)
    expect(result.events).toHaveLength(0)
    expect(result.state.profile.currentVacationHours).toBe(40)
  })

  it('applies missed paydays between lastSync and today', () => {
    // lastSync Dec 12, today Jan 9 — biweekly pays Dec 26 and Jan 9 (2 paydays).
    mockToday('2026-01-09')
    const state = makeState()
    const result = catchUpState(state)
    const accruals = result.events.filter((e) => e.type === 'accrual')
    expect(accruals).toHaveLength(2)
    accruals.forEach((e) => {
      // 2-5yr tier is 3.076 hrs/period.
      expect(e.delta).toBeCloseTo(3.076, 2)
    })
    // Vacation: 40 + 2 * 3.076 = 46.152
    expect(result.state.profile.currentVacationHours).toBeCloseTo(46.152, 2)
    expect(result.state.profile.lastSyncDate).toBe('2026-01-09')
    expect(result.state.profile.lastPaydayDate).toBe('2026-01-09')
  })

  it('applies the Jan 1 sick grant with carryover-cap forfeiture', () => {
    mockToday('2026-01-02')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 60, // above the 40 carryover cap
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2025-12-31',
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const forfeit = result.events.find(
      (e) => e.type === 'sick_carryover_forfeit',
    )
    const grant = result.events.find((e) => e.type === 'sick_grant')
    expect(forfeit).toBeDefined()
    expect(forfeit?.delta).toBeCloseTo(-20, 2) // 60 → cap 40, lose 20
    expect(grant).toBeDefined()
    // After the haircut sick = 40, then +40 grant capped at maxBalance 80.
    expect(result.state.profile.currentSickHours).toBeCloseTo(80, 2)
  })

  it('caps vacation on the carryover payout date', () => {
    // First payday on/after Feb 1 2026 anchored on a 2025-12-12 lastPayday
    // is Feb 6 2026 (biweekly).
    mockToday('2026-02-07')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-01-01', // 5+ yrs → 4.615 hrs/period; cap 4.615 * 26 ≈ 120
        currentVacationHours: 200,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2026-01-31',
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const payouts = result.events.filter((e) => e.type === 'carryover_payout')
    expect(payouts).toHaveLength(1)
    expect(payouts[0].date).toBe('2026-02-06')
    // Cap = 4.615 * 26 = 119.99 ≈ 120; 200 → ~120.
    expect(result.state.profile.currentVacationHours).toBeCloseTo(119.99, 1)
  })

  it('zeros bank hours when crossing the bank payout window', () => {
    mockToday('2025-12-16')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 12,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2025-12-14', // before the Dec 15 payout
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const payouts = result.events.filter((e) => e.type === 'bank_payout')
    expect(payouts.length).toBeGreaterThan(0)
    expect(result.state.profile.currentBankHours).toBe(0)
  })

  it('deducts a fully-past planned vacation and marks it logged_past', () => {
    // Jan 5-9 2026 — Mon-Fri, 5 work days × 8 hrs = 40 hrs.
    mockToday('2026-01-12')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 100,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2026-01-04',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'past-1',
          startDate: '2026-01-05',
          endDate: '2026-01-09',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })
    const result = catchUpState(state)
    const deductions = result.events.filter(
      (e) => e.type === 'vacation_deduction',
    )
    expect(deductions).toHaveLength(5)
    // 100 - 40 + accruals (Dec 26, Jan 9 — wait Jan 9 is after the vacation
    // and on the last day, but vacation deductions happen at order=2 and
    // accrual at order=1 on the same day, so the Jan 9 accrual fires before
    // the Jan 9 deduction). End of vacation = 100 + accruals - 40.
    expect(result.state.profile.currentVacationHours).toBeLessThan(100)
    const updated = result.state.plannedVacations.find((v) => v.id === 'past-1')
    expect(updated?.kind).toBe('logged_past')
    expect(updated?.actualHoursUsed).toBe(40)
  })

  it('leaves an active vacation alone (endDate >= today)', () => {
    // Vacation runs through today — should not be processed.
    mockToday('2026-01-07')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 100,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2026-01-04',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'active-1',
          startDate: '2026-01-05',
          endDate: '2026-01-09',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })
    const result = catchUpState(state)
    const deductions = result.events.filter(
      (e) => e.type === 'vacation_deduction',
    )
    expect(deductions).toHaveLength(0)
    const updated = result.state.plannedVacations.find((v) => v.id === 'active-1')
    expect(updated?.kind).toBe('planned')
  })

  it('is idempotent — running twice with the same now does nothing', () => {
    mockToday('2026-01-09')
    const state = makeState()
    const first = catchUpState(state)
    const second = catchUpState(first.state)
    expect(second.applied).toBe(false)
    expect(second.events).toHaveLength(0)
    expect(second.state.profile.currentVacationHours).toBeCloseTo(
      first.state.profile.currentVacationHours,
      6,
    )
  })

  it('processes a multi-month gap correctly (paydays + Jan 1 grant + Feb cap)', () => {
    mockToday('2026-02-09')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-01-01', // 5+yr tier
        currentVacationHours: 50,
        currentSickHours: 30,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2025-12-12',
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const types = new Set(result.events.map((e) => e.type))
    expect(types.has('accrual')).toBe(true)
    expect(types.has('sick_grant')).toBe(true)
    expect(result.state.profile.lastSyncDate).toBe('2026-02-09')
  })

  it('falls back to lastPaydayDate when lastSyncDate is missing', () => {
    mockToday('2026-01-09')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const accruals = result.events.filter((e) => e.type === 'accrual')
    expect(accruals).toHaveLength(2)
  })
})

describe('summarizeCatchUp', () => {
  it('returns "Up to date" for an empty event list', () => {
    expect(summarizeCatchUp([])).toBe('Up to date')
  })

  it('summarizes vacation, sick, and bank deltas', () => {
    const result = summarizeCatchUp([
      { date: '2026-01-09', type: 'accrual', pool: 'vacation', delta: 3.076, label: 'a' },
      { date: '2026-01-01', type: 'sick_grant', pool: 'sick', delta: 40, label: 'b' },
      { date: '2025-12-15', type: 'bank_payout', pool: 'bank', delta: -10, label: 'c' },
    ])
    expect(result).toMatch(/3 events/)
    expect(result).toMatch(/vac/)
    expect(result).toMatch(/sick/)
    expect(result).toMatch(/bank/)
  })
})
