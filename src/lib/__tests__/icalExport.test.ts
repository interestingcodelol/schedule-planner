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
