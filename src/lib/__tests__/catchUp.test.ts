import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { catchUpState, summarizeCatchUp } from '../catchUp'
import { projectBalance } from '../projection'
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

  it('zeros bank hours when crossing the bank payout payday', () => {
    // lastPayday Dec 12 (Fri), biweekly → next payday after the Dec 15 window
    // open is Dec 26, so the payout lands Dec 26. today is past it.
    mockToday('2025-12-27')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 12,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2025-12-14', // before the Dec 26 payout payday
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const payouts = result.events.filter((e) => e.type === 'bank_payout')
    expect(payouts.length).toBeGreaterThan(0)
    expect(result.state.profile.currentBankHours).toBe(0)
  })

  it('bank payout fires at BOTH the window-open and window-close paydays; hours banked between them are paid out, not lost', () => {
    // Window Dec 15 → Feb 15. lastPayday Dec 12 → payout paydays Dec 26 (after
    // Dec 15) and Feb 20 (after Feb 15). lastSync Dec 14 2025, today Mar 1 2026
    // — both payouts are in the catch-up gap. Bank starts at 12. An unapplied
    // bank-log entry of +20 lands Jan 10 2026 (between the two payouts).
    // Policy: pay out Dec → bank refills → pay out again Feb → zero. So the Dec
    // payout zeroes the starting 12, the +20 banks Jan 10, and the Feb payout
    // zeroes that 20. The +20 is paid out, never silently lost.
    mockToday('2026-03-01')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 12,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2025-12-14',
        timezone: 'America/New_York',
      },
      bankHoursLog: [
        { id: 'mid', date: '2026-01-10', hours: 20, appliedToBalance: false },
      ],
    })
    const result = catchUpState(state)
    const payouts = result.events.filter((e) => e.type === 'bank_payout' && e.delta < 0)
    // Two zeroing payouts — Dec 26 (the starting 12) and Feb 20 (the 20 banked
    // mid-window).
    expect(payouts).toHaveLength(2)
    expect(payouts.map((p) => p.date)).toEqual(['2025-12-26', '2026-02-20'])
    expect(payouts.map((p) => p.delta)).toEqual([-12, -20])
    // Both payouts fired, so the bank ends empty.
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

  it('records actualHoursUsed as the SPAN TOTAL, equal to the sum of debitedFrom (multi-day)', () => {
    // Regression for the multi-day adjust corruption: catch-up must store the
    // entry total (40 across 5 days), not a per-day figure, and that total must
    // match the recorded per-pool draw so a later adjust/refund is exact.
    mockToday('2026-01-12')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 100,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2026-01-04',
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
    const updated = catchUpState(state).state.plannedVacations.find(
      (v) => v.id === 'span',
    )
    expect(updated?.actualHoursUsed).toBe(40)
    const d = updated?.debitedFrom
    expect(d).toBeDefined()
    const sum = (d!.vacation ?? 0) + (d!.sick ?? 0) + (d!.bank ?? 0)
    expect(sum).toBe(updated?.actualHoursUsed)
  })

  it('does not double-debit a day already covered by a logged_past entry', () => {
    // A planned entry that overlaps an already-logged_past day must skip that
    // day when it elapses, so the day is debited exactly once.
    mockToday('2026-01-12')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 100,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2026-01-04',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'logged',
          startDate: '2026-01-06',
          endDate: '2026-01-06',
          hourSource: 'vacation',
          locked: false,
          kind: 'logged_past',
          actualHoursUsed: 8,
          debitedFrom: { vacation: 8, sick: 0, bank: 0 },
        },
        {
          id: 'planned',
          startDate: '2026-01-05',
          endDate: '2026-01-07',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })
    const result = catchUpState(state)
    // The planned entry spans Jan 5-7 (3 work days) but Jan 6 is already
    // logged, so only Jan 5 and Jan 7 are debited by it.
    const plannedDeductions = result.events.filter(
      (e) => e.type === 'vacation_deduction' && e.date !== '2026-01-06',
    )
    const jan6 = result.events.filter(
      (e) => e.type === 'vacation_deduction' && e.date === '2026-01-06',
    )
    expect(plannedDeductions).toHaveLength(2)
    expect(jan6).toHaveLength(0)
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

  it('records debitedFrom per-pool on a converted any-source entry that drained bank', () => {
    // A single past work-day vacation (Mon Jan 5, 2026), source 'any', funded
    // entirely from bank (bank=20, vacation/sick=0). 'any' drains bank first,
    // so the whole 8 hrs come from bank. After conversion to logged_past the
    // entry must record debitedFrom = {vacation:0, sick:0, bank:8}.
    mockToday('2026-01-07')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 20,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2026-01-04',
        timezone: 'America/New_York',
      },
      plannedVacations: [
        {
          id: 'bank-drain',
          startDate: '2026-01-05',
          endDate: '2026-01-05',
          hourSource: 'any',
          locked: false,
          kind: 'planned',
        },
      ],
    })
    const result = catchUpState(state)
    const updated = result.state.plannedVacations.find(
      (v) => v.id === 'bank-drain',
    )
    expect(updated?.kind).toBe('logged_past')
    expect(updated?.debitedFrom).toEqual({ vacation: 0, sick: 0, bank: 8 })
    // Bank should have dropped by exactly the recorded amount.
    expect(result.state.profile.currentBankHours).toBe(12)
  })

  it('written-back balances are rounded to 2 decimals (no float tail)', () => {
    // Several biweekly accruals of 3.076 produce a binary-float tail; the
    // balance written into the profile must be cleanly 2-dp rounded.
    mockToday('2026-03-13')
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2023-01-01',
        currentVacationHours: 40,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2025-12-12',
        lastSyncDate: '2025-12-12',
        timezone: 'America/New_York',
      },
    })
    const result = catchUpState(state)
    const v = result.state.profile.currentVacationHours
    expect(v).toBe(Math.round(v * 100) / 100)
    const s = result.state.profile.currentSickHours
    expect(s).toBe(Math.round(s * 100) / 100)
    const b = result.state.profile.currentBankHours
    expect(b).toBe(Math.round(b * 100) / 100)
  })

  it('catch-up and projection agree on a payday period straddling a service anniversary', () => {
    // Hire 2020-06-15. The pay period 2025-06-13 → 2025-06-27 straddles the
    // 5-year anniversary (Jun 15), so that payday's accrual is PRO-RATED:
    // ~2 days at the 2–5yr rate (3.076) + ~12 days at the 6–10yr rate (4.615).
    // Before this fix, catch-up applied the full new-tier rate as a cliff and
    // diverged from the projection by a fraction of an hour. Both engines must
    // now produce the SAME vacation balance for the same single period.
    const baseProfile = {
      displayName: 'Test User',
      hireDate: '2020-06-15',
      currentVacationHours: 20,
      currentSickHours: 0,
      currentBankHours: 0,
      lastPaydayDate: '2025-06-13',
      timezone: 'America/New_York',
    }

    // Projection: "today" Jun 15 2025 → the Jun 27 payday is in the future and
    // is the only accrual before the target (Jun 28). periodStart = lastPayday
    // = Jun 13.
    mockToday('2025-06-15')
    const projState = makeState({ profile: { ...baseProfile } })
    const proj = projectBalance(projState, new Date('2025-06-28'))
    const projAccruals = proj.events.filter((e) => e.type === 'accrual')
    expect(projAccruals).toHaveLength(1)

    // Catch-up: lastSync = lastPayday (Jun 13), "today" Jun 28 → the only
    // payday in the gap is Jun 27, periodStart = Jun 27 - 14 = Jun 13. Same
    // period as the projection.
    mockToday('2025-06-28')
    const cuState = makeState({
      profile: { ...baseProfile, lastSyncDate: '2025-06-13' },
    })
    const cu = catchUpState(cuState)
    const cuAccruals = cu.events.filter((e) => e.type === 'accrual')
    expect(cuAccruals).toHaveLength(1)

    // The single prorated accrual delta must match to full precision...
    expect(cuAccruals[0].delta).toBeCloseTo(projAccruals[0].delta, 10)
    // ...and it must be a PRORATED value, strictly between the two tier rates
    // (proving neither side took the cliff shortcut).
    expect(cuAccruals[0].delta).toBeGreaterThan(3.076)
    expect(cuAccruals[0].delta).toBeLessThan(4.615)

    // And the resulting persisted/projected vacation balances are equal after
    // the 2-dp rounding both engines apply at the boundary.
    expect(cu.state.profile.currentVacationHours).toBe(proj.vacationBalance)
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
