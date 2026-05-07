import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { catchUpState } from '../catchUp'
import { projectBalance, getEffectiveCurrentBalances } from '../projection'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'
import { addDays } from 'date-fns'
import { buildIcalString } from '../icalExport'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
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
  vi.setSystemTime(new Date(`${iso}T15:00:00Z`))
}

beforeEach(() => {
  mockToday('2026-05-07')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('edge cases', () => {
  describe('hireDate in the future', () => {
    it('catchUpState does not crash when hireDate is after today', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          hireDate: '2027-01-01',
          // Pretend the user fat-fingered their hire date but the rest of
          // the catch-up window is normal.
          lastPaydayDate: '2026-04-24',
          lastSyncDate: '2026-04-24',
        },
      })
      expect(() => catchUpState(state)).not.toThrow()
      const result = catchUpState(state)
      // Catch-up still walks paydays — but with a future hire date, years-of
      // -service goes negative and computeAccrualTier should return some tier
      // (the first one's the default fallback). What we care about is that
      // it doesn't blow up.
      expect(result.state.profile.currentVacationHours).toBeGreaterThanOrEqual(0)
    })

    it('projectBalance does not crash when hireDate is after today', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          hireDate: '2027-01-01',
        },
      })
      expect(() => projectBalance(state, addDays(new Date(), 30))).not.toThrow()
    })

    it('iCal export does not crash on future hireDate', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          hireDate: '2027-01-01',
        },
      })
      expect(() =>
        buildIcalString(state, {
          includePlannedTimeOff: true,
          includeLoggedPast: false,
          includeHolidays: true,
          includePaydays: true,
          includeCarryoverPayout: true,
          includeBankWindow: true,
          includeAnniversaries: true,
          yearsAhead: 2,
        }),
      ).not.toThrow()
    })
  })

  describe('lastPaydayDate after today', () => {
    it('catchUpState handles lastPaydayDate in the future', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          // Today is 2026-05-07; this is far ahead of that.
          lastPaydayDate: '2026-08-01',
          // lastSyncDate is also future — catch-up should be a no-op
          // because today < lastSync.
          lastSyncDate: '2026-08-01',
        },
      })
      expect(() => catchUpState(state)).not.toThrow()
      const result = catchUpState(state)
      // Today (May 7) is BEFORE the future sync date — clock-went-backwards
      // guard should kick in and produce no events.
      expect(result.applied).toBe(false)
      expect(result.events).toHaveLength(0)
      expect(result.state.profile.currentVacationHours).toBe(40)
    })

    it('catchUpState with future lastPaydayDate but past lastSyncDate', () => {
      // This case can happen if a user manually edits lastPaydayDate to look
      // ahead. The catch-up engine should not try to apply paydays in the
      // future.
      const state = makeState({
        profile: {
          ...makeState().profile,
          lastPaydayDate: '2026-08-01',
          lastSyncDate: '2026-04-01',
        },
      })
      expect(() => catchUpState(state)).not.toThrow()
      const result = catchUpState(state)
      // Paydays from `lastPaydayDate` walking forward all land in the
      // future — none should fire before today (2026-05-07).
      const accruals = result.events.filter((e) => e.type === 'accrual')
      expect(accruals).toHaveLength(0)
    })

    it('projectBalance returns sensible values when lastPaydayDate is in the future', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          lastPaydayDate: '2026-08-01',
          lastSyncDate: '2026-04-01',
        },
      })
      const result = projectBalance(state, new Date('2026-05-07'))
      // The balance should remain at the stored value — no paydays accrue
      // before the future anchor.
      expect(result.vacationBalance).toBeGreaterThanOrEqual(0)
      expect(result.totalAvailable).toBeGreaterThanOrEqual(0)
    })
  })

  describe('future-dated bank entries', () => {
    it('does not credit a future bank entry to the current balance', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          currentBankHours: 0,
        },
        bankHoursLog: [
          {
            id: 'future-1',
            date: '2027-01-15',
            hours: 10,
            note: 'Promised overtime',
            appliedToBalance: false,
          },
        ],
      })
      const eff = getEffectiveCurrentBalances(state)
      expect(eff.bank).toBe(0)
    })

    it('catchUpState folds future bank entries in once their date arrives', () => {
      // lastSync 2026-04-01, today 2026-05-07 → entry dated 2026-04-15 should fold in
      const state = makeState({
        profile: {
          ...makeState().profile,
          currentBankHours: 0,
          lastPaydayDate: '2026-04-01',
          lastSyncDate: '2026-04-01',
        },
        bankHoursLog: [
          {
            id: 'future-1',
            date: '2026-04-15',
            hours: 10,
            note: 'Promised overtime',
            appliedToBalance: false,
          },
        ],
      })
      const result = catchUpState(state)
      expect(result.state.profile.currentBankHours).toBe(10)
      const updatedEntry = result.state.bankHoursLog.find((e) => e.id === 'future-1')
      expect(updatedEntry?.appliedToBalance).toBe(true)
    })

    it('does not double-credit on subsequent runs', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          currentBankHours: 0,
          lastPaydayDate: '2026-04-01',
          lastSyncDate: '2026-04-01',
        },
        bankHoursLog: [
          {
            id: 'future-1',
            date: '2026-04-15',
            hours: 10,
            appliedToBalance: false,
          },
        ],
      })
      const first = catchUpState(state)
      expect(first.state.profile.currentBankHours).toBe(10)
      // Running again from the same state should be idempotent.
      const second = catchUpState(first.state)
      expect(second.state.profile.currentBankHours).toBe(10)
    })

    it('keeps far-future entries unapplied across catch-up runs', () => {
      const state = makeState({
        profile: {
          ...makeState().profile,
          currentBankHours: 5,
          lastPaydayDate: '2026-04-01',
          lastSyncDate: '2026-04-01',
        },
        bankHoursLog: [
          {
            id: 'far-future',
            date: '2027-08-01',
            hours: 8,
            appliedToBalance: false,
          },
        ],
      })
      const result = catchUpState(state)
      expect(result.state.profile.currentBankHours).toBe(5)
      const stillUnapplied = result.state.bankHoursLog.find((e) => e.id === 'far-future')
      expect(stillUnapplied?.appliedToBalance).toBe(false)
    })

    it('iCal export survives a far-future bank entry without crashing', () => {
      const state = makeState({
        bankHoursLog: [
          {
            id: 'far-future',
            date: '2030-01-01',
            hours: 8,
            appliedToBalance: false,
          },
        ],
      })
      const ics = buildIcalString(state, {
        includePlannedTimeOff: true,
        includeLoggedPast: false,
        includeHolidays: true,
        includePaydays: true,
        includeCarryoverPayout: true,
        includeBankWindow: true,
        includeAnniversaries: true,
        yearsAhead: 2,
      })
      expect(ics).toMatch(/BEGIN:VCALENDAR/)
      expect(ics).toMatch(/END:VCALENDAR/)
    })
  })
})

describe('iCal export', () => {
  it('emits a valid VCALENDAR wrapper', () => {
    const state = makeState({
      plannedVacations: [
        {
          id: 'v1',
          startDate: '2026-12-22',
          endDate: '2026-12-26',
          hourSource: 'any',
          locked: false,
          note: 'Holiday week',
        },
      ],
    })
    const ics = buildIcalString(state, {
      includePlannedTimeOff: true,
      includeLoggedPast: false,
      includeHolidays: true,
      includePaydays: true,
      includeCarryoverPayout: true,
      includeBankWindow: true,
      includeAnniversaries: true,
      yearsAhead: 1,
    })
    expect(ics).toMatch(/^BEGIN:VCALENDAR/)
    expect(ics).toMatch(/END:VCALENDAR\r\n$/)
    expect(ics).toMatch(/PRODID:/)
    expect(ics).toMatch(/METHOD:PUBLISH/)
    // Vacation entry shows up as VEVENT with stable UID
    expect(ics).toMatch(/UID:vacation-v1@/)
  })

  it('escapes commas, semicolons, and newlines in summaries/descriptions', () => {
    const state = makeState({
      plannedVacations: [
        {
          id: 'v1',
          startDate: '2026-06-01',
          endDate: '2026-06-01',
          hourSource: 'vacation',
          locked: false,
          note: 'Family trip; bring snacks, sunscreen\nand a hat',
        },
      ],
    })
    const ics = buildIcalString(state, {
      includePlannedTimeOff: true,
      includeLoggedPast: false,
      includeHolidays: false,
      includePaydays: false,
      includeCarryoverPayout: false,
      includeBankWindow: false,
      includeAnniversaries: false,
      yearsAhead: 1,
    })
    // Commas, semicolons, and newlines must be escaped per RFC 5545
    expect(ics).toMatch(/snacks\\,/)
    expect(ics).toMatch(/trip\\;/)
    expect(ics).toMatch(/sunscreen\\nand/)
  })

  it('respects toggle options — none enabled produces an empty calendar', () => {
    const state = makeState({
      plannedVacations: [
        {
          id: 'v1',
          startDate: '2026-12-22',
          endDate: '2026-12-26',
          hourSource: 'any',
          locked: false,
        },
      ],
    })
    const ics = buildIcalString(state, {
      includePlannedTimeOff: false,
      includeLoggedPast: false,
      includeHolidays: false,
      includePaydays: false,
      includeCarryoverPayout: false,
      includeBankWindow: false,
      includeAnniversaries: false,
      yearsAhead: 1,
    })
    expect(ics).not.toMatch(/BEGIN:VEVENT/)
    expect(ics).toMatch(/BEGIN:VCALENDAR/)
    expect(ics).toMatch(/END:VCALENDAR/)
  })
})
