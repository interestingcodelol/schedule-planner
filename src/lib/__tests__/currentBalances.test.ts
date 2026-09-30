import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseISO } from 'date-fns'
import { applyBreakdownRefund } from '../balances'
import { catchUpState } from '../catchUp'
import { defaultPolicy } from '../defaultPolicy'
import { countWorkDays, getCurrentBalanceSummary, getEffectiveCurrentBalances, projectBalance } from '../projection'
import type { AppState, PlannedVacation } from '../types'

function entry(overrides: Partial<PlannedVacation> = {}): PlannedVacation {
  return {
    id: 'today', startDate: '2026-06-16', endDate: '2026-06-16',
    hourSource: 'vacation', kind: 'planned', locked: false, ...overrides,
  }
}

function makeState(entries: PlannedVacation[] = [entry()]): AppState {
  return {
    profile: {
      displayName: 'Test', hireDate: '2023-01-01', currentVacationHours: 40,
      currentSickHours: 20, currentBankHours: 0, lastPaydayDate: '2026-06-12',
      lastSyncDate: '2026-06-15', timezone: 'America/New_York',
    },
    policy: { ...defaultPolicy }, plannedVacations: entries, bankHoursLog: [],
    theme: 'dark', showTour: false, version: 1,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-16T04:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('available-now balance reconciliation', () => {
  it.each(['2026-06-16T04:00:00Z', '2026-06-16T12:00:00Z', '2026-06-17T03:59:00Z'])(
    'deducts at midnight, morning and late evening: %s', (now) => {
      vi.setSystemTime(new Date(now))
      const state = makeState([entry({ timeOffStart: '15:00', timeOffEnd: '19:00', hoursPerDay: 4 })])
      expect(getEffectiveCurrentBalances(state).vacation).toBe(36)
      expect(projectBalance(state, parseISO('2026-06-16')).vacationBalance).toBe(36)
      expect(projectBalance(state, parseISO('2026-06-17')).vacationBalance).toBe(36)
    },
  )

  it('waits until the date arrives in the profile timezone, even when UTC has rolled over', () => {
    const state = makeState()
    vi.setSystemTime(new Date('2026-06-16T03:59:59Z'))
    expect(getEffectiveCurrentBalances(state).vacation).toBe(40)
    vi.setSystemTime(new Date('2026-06-16T04:00:00Z'))
    expect(getEffectiveCurrentBalances(state).vacation).toBe(32)
    state.profile.timezone = 'Pacific/Auckland'
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    expect(getEffectiveCurrentBalances(state).vacation).toBe(32)
  })

  it.each([
    ['2026-03-08', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z'],
    ['2026-11-01', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
  ])('deducts once across the DST transition on %s', (date, before, after) => {
    const state = makeState([entry({ startDate: date, endDate: date })])
    state.policy = { ...state.policy, workDaysPerWeek: [0, 1, 2, 3, 4, 5, 6], holidays: [] }
    for (const now of [before, after]) {
      vi.setSystemTime(new Date(now))
      expect(getEffectiveCurrentBalances(state).vacation).toBe(32)
      expect(getCurrentBalanceSummary(state).todayDeductions.total).toBe(8)
    }
    expect(state.profile.currentVacationHours).toBe(40)
  })

  it('shows the actual Auto draw from each pool and never mutates saved balances', () => {
    const state = makeState([entry({ hourSource: 'any' })])
    state.profile.currentVacationHours = 3
    state.profile.currentBankHours = 2
    const before = structuredClone(state)
    const summary = getCurrentBalanceSummary(state)
    expect(summary.stored).toEqual({ vacation: 3, sick: 20, bank: 2, total: 25 })
    expect(summary.deductions).toEqual({ vacation: 3, sick: 3, bank: 2, total: 8 })
    expect(summary.available).toEqual({ vacation: 0, sick: 17, bank: 0, total: 17 })
    expect(summary.todayDeductions).toEqual(summary.deductions)
    expect(summary.shortfall).toBe(0)
    expect(state).toEqual(before)
  })

  it('keeps today-only affordability honest when the selected pool cannot cover today', () => {
    const state = makeState()
    state.profile.currentVacationHours = 3
    const summary = getCurrentBalanceSummary(state)
    expect(summary.deductions.vacation).toBe(3)
    expect(summary.shortfall).toBe(5)
    expect(summary.available.sick).toBe(20)
    expect(projectBalance(state, parseISO('2026-06-16')).shortfall).toBe(5)
    expect(projectBalance(state, parseISO('2026-06-17')).shortfall).toBe(5)
  })

  it('does not erase an already-negative recorded pool when scheduled PTO cannot draw it', () => {
    const state = makeState()
    state.profile.currentVacationHours = -4
    const summary = getCurrentBalanceSummary(state)
    expect(summary.available.vacation).toBe(-4)
    expect(summary.deductions.vacation).toBe(0)
    expect(summary.shortfall).toBe(8)
    expect(projectBalance(state, parseISO('2026-06-17')).vacationBalance).toBe(-4)
    const booked = catchUpState(state).state
    expect(booked.profile.currentVacationHours).toBe(-4)
    expect(booked.plannedVacations[0].debitedFrom?.vacation).toBe(0)
  })

  it('recalculates edits, source changes, moving dates and deletion without a second debit', () => {
    const state = makeState()
    expect(getEffectiveCurrentBalances(state).vacation).toBe(32)
    state.plannedVacations[0].hoursPerDay = 3.25
    expect(getEffectiveCurrentBalances(state).vacation).toBe(36.75)
    state.plannedVacations[0].hourSource = 'sick'
    expect(getEffectiveCurrentBalances(state)).toEqual({ vacation: 40, sick: 16.75, bank: 0, total: 56.75 })
    state.plannedVacations[0].startDate = '2026-06-17'
    state.plannedVacations[0].endDate = '2026-06-17'
    expect(getEffectiveCurrentBalances(state).total).toBe(60)
    state.plannedVacations = []
    expect(getEffectiveCurrentBalances(state).total).toBe(60)
    expect(state.profile.currentVacationHours).toBe(40)
  })

  it('orders different-source scheduled entries by day, matching the projection', () => {
    vi.setSystemTime(new Date('2026-06-17T12:00:00Z'))
    const state = makeState([
      entry({ id: 'later', startDate: '2026-06-17', endDate: '2026-06-17', hourSource: 'bank', hoursPerDay: 4 }),
      entry({ id: 'earlier', hourSource: 'any' }),
    ])
    Object.assign(state.profile, { currentVacationHours: 4, currentBankHours: 4, currentSickHours: 4 })
    const summary = getCurrentBalanceSummary(state)
    expect(summary.available).toEqual({ vacation: 0, sick: 4, bank: 0, total: 4 })
    expect(summary.shortfall).toBe(4)
    const projected = projectBalance(state, parseISO('2026-06-18'))
    expect(projected.totalAvailable).toBe(summary.available.total)
    expect(projected.shortfall).toBe(summary.shortfall)
  })

  it('counts a logged-today absence in the explanation without deducting it again', () => {
    const state = makeState([
      entry({ id: 'scheduled', hourSource: 'sick' }),
      entry({ id: 'logged', kind: 'logged_past', hourSource: 'sick', actualHoursUsed: 4,
        debitedFrom: { vacation: 0, sick: 4, bank: 0 } }),
    ])
    state.profile.currentSickHours = 16
    const summary = getCurrentBalanceSummary(state)
    expect(summary.available.sick).toBe(16)
    expect(summary.deductions.total).toBe(0)
    expect(summary.todayScheduledDeductions.total).toBe(0)
    expect(summary.todayLoggedDeductions.sick).toBe(4)
    expect(summary.todayDeductions.total).toBe(4)
    expect(projectBalance(state, parseISO('2026-06-17')).sickBalance).toBe(16)
    const booked = catchUpState(state, new Date('2026-06-17T12:00:00Z')).state
    expect(booked.profile.currentSickHours).toBe(16)
    expect(booked.plannedVacations[0].kind).toBe('logged_past')
    expect(booked.plannedVacations[0].debitedFrom).toEqual({ vacation: 0, sick: 0, bank: 0 })
  })

  it('reports legacy Auto usage without inventing an unavailable pool split', () => {
    const state = makeState([entry({ kind: 'logged_past', hourSource: 'any', actualHoursUsed: 4 })])
    state.profile.currentVacationHours = 36
    const summary = getCurrentBalanceSummary(state)
    expect(summary.todayUnallocatedHours).toBe(4)
    expect(summary.todayDeductions.total).toBe(0)
    expect(summary.deductions.total).toBe(0)
    expect(summary.available.vacation).toBe(36)
  })

  it('returns exact same-day allocation metadata for an unsaved planning preview', () => {
    const state = makeState([entry({ hourSource: 'any', hoursPerDay: 6 })])
    state.profile.currentBankHours = 2
    state.profile.currentVacationHours = 3
    const result = projectBalance(state, parseISO('2026-06-16'))
    expect(result.events).toContainEqual(expect.objectContaining({
      date: '2026-06-16', vacationId: 'today', requestedHours: 6,
      drawn: { bank: 2, vacation: 3, sick: 1 },
    }))
    expect(state.profile.currentBankHours).toBe(2)
  })

  it('spreads actual entry totals across all workdays and skips already-logged days consistently', () => {
    const state = makeState([
      entry({ id: 'span', startDate: '2026-06-15', endDate: '2026-06-17', actualHoursUsed: 12 }),
      entry({ id: 'logged', startDate: '2026-06-15', endDate: '2026-06-15', kind: 'logged_past',
        actualHoursUsed: 4, debitedFrom: { vacation: 4, sick: 0, bank: 0 } }),
    ])
    state.profile.currentVacationHours = 36
    expect(getEffectiveCurrentBalances(state).vacation).toBe(32)
    expect(getCurrentBalanceSummary(state).todayDeductions.total).toBe(4)
    expect(projectBalance(state, parseISO('2026-06-18')).vacationBalance).toBe(28)
    const booked = catchUpState(state, new Date('2026-06-18T12:00:00Z')).state
    expect(booked.profile.currentVacationHours).toBe(28)
    expect(booked.plannedVacations[0].actualHoursUsed).toBe(8)
    expect(booked.plannedVacations[0].debitedFrom?.vacation).toBe(8)
  })

  it('settles a spanning trip once, then refunds the same pools when its logged entry is deleted', () => {
    const state = makeState([entry({ startDate: '2026-06-15', endDate: '2026-06-17', hourSource: 'any', hoursPerDay: 3 })])
    state.profile.currentBankHours = 5
    expect(getCurrentBalanceSummary(state).deductions.total).toBe(6)
    expect(getCurrentBalanceSummary(state).todayDeductions).toEqual({ vacation: 1, sick: 0, bank: 2, total: 3 })
    const booked = catchUpState(state, new Date('2026-06-18T12:00:00Z')).state
    vi.setSystemTime(new Date('2026-06-18T12:00:00Z'))
    expect(booked.profile.currentVacationHours).toBe(36)
    expect(booked.profile.currentBankHours).toBe(0)
    expect(getCurrentBalanceSummary(booked).deductions.total).toBe(0)
    expect(catchUpState(booked).applied).toBe(false)
    const refunded = applyBreakdownRefund(booked, booked.plannedVacations[0].debitedFrom!)
    expect(refunded).toEqual({ vacation: 40, sick: 20, bank: 5 })
  })

  it('skips weekends, observed holidays and holidays from an earlier year of an active span', () => {
    vi.setSystemTime(new Date('2026-01-02T15:00:00Z'))
    const state = makeState([entry({ startDate: '2025-12-24', endDate: '2026-01-05', hoursPerDay: 2 })])
    state.profile.lastPaydayDate = '2026-01-02'
    const throughToday = countWorkDays(parseISO('2025-12-24'), parseISO('2026-01-02'), state.policy)
    expect(throughToday).toBe(5) // Christmas Eve, Christmas and Jan 1 excluded
    expect(getCurrentBalanceSummary(state).deductions.total).toBe(10)
    const throughEnd = countWorkDays(parseISO('2025-12-24'), parseISO('2026-01-05'), state.policy)
    expect(projectBalance(state, parseISO('2026-01-05')).vacationBalance).toBe(40 - throughEnd * 2)
  })

  it('counts holidays in intervening years when prorating a long entry', () => {
    const policy = { ...defaultPolicy, workDaysPerWeek: [0, 1, 2, 3, 4, 5, 6], holidays: [
      { type: 'fixed' as const, month: 1, day: 1, name: 'New Year', weekendObservance: 'none' as const },
    ] }
    expect(countWorkDays(parseISO('2025-12-31'), parseISO('2027-01-02'), policy)).toBe(366)
  })
})
