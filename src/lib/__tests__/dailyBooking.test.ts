import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseISO } from 'date-fns'
import { catchUpState } from '../catchUp'
import { defaultPolicy } from '../defaultPolicy'
import { migrateState } from '../migrate'
import { getCurrentBalanceSummary, projectBalance } from '../projection'
import type { AppState, PlannedVacation } from '../types'

const now = (date: string) => new Date(`${date}T16:00:00Z`)
const trip = (updates: Partial<PlannedVacation> = {}): PlannedVacation => ({
  id: 'trip', startDate: '2026-06-15', endDate: '2026-06-17',
  kind: 'planned', hourSource: 'any', locked: false, ...updates,
})
function initial(entries: PlannedVacation[] = [trip()]): AppState {
  return {
    profile: {
      displayName: 'Test', hireDate: '2023-01-01', currentVacationHours: 40,
      currentSickHours: 0, currentBankHours: 8, lastPaydayDate: '2026-06-02',
      lastSyncDate: '2026-06-14', timezone: 'America/New_York',
    },
    policy: { ...defaultPolicy, bankHoursPayoutStart: { month: 6, day: 16 } },
    plannedVacations: entries, bankHoursLog: [], theme: 'dark', showTour: false, version: 1,
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now('2026-06-14')) })
afterEach(() => vi.useRealTimers())

function book(state: AppState, date: string): AppState {
  vi.setSystemTime(now(date))
  return catchUpState(state).state
}

function expectBalancesEqual(a: AppState, b: AppState) {
  expect(a.profile.currentVacationHours).toBeCloseTo(b.profile.currentVacationHours, 2)
  expect(a.profile.currentSickHours).toBeCloseTo(b.profile.currentSickHours, 2)
  expect(a.profile.currentBankHours).toBeCloseTo(b.profile.currentBankHours, 2)
}

describe('per-day scheduled PTO booking', () => {
  it('keeps a trip spanning a payday and bank payout identical across reopen schedules', () => {
    const original = initial()
    const expected = projectBalance(original, parseISO('2026-06-18'))
    expect(expected.vacationBalance).toBe(27.08)
    const oneSession = book(original, '2026-06-18')
    let reopened = book(original, '2026-06-16')
    expect(reopened.profile.currentBankHours).toBe(0)
    expect(reopened.profile.currentVacationHours).toBe(35.08)
    expect(reopened.plannedVacations[0].kind).toBe('planned')
    expect(reopened.plannedVacations[0].debitedFrom).toEqual({ vacation: 8, sick: 0, bank: 8 })
    expect(getCurrentBalanceSummary(reopened).deductions.total).toBe(0)
    expect(projectBalance(reopened, parseISO('2026-06-18')).vacationBalance).toBe(27.08)
    reopened = book(reopened, '2026-06-18')
    expectBalancesEqual(reopened, oneSession)
    expect(reopened.profile.currentVacationHours).toBe(expected.vacationBalance)
    expect(reopened.plannedVacations[0].kind).toBe('logged_past')
    expect(reopened.plannedVacations[0].actualHoursUsed).toBe(24)
    expect(reopened.plannedVacations[0].debitedFrom).toEqual({ vacation: 16, sick: 0, bank: 8 })
    expect(catchUpState(reopened).events).toEqual([])
  })

  it('does not let a later payday fund an already-applied day that had a shortfall', () => {
    const original = initial([trip({ hourSource: 'vacation', hoursPerDay: 4 })])
    Object.assign(original.profile, { currentVacationHours: 0, currentBankHours: 0 })
    const oneSession = book(original, '2026-06-17')
    let reopened = book(original, '2026-06-15')
    expect(reopened.plannedVacations[0].appliedDeductions?.[0]).toEqual({
      date: '2026-06-15', hours: 4, drawn: { vacation: 0, sick: 0, bank: 0 },
    })
    expect(getCurrentBalanceSummary(reopened).shortfall).toBe(4)
    reopened = book(reopened, '2026-06-17')
    expectBalancesEqual(reopened, oneSession)
    expect(reopened.plannedVacations[0].appliedDeductions).toEqual(oneSession.plannedVacations[0].appliedDeductions)
    expect(getCurrentBalanceSummary(reopened).shortfall).toBeCloseTo(12 - 3.076, 2)
  })

  it('books a new same-day plan after sync without replaying accruals or payouts', () => {
    const original = initial([])
    const synced = book(original, '2026-06-16')
    expect(synced.profile.currentVacationHours).toBe(43.08)
    const added: AppState = { ...synced, plannedVacations: [trip({ startDate: '2026-06-16', endDate: '2026-06-16' })] }
    const booked = catchUpState(added)
    expect(booked.state.profile.currentVacationHours).toBe(35.08)
    expect(booked.events.map((e) => e.type)).toEqual(['vacation_deduction'])
    expect(catchUpState(booked.state).events).toEqual([])
  })

  it('exposes future allocation after same-day accrual and before the bank payout', () => {
    const original = initial([trip({ startDate: '2026-06-16', endDate: '2026-06-16' })])
    original.profile.currentVacationHours = 1
    original.profile.currentBankHours = 2
    const projection = projectBalance(original, parseISO('2026-06-16'))
    expect(projection.events).toContainEqual(expect.objectContaining({
      date: '2026-06-16', vacationId: 'trip', requestedHours: 8,
      drawn: expect.objectContaining({ bank: 2, sick: 0 }),
    }))
    expect(projection.events.find((e) => e.vacationId === 'trip')?.drawn?.vacation).toBeCloseTo(4.076, 8)
    expect(projection.shortfall).toBe(1.92)
    expect(projection.bankPayout).toBe(0)
  })

  it('preserves carryover payout ordering when syncing during a trip', () => {
    const original = initial([trip({ hourSource: 'vacation' })])
    original.profile.currentVacationHours = 160
    original.profile.currentBankHours = 0
    original.policy = { ...original.policy, carryoverCapStrategy: 'fixed_hours', carryoverFixedCap: 80,
      carryoverPayoutDate: { month: 6, day: 16 } }
    const expected = projectBalance(original, parseISO('2026-06-18'))
    const once = book(original, '2026-06-18')
    const split = book(book(original, '2026-06-16'), '2026-06-18')
    expectBalancesEqual(split, once)
    expect(split.profile.currentVacationHours).toBeCloseTo(expected.vacationBalance, 2)
  })

  it('preserves Jan 1 sick cap/grant ordering across a spanning trip and reload', () => {
    const original = initial([trip({ startDate: '2025-12-30', endDate: '2026-01-02', hourSource: 'sick' })])
    Object.assign(original.profile, { currentVacationHours: 0, currentBankHours: 0, currentSickHours: 48,
      lastPaydayDate: '2025-12-26', lastSyncDate: '2025-12-29' })
    original.policy = { ...original.policy, holidays: [], sickLeaveCarryoverCap: 40, sickLeaveAnnualGrant: 40 }
    vi.setSystemTime(now('2025-12-29'))
    const expected = projectBalance(original, parseISO('2026-01-03'))
    const once = book(original, '2026-01-03')
    const split = book(book(original, '2025-12-31'), '2026-01-03')
    expectBalancesEqual(split, once)
    expect(split.profile.currentSickHours).toBe(expected.sickBalance)
    expect(split.profile.currentSickHours).toBe(56)
  })

  it('retains exact per-day pool attribution for today after booking', () => {
    const original = initial([trip({ hoursPerDay: 3 })])
    original.profile.currentBankHours = 5
    const booked = book(original, '2026-06-16')
    const summary = getCurrentBalanceSummary(booked)
    expect(summary.todayScheduledDeductions.total).toBe(0)
    expect(summary.todayLoggedDeductions).toEqual({ vacation: 1, sick: 0, bank: 2, total: 3 })
    expect(summary.todayDeductions.total).toBe(3)
    expect(summary.available.total).toBe(summary.stored.total)
  })

  it('stores depleted fractional accrual draws at the same precision as profile balances', () => {
    const original = initial([trip({ startDate: '2026-06-16', endDate: '2026-06-16', hourSource: 'vacation' })])
    original.profile.currentVacationHours = 1
    original.profile.currentBankHours = 0
    const booked = book(original, '2026-06-16')
    expect(booked.plannedVacations[0].debitedFrom?.vacation).toBe(4.08)
    expect(booked.plannedVacations[0].appliedDeductions?.[0].drawn.vacation).toBe(4.08)
    expect(booked.profile.currentVacationHours).toBe(0)
  })

  it('allocates fractional entry totals without drift across daily sessions', () => {
    const original = initial([trip({ hourSource: 'vacation', actualHoursUsed: 1 })])
    original.profile.lastPaydayDate = '2026-06-12'
    original.profile.currentBankHours = 0
    const once = book(original, '2026-06-18')
    let daily = original
    for (const date of ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18']) daily = book(daily, date)
    expectBalancesEqual(daily, once)
    expect(daily.profile.currentVacationHours).toBe(39)
    expect(daily.plannedVacations[0].appliedDeductions?.map((d) => d.hours)).toEqual([0.33, 0.34, 0.33])
  })
})

describe('daily booking migration safety', () => {
  it('does not assume legacy planned days were already deducted; logged days stay booked', () => {
    const original = initial([
      trip({ id: 'planned', hoursPerDay: 4 }),
      trip({ id: 'logged', startDate: '2026-06-15', endDate: '2026-06-15', kind: 'logged_past',
        actualHoursUsed: 4, hourSource: 'vacation', debitedFrom: { vacation: 4, sick: 0, bank: 0 } }),
    ])
    original.profile.currentVacationHours = 36
    original.profile.currentBankHours = 0
    original.profile.lastPaydayDate = '2026-06-12'
    const migrated = migrateState(JSON.parse(JSON.stringify(original)))
    expect(migrated.profile.currentVacationHours).toBe(36)
    expect(migrated.plannedVacations[0].appliedDeductions).toBeUndefined()
    const booked = book(migrated, '2026-06-18')
    expect(booked.profile.currentVacationHours).toBe(28)
    expect(booked.plannedVacations[0].actualHoursUsed).toBe(8)
    expect(booked.plannedVacations[1].debitedFrom).toEqual({ vacation: 4, sick: 0, bank: 0 })
    expect(catchUpState(booked).applied).toBe(false)
  })

  it('retains ledger rows and pool totals through JSON reload and repeated migration', () => {
    const booked = book(initial(), '2026-06-16')
    const restored = migrateState(migrateState(JSON.parse(JSON.stringify(booked))))
    expect(restored.plannedVacations).toEqual(booked.plannedVacations)
    expect(restored.profile).toEqual(booked.profile)
    expect(catchUpState(restored).events).toEqual([])
    expectBalancesEqual(book(restored, '2026-06-18'), book(initial(), '2026-06-18'))
  })
})
