import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useAppState } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState } from '../../lib/types'
import { Insights } from '../Insights'

vi.mock('../../context', () => ({ useAppState: vi.fn() }))
function fixture(): AppState {
  return {
    profile: {
      displayName: 'Fixture',
      hireDate: '2020-01-15',
      currentVacationHours: 40,
      currentSickHours: 0,
      currentBankHours: 0,
      lastPaydayDate: '2025-01-03',
      lastSyncDate: '2025-01-10',
      timezone: 'UTC',
    },
    policy: {
      ...defaultPolicy,
      holidays: [],
      carryoverCapStrategy: 'unlimited',
      sickLeaveCarryoverCap: undefined,
    },
    plannedVacations: [],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 2,
  }
}
function show(state: AppState, today: string) {
  vi.setSystemTime(new Date(`${today}T12:00:00Z`))
  state.profile.lastSyncDate = today
  vi.mocked(useAppState).mockReturnValue({ state } as ReturnType<typeof useAppState>)
  render(<Insights />)
  return screen.getByRole('region', { name: 'Planning insights' }).textContent!
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('insight accounting and anniversary dates', () => {
  it('counts a multi-day actual total once, without multiplying by workdays', () => {
    const state = fixture()
    state.plannedVacations = [
      {
        id: 'logged',
        startDate: '2025-01-06',
        endDate: '2025-01-07',
        hourSource: 'vacation',
        locked: false,
        kind: 'logged_past',
        actualHoursUsed: 10,
      },
    ]
    const text = show(state, '2025-01-10')
    expect(text).toContain('(10 of ')
    expect(text).not.toContain('(20 of ')
  })
  it('still multiplies per-day hours when no actual total exists', () => {
    const state = fixture()
    state.plannedVacations = [
      {
        id: 'logged',
        startDate: '2025-01-06',
        endDate: '2025-01-07',
        hourSource: 'vacation',
        locked: false,
        kind: 'logged_past',
        hoursPerDay: 3,
      },
    ]
    expect(show(state, '2025-01-10')).toContain('(6 of ')
  })
  it('respects an explicit zero actual total', () => {
    const state = fixture()
    state.plannedVacations = [
      {
        id: 'logged',
        startDate: '2025-01-06',
        endDate: '2025-01-07',
        hourSource: 'vacation',
        locked: false,
        kind: 'logged_past',
        actualHoursUsed: 0,
      },
    ]
    expect(show(state, '2025-01-10')).not.toContain('of your annual PTO')
  })
  it('does not advertise an increase when the next tier pays the same rate', () => {
    const state = fixture()
    state.profile.hireDate = '2024-08-01'
    expect(show(state, '2025-02-01')).not.toContain('Accrual rate increases')
  })
  it.each([
    ['2024-07-14', false, ''],
    ['2024-07-15', true, '184 days'],
    ['2025-01-14', true, '1 day'],
    ['2025-01-15', false, ''],
  ])('uses the six-calendar-month boundary on %s', (today, shown, remaining) => {
    const text = show(fixture(), today)
    if (shown) expect(text).toContain(`Accrual rate increases to 4.62 hrs/period in ${remaining}`)
    else expect(text).not.toContain('Accrual rate increases')
  })
  it.each([
    ['2024-08-31', false, ''],
    ['2024-09-01', true, '181 days'],
    ['2025-02-28', true, '1 day'],
    ['2025-03-01', false, ''],
  ])(
    'matches projection anniversary semantics for a Feb 29 hire on %s',
    (today, shown, remaining) => {
      const state = fixture()
      state.profile.hireDate = '2020-02-29'
      const text = show(state, today)
      if (shown) expect(text).toContain(`Accrual rate increases to 4.62 hrs/period in ${remaining}`)
      else expect(text).not.toContain('Accrual rate increases')
    },
  )
})
