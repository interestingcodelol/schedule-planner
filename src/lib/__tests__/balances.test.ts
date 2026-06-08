import { describe, it, expect } from 'vitest'
import { applyDebit, applyRefund, applyBreakdownRefund } from '../balances'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'

function stateWith(vacation: number, sick: number, bank: number): AppState {
  return {
    profile: {
      displayName: 'Test',
      hireDate: '2023-01-01',
      currentVacationHours: vacation,
      currentSickHours: sick,
      currentBankHours: bank,
      lastPaydayDate: '2025-06-13',
    },
    policy: { ...defaultPolicy },
    plannedVacations: [],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 1,
  }
}

describe('applyDebit', () => {
  it('an explicit source draws only that pool', () => {
    const r = applyDebit(stateWith(40, 20, 10), 8, 'vacation')
    expect(r.balances).toEqual({ vacation: 32, sick: 20, bank: 10 })
    expect(r.drawn).toEqual({ vacation: 8, sick: 0, bank: 0 })
  })

  it("'any' drains bank → vacation → sick in order", () => {
    const r = applyDebit(stateWith(5, 5, 3), 10, 'any')
    expect(r.drawn).toEqual({ bank: 3, vacation: 5, sick: 2 })
    expect(r.balances).toEqual({ vacation: 0, sick: 3, bank: 0 })
  })

  it("'any' floors at zero when over-drawn (never negative)", () => {
    const r = applyDebit(stateWith(2, 1, 0), 10, 'any')
    expect(r.drawn).toEqual({ bank: 0, vacation: 2, sick: 1 })
    expect(r.balances).toEqual({ vacation: 0, sick: 0, bank: 0 })
  })
})

describe('applyRefund / applyBreakdownRefund', () => {
  it('refunds the named pool ("any" credits vacation)', () => {
    expect(applyRefund(stateWith(10, 5, 2), 4, 'sick')).toEqual({
      vacation: 10,
      sick: 9,
      bank: 2,
    })
    expect(applyRefund(stateWith(10, 5, 2), 4, 'any')).toEqual({
      vacation: 14,
      sick: 5,
      bank: 2,
    })
  })

  it('breakdown refund credits each pool exactly (debit/refund symmetry)', () => {
    expect(
      applyBreakdownRefund(stateWith(10, 5, 2), { vacation: 1, sick: 2, bank: 3 }),
    ).toEqual({ vacation: 11, sick: 7, bank: 5 })
  })
})
