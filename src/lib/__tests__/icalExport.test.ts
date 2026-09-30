import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildIcalString, DEFAULT_ICAL_OPTIONS } from '../icalExport'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'

function makeState(): AppState {
  return {
    profile: {
      displayName: 'Test',
      hireDate: '2022-01-01',
      currentVacationHours: 40,
      currentSickHours: 20,
      currentBankHours: 0,
      lastPaydayDate: '2025-06-13',
    },
    policy: { ...defaultPolicy },
    plannedVacations: [
      {
        id: 'abc123',
        startDate: '2099-07-01',
        endDate: '2099-07-03',
        hourSource: 'vacation',
        locked: false,
        kind: 'planned',
      },
    ],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 1,
  }
}

afterEach(() => vi.useRealTimers())

function seqOf(ics: string): number {
  const m = ics.match(/SEQUENCE:(\d+)/)
  return m ? Number(m[1]) : -1
}

describe('iCal re-import idempotency', () => {
  it('uses a stable per-entry UID so a re-import updates in place', () => {
    const a = buildIcalString(makeState(), DEFAULT_ICAL_OPTIONS)
    const b = buildIcalString(makeState(), DEFAULT_ICAL_OPTIONS)
    expect(a).toContain('UID:vacation-abc123@')
    expect(b).toContain('UID:vacation-abc123@')
  })

  it('SEQUENCE increases on a later export so clients apply the update', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const first = seqOf(buildIcalString(makeState(), DEFAULT_ICAL_OPTIONS))
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z')) // 5 minutes later
    const second = seqOf(buildIcalString(makeState(), DEFAULT_ICAL_OPTIONS))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })
})

const onlyTimeOff = {
  ...DEFAULT_ICAL_OPTIONS,
  includeHolidays: false,
  includePaydays: false,
  includeCarryoverPayout: false,
  includeBankWindow: false,
  includeAnniversaries: false,
}

function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '')
}

describe('iCal balance and date fidelity', () => {
  it('writes a true UTC DTSTAMP regardless of the host timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T02:34:56.789Z'))
    const ics = buildIcalString(makeState(), onlyTimeOff)
    expect(ics).toContain('DTSTAMP:20260423T023456Z')
    expect(ics).toContain('LAST-MODIFIED:20260423T023456Z')
  })

  it('exports actual logged entry hours as a total, without multiplying by days', () => {
    const state = makeState()
    state.plannedVacations[0] = {
      ...state.plannedVacations[0],
      kind: 'logged_past',
      hoursPerDay: 8,
      actualHoursUsed: 5,
    }
    const ics = unfold(buildIcalString(state, { ...onlyTimeOff, includeLoggedPast: true }))
    expect(ics).toContain('Actual hours used: 5 hrs total')
    expect(ics).not.toContain('Full day: 8 hrs')
    expect(ics).not.toContain('BEGIN:VALARM')
    expect(ics).toContain('DTEND;VALUE=DATE:20990704')
  })

  it('keeps a payday on the user-local today when the host is on tomorrow', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T06:00:00Z'))
    const state = makeState()
    state.profile.timezone = 'America/Los_Angeles'
    state.profile.lastPaydayDate = '2026-04-22'
    const ics = buildIcalString(state, {
      ...onlyTimeOff,
      includePlannedTimeOff: false,
      includePaydays: true,
    })
    expect(ics).toContain('UID:payday-20260422@')
  })

  it('exports both bank payout anchors with stable distinct UIDs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const state = makeState()
    state.profile.timezone = 'Etc/UTC'
    state.profile.lastPaydayDate = '2026-01-02'
    state.policy.bankHoursPayoutStart = { month: 12, day: 15 }
    state.policy.bankHoursPayoutEnd = { month: 2, day: 15 }
    const opts = {
      ...onlyTimeOff,
      includePlannedTimeOff: false,
      includeBankWindow: true,
      yearsAhead: 1,
    }
    const ics = unfold(buildIcalString(state, opts))
    expect(ics).toContain('UID:bank-payout-end-2026@')
    expect(ics).toContain('DTSTART;VALUE=DATE:20260227')
    expect(ics).toContain('UID:bank-payout-2026@')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261218')
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
  })

  it('deduplicates bank triggers landing on the same payday and respects hidden bank', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const state = makeState()
    state.profile.timezone = 'Etc/UTC'
    state.profile.lastPaydayDate = '2026-01-02'
    state.policy.bankHoursPayoutStart = { month: 12, day: 15 }
    state.policy.bankHoursPayoutEnd = { month: 12, day: 16 }
    const opts = {
      ...onlyTimeOff,
      includePlannedTimeOff: false,
      includeBankWindow: true,
      yearsAhead: 1,
    }
    expect(buildIcalString(state, opts).match(/BEGIN:VEVENT/g)).toHaveLength(1)
    state.policy.hideBankHours = true
    expect(buildIcalString(state, opts)).not.toContain('BEGIN:VEVENT')
  })
})
