import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { format, previousFriday, subYears } from 'date-fns'
import { processChat } from '../chatParser'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  const today = new Date()
  const lastFriday = previousFriday(today)
  return {
    profile: {
      displayName: 'Test User',
      hireDate: format(subYears(today, 2), 'yyyy-MM-dd'),
      currentVacationHours: 40,
      currentSickHours: 0,
      currentBankHours: 0,
      lastPaydayDate: format(lastFriday, 'yyyy-MM-dd'),
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

function mockToday(dateStr: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(dateStr + 'T12:00:00').getTime())
}

beforeEach(() => {
  mockToday('2026-04-22') // A Wednesday
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chat "can I afford" edge cases', () => {
  it('exact-match hours: 40 total, 40 needed → should say Yes (not "0 hrs short")', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2024-01-01',
        currentVacationHours: 40,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2026-04-17',
      },
    })

    const r = processChat('can i afford next week off', state)
    expect(r.text).toMatch(/^\*\*Yes\./)
    expect(r.text).not.toMatch(/0 hrs short/)
    expect(r.action).toBeDefined()
  })

  it('exact-match split across pools: 20 vac + 20 sick = 40 total, 40 needed → Yes', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2024-01-01',
        currentVacationHours: 20,
        currentSickHours: 20,
        currentBankHours: 0,
        lastPaydayDate: '2026-04-17',
      },
    })
    const r = processChat('can i afford next week', state)
    expect(r.text).toMatch(/^\*\*Yes\./)
  })

  it('bank covers the gap: 0 vac + 0 sick + 40 bank → Yes', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2024-01-01',
        currentVacationHours: 0,
        currentSickHours: 0,
        currentBankHours: 40,
        lastPaydayDate: '2026-04-17',
      },
    })
    const r = processChat('can i afford next week', state)
    expect(r.text).toMatch(/^\*\*Yes\./)
  })

  it('not enough: 16 total, 40 needed → flags real shortfall (not 0)', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2024-01-01',
        currentVacationHours: 16,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2026-04-17',
      },
    })
    const r = processChat('can i afford next week', state)
    expect(r.text).toMatch(/Not enough hours/)
    // Should report a positive shortfall number, not "0 hrs short".
    expect(r.text).not.toMatch(/\b0 hrs short\b/)
    expect(r.text).toMatch(/\d+(?:\.\d+)? hrs short/)
  })

  it('all-holiday range: Christmas Eve + Day → "no PTO needed"', () => {
    // Dec 24-25 in 2026: Dec 24 is Thu (Christmas Eve holiday), Dec 25 Fri
    // (Christmas Day). Both are policy holidays.
    const state = makeState()
    const r = processChat('take off dec 24 to dec 25', state)
    expect(r.text).toMatch(/no PTO needed|weekends and\/or holidays/i)
  })

  it('downstream conflict: trip fits but breaks later plan → "Conflicts with later plans"', () => {
    // User has 40 hrs and an already-scheduled trip in May that drains the
    // balance to ~0. Adding "next week" (40 hrs) on top → no room for both.
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2024-01-01',
        currentVacationHours: 40,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2026-04-17',
      },
      policy: { ...defaultPolicy, sickLeaveAnnualGrant: 0 },
      plannedVacations: [
        {
          id: 'may',
          startDate: '2026-05-04',
          endDate: '2026-05-08',
          hourSource: 'vacation',
          locked: false,
          kind: 'planned',
        },
      ],
    })

    const r = processChat('can i afford next week off', state)
    expect(r.text).toMatch(/Conflicts with later plans|Not enough hours/i)
  })

  it('floating-point jitter: sub-epsilon shortfall does not trigger "0 hrs short"', () => {
    // 40 hrs balance, 40 hrs need, but a tier of 3.076 causes tiny float
    // residue. The epsilon filter should collapse it to "affordable".
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2020-01-01', // Years 2–5 tier
        currentVacationHours: 40,
        currentSickHours: 0,
        currentBankHours: 0,
        lastPaydayDate: '2026-04-17',
      },
    })
    const r = processChat('can i afford next week', state)
    expect(r.text).not.toMatch(/\b0 hrs short\b/)
  })
})

describe('chat: date-range year-roll edge cases', () => {
  // The rolled-forward notice text the parser surfaces for next-year dates.
  const NEXT_YEAR_NOTICE = /next year/i

  it('(a) range straddling today keeps the current year (does not roll)', () => {
    // today = mid-range. "July 14-18" with today July 16 must stay 2026,
    // not jump to 2027 just because the start day (14) is in the past.
    mockToday('2026-07-16')
    const state = makeState()
    const r = processChat('take off july 14-18', state)
    // Should reference July (current year) and NOT show the next-year notice.
    expect(r.text).not.toMatch(NEXT_YEAR_NOTICE)
    expect(r.action).toBeDefined()
    expect(r.action?.startDate).toBe('2026-07-14')
    expect(r.action?.endDate).toBe('2026-07-18')
  })

  it('(b) fully-past range rolls to next year as a contiguous same-year range', () => {
    // today = July 16, "July 4-8" is entirely in the past → roll BOTH
    // endpoints to 2027, contiguous.
    mockToday('2026-07-16')
    const state = makeState()
    const r = processChat('take off july 4-8', state)
    expect(r.text).toMatch(NEXT_YEAR_NOTICE)
    expect(r.action?.startDate).toBe('2027-07-04')
    expect(r.action?.endDate).toBe('2027-07-08')
  })

  it('(c) slash range straddling today stays current year and is not inverted', () => {
    // today = April 16, "4/14-4/17" → start 14 is past but end 17 is not.
    // Must stay 2026 and remain a short contiguous range (no ~year-long span).
    mockToday('2026-04-16')
    const state = makeState()
    const r = processChat('book 4/14-4/17', state)
    expect(r.text).not.toMatch(NEXT_YEAR_NOTICE)
    expect(r.action?.startDate).toBe('2026-04-14')
    expect(r.action?.endDate).toBe('2026-04-17')
  })

  it('(d) year-boundary range "Dec 30 - Jan 3" crosses into next year correctly', () => {
    // today = 2026-04-22 (default). End month (Jan) < start month (Dec) means
    // the range genuinely spans the year boundary: Dec 2026 → Jan 2027.
    const state = makeState()
    const r = processChat('plan dec 30 - jan 3', state)
    expect(r.action?.startDate).toBe('2026-12-30')
    expect(r.action?.endDate).toBe('2027-01-03')
  })

  it('(e) single past date rolls forward and surfaces the next-year notice', () => {
    // today = July 16; "take july 7 off" already passed this year → roll to
    // 2027 AND show the same notice ranges show (previously single dates rolled
    // silently). July 7 2027 is a Wednesday (weekday, not a holiday) so it
    // produces a real plan action — unlike July 4, which lands on a weekend.
    mockToday('2026-07-16')
    const state = makeState()
    const r = processChat('take july 7 off', state)
    expect(r.text).toMatch(NEXT_YEAR_NOTICE)
    expect(r.action?.startDate).toBe('2027-07-07')
    expect(r.action?.endDate).toBe('2027-07-07')
  })
})

describe('chat: balance + help + greetings', () => {
  it('greeting returns balance summary and does not crash', () => {
    const state = makeState()
    const r = processChat('hi', state)
    expect(r.text).toMatch(/hours\*?\*? available/i)
  })

  it('help returns the help text', () => {
    const state = makeState()
    const r = processChat('help', state)
    expect(r.text).toMatch(/planning/i)
  })

  it('balance question returns vacation + sick + bank breakdown', () => {
    const state = makeState({
      profile: {
        displayName: 'Test User',
        hireDate: '2024-01-01',
        currentVacationHours: 47.3,
        currentSickHours: 20,
        currentBankHours: 8,
        lastPaydayDate: '2026-04-17',
      },
    })
    const r = processChat("what's my balance", state)
    expect(r.text).toMatch(/47\.3/)
    expect(r.text).toMatch(/20/)
    expect(r.text).toMatch(/8/)
  })
})
