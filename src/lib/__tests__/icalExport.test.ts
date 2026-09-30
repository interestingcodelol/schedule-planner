import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildIcalString, DEFAULT_ICAL_OPTIONS } from '../icalExport'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState, PlannedVacation } from '../types'

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

describe('iCal snapshot identity and lifecycle metadata', () => {
  it('preserves the existing per-entry UID across exports and date/detail edits', () => {
    const state = makeState()
    const a = buildIcalString(state, onlyTimeOff)
    state.plannedVacations[0].startDate = '2099-08-01'
    state.plannedVacations[0].endDate = '2099-08-02'
    state.plannedVacations[0].note = 'Rescheduled'
    const b = buildIcalString(state, onlyTimeOff)
    const uid = 'UID:vacation-abc123@schedule-planner.local'
    expect(a).toContain(uid)
    expect(b).toContain(uid)
    expect(b).toContain('DTSTART;VALUE=DATE:20990801')
    expect(b).not.toContain('DTSTART;VALUE=DATE:20990701')
    expect(b.match(/BEGIN:VEVENT/g)).toHaveLength(1)
  })

  it('retains an export-time SEQUENCE hint that increases for a later clock time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const first = seqOf(buildIcalString(makeState(), DEFAULT_ICAL_OPTIONS))
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z')) // 5 minutes later
    const second = seqOf(buildIcalString(makeState(), DEFAULT_ICAL_OPTIONS))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })

  it('does not treat SEQUENCE as a persisted, strictly increasing entry revision', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'))
    const state = makeState()
    const first = seqOf(buildIcalString(state, onlyTimeOff))
    state.plannedVacations[0].note = 'Edited within the same second'
    vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'))
    const edited = unfold(buildIcalString(state, onlyTimeOff))
    expect(seqOf(edited)).toBe(first)
    expect(edited).toContain('SUMMARY:🌴 Time off — Edited within the same second')
    vi.setSystemTime(new Date('2025-12-31T23:59:59Z'))
    expect(seqOf(buildIcalString(state, onlyTimeOff))).toBeLessThan(first)
  })

  it('omits deleted entries without emitting cancellation or deletion instructions', () => {
    const state = makeState()
    expect(buildIcalString(state, onlyTimeOff)).toContain('UID:vacation-abc123@')
    state.plannedVacations = []
    const snapshot = buildIcalString(state, onlyTimeOff)
    expect(snapshot).toContain('METHOD:PUBLISH')
    expect(snapshot).not.toContain('BEGIN:VEVENT')
    expect(snapshot).not.toContain('vacation-abc123')
    expect(snapshot).not.toContain('METHOD:CANCEL')
    expect(snapshot).not.toContain('STATUS:CANCELLED')
  })

  it('does not advertise a refreshable feed or invent an original creation time', () => {
    const ics = buildIcalString(makeState(), onlyTimeOff)
    expect(ics).toContain('STATUS:CONFIRMED')
    expect(ics).toContain('LAST-MODIFIED:')
    expect(ics).not.toContain('CREATED:')
    expect(ics).not.toContain('X-PUBLISHED-TTL:')
    expect(ics).not.toContain('REFRESH-INTERVAL:')
    expect(ics).not.toContain('METHOD:CANCEL')
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

function makeTimedState(
  entry: Partial<PlannedVacation> = {},
  timezone = 'America/New_York',
): AppState {
  const state = makeState()
  state.profile.timezone = timezone
  state.plannedVacations[0] = {
    ...state.plannedVacations[0],
    startDate: '2026-07-01',
    endDate: '2026-07-01',
    hoursPerDay: 2,
    timeOffStart: '10:00',
    timeOffEnd: '12:00',
    ...entry,
  }
  return state
}

describe('iCal explicit partial-day clock intervals', () => {
  // The release timezone matrix runs these exact UTC expectations with different
  // host zones; dates and clock times must always belong to the profile zone.
  it.each([
    ['2026-01-15', 'America/New_York', '20260115T150000Z', '20260115T170000Z'],
    ['2026-07-15', 'America/New_York', '20260715T140000Z', '20260715T160000Z'],
    ['2026-01-15', 'America/Los_Angeles', '20260115T180000Z', '20260115T200000Z'],
    ['2026-07-15', 'America/Los_Angeles', '20260715T170000Z', '20260715T190000Z'],
    ['2026-07-15', 'Asia/Kathmandu', '20260715T041500Z', '20260715T061500Z'],
    ['2026-01-15', 'Pacific/Auckland', '20260114T210000Z', '20260114T230000Z'],
    ['2026-07-15', 'Pacific/Auckland', '20260714T220000Z', '20260715T000000Z'],
  ])(
    'exports 10–12 on %s in %s as UTC, independently of the host timezone',
    (date, zone, start, end) => {
      const state = makeTimedState({ startDate: date, endDate: date }, zone)
      const ics = unfold(buildIcalString(state, onlyTimeOff))
      expect(ics).toContain(`DTSTART:${start}\r\n`)
      expect(ics).toContain(`DTEND:${end}\r\n`)
      expect(ics).not.toContain('VALUE=DATE')
      expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:FALSE')
      expect(ics).toContain('TRANSP:OPAQUE')
      expect(ics).toContain('X-MICROSOFT-CDO-BUSYSTATUS:OOF')
      expect(ics).toContain('X-MICROSOFT-CDO-INTENDEDSTATUS:OOF')
      expect(ics).toContain(`Clock times: 10:00–12:00 (${zone})`)
      expect(ics).toContain('Partial day: 2 hrs/day')
      expect(ics).toContain('BEGIN:VALARM')
      expect(ics).toContain('TRIGGER:-P1D')
      expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    },
  )

  it.each([
    ['2026-03-08', '01:30', '03:30', '20260308T063000Z', '20260308T073000Z'],
    ['2026-11-01', '00:30', '02:30', '20261101T043000Z', '20261101T073000Z'],
    ['2026-11-01', '01:15', '01:45', '20261101T051500Z', '20261101T054500Z'],
  ])(
    'resolves DST clock interval %s %s–%s without shifting civil times',
    (date, from, to, start, end) => {
      const state = makeTimedState({
        startDate: date,
        endDate: date,
        timeOffStart: from,
        timeOffEnd: to,
      })
      const ics = buildIcalString(state, onlyTimeOff)
      expect(ics).toContain(`DTSTART:${start}\r\n`)
      expect(ics).toContain(`DTEND:${end}\r\n`)
    },
  )

  it.each([
    ['02:30', '03:30'],
    ['01:30', '02:30'],
  ])('rejects nonexistent spring-forward times in %s–%s instead of shifting them', (start, end) => {
    const state = makeTimedState({
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      timeOffStart: start,
      timeOffEnd: end,
    })
    expect(() => buildIcalString(state, onlyTimeOff)).toThrow(
      '2026-03-08 02:30 does not exist in America/New_York',
    )
  })

  it('uses the established default profile zone when none is saved', () => {
    const state = makeTimedState()
    delete state.profile.timezone
    const ics = buildIcalString(state, onlyTimeOff)
    expect(ics).toContain('DTSTART:20260701T140000Z')
    expect(ics).toContain('DTEND:20260701T160000Z')
  })

  it('rejects an invalid profile timezone rather than substituting the host zone', () => {
    const state = makeTimedState({}, 'Not/A_Timezone')
    expect(() => buildIcalString(state, onlyTimeOff)).toThrow('valid profile timezone')
  })

  it.each([
    ['2026-01-15', '00:00', '02:00', '20260115T050000Z', '20260115T070000Z'],
    ['2026-12-31', '22:00', '24:00', '20270101T030000Z', '20270101T050000Z'],
    ['2026-03-08', '22:00', '24:00', '20260309T020000Z', '20260309T040000Z'],
  ])('supports midnight boundaries on %s from %s to %s', (date, from, to, start, end) => {
    const state = makeTimedState({
      startDate: date,
      endDate: date,
      timeOffStart: from,
      timeOffEnd: to,
    })
    const ics = buildIcalString(state, onlyTimeOff)
    expect(ics).toContain(`DTSTART:${start}\r\n`)
    expect(ics).toContain(`DTEND:${end}\r\n`)
    expect(ics).not.toContain('VALUE=DATE')
  })

  it('retains the same UID when a full-day entry is changed to a timed partial day', () => {
    const state = makeTimedState({ hoursPerDay: undefined })
    const fullDay = buildIcalString(state, onlyTimeOff)
    state.plannedVacations[0].hoursPerDay = 2
    const timed = buildIcalString(state, onlyTimeOff)
    const uid = 'UID:vacation-abc123@schedule-planner.local'
    expect(fullDay).toContain(uid)
    expect(fullDay).toContain('DTSTART;VALUE=DATE:20260701')
    expect(timed).toContain(uid)
    expect(timed).toContain('DTSTART:20260701T140000Z')
  })

  it('exports logged clock times while retaining actual hours and suppressing alarms', () => {
    const state = makeTimedState({ kind: 'logged_past', actualHoursUsed: 1.25 })
    const ics = unfold(buildIcalString(state, { ...onlyTimeOff, includeLoggedPast: true }))
    expect(ics).toContain('SUMMARY:🌴 Time off (logged)')
    expect(ics).toContain('DTSTART:20260701T140000Z')
    expect(ics).toContain('DTEND:20260701T160000Z')
    expect(ics).toContain('Actual hours used: 1.25 hrs total')
    expect(ics).not.toContain('Partial day: 2 hrs/day')
    expect(ics).not.toContain('BEGIN:VALARM')
    expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:FALSE')
    expect(buildIcalString(state, onlyTimeOff)).not.toContain('BEGIN:VEVENT')
  })

  it('keeps planned/logged selection and reminder options independent of clock times', () => {
    const state = makeTimedState({ kind: undefined })
    expect(buildIcalString(state, { ...onlyTimeOff, reminderDaysBeforeTimeOff: 0 })).not.toContain(
      'BEGIN:VALARM',
    )
    expect(
      buildIcalString(state, {
        ...onlyTimeOff,
        includePlannedTimeOff: false,
        includeLoggedPast: true,
      }),
    ).not.toContain('BEGIN:VEVENT')
  })

  it('does not change recorded hours, policy, balances, or deduction history', () => {
    const state = makeTimedState({
      hourSource: 'any',
      actualHoursUsed: 1.5,
      appliedDeductions: [
        { date: '2026-07-01', hours: 1.5, drawn: { vacation: 1, sick: 0, bank: 0.5 } },
      ],
      debitedFrom: { vacation: 1, sick: 0, bank: 0.5 },
    })
    const before = structuredClone(state)
    const ics = unfold(buildIcalString(state, onlyTimeOff))
    expect(ics).toContain('Source: auto')
    expect(ics).toContain('Actual hours used: 1.50 hrs total')
    expect(state).toEqual(before)
  })
})

describe('iCal all-day fallback and preserved date ranges', () => {
  it.each([
    ['missing both clock times', undefined, undefined],
    ['missing start', undefined, '12:00'],
    ['missing end', '10:00', undefined],
    ['un-padded time', '9:00', '12:00'],
    ['invalid minutes', '10:60', '12:00'],
    ['invalid end', '10:00', '25:00'],
    ['equal times', '10:00', '10:00'],
    ['reversed times', '12:00', '10:00'],
    ['overnight without a next-day date', '22:00', '02:00'],
    ['24:00 as start', '24:00', '24:00'],
  ])('does not invent an interval for %s', (_label, start, end) => {
    const state = makeTimedState({ timeOffStart: start, timeOffEnd: end })
    const ics = unfold(buildIcalString(state, onlyTimeOff))
    expect(ics).toContain('DTSTART;VALUE=DATE:20260701')
    expect(ics).toContain('DTEND;VALUE=DATE:20260702')
    expect(ics).not.toMatch(/\r\nDTSTART:/)
    expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
    expect(ics).toContain('Exported as all-day: no valid single-day clock interval is saved.')
    expect(ics).not.toContain('Clock times:')
  })

  it.each([undefined, 8])('keeps a full workday all-day when hoursPerDay is %s', (hoursPerDay) => {
    const state = makeTimedState({ hoursPerDay })
    const ics = unfold(buildIcalString(state, onlyTimeOff))
    expect(ics).toContain('DTSTART;VALUE=DATE:20260701')
    expect(ics).toContain('DTEND;VALUE=DATE:20260702')
    expect(ics).toContain('Full day: 8 hrs')
    expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
    expect(ics).not.toContain('Clock times:')
  })

  it('uses the configured workday to distinguish full and partial entries', () => {
    const state = makeTimedState({ hoursPerDay: 4 })
    state.policy.hoursPerWorkDay = 4
    expect(buildIcalString(state, onlyTimeOff)).toContain('DTSTART;VALUE=DATE:20260701')
    state.policy.hoursPerWorkDay = 10
    expect(buildIcalString(state, onlyTimeOff)).toContain('DTSTART:20260701T140000Z')
  })

  it.each([2, 8])(
    'keeps multi-day entries all-day with an exclusive DTEND (%s hours/day)',
    (hoursPerDay) => {
      const state = makeTimedState({
        startDate: '2026-12-30',
        endDate: '2027-01-02',
        hoursPerDay,
      })
      const ics = unfold(buildIcalString(state, onlyTimeOff))
      expect(ics).toContain('DTSTART;VALUE=DATE:20261230')
      expect(ics).toContain('DTEND;VALUE=DATE:20270103')
      expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
      expect(ics).not.toContain('Clock times:')
      expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    },
  )

  it('preserves all-day civil boundaries across a DST change', () => {
    const state = makeTimedState({
      startDate: '2026-03-07',
      endDate: '2026-03-09',
      hoursPerDay: 8,
    })
    const ics = buildIcalString(state, onlyTimeOff)
    expect(ics).toContain('DTSTART;VALUE=DATE:20260307')
    expect(ics).toContain('DTEND;VALUE=DATE:20260310')
  })
})

describe('iCal text and wire format', () => {
  it('folds every physical line to 75 UTF-8 bytes without splitting Unicode code points', () => {
    const state = makeTimedState({
      id: 'long-entry-'.repeat(20),
      note: 'Café 漢字 🌴🧑🏽‍💻 '.repeat(30),
    })
    const ics = buildIcalString(state, onlyTimeOff)
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const lines = ics.split('\r\n')
    expect(lines.some((line) => line.startsWith(' '))).toBe(true)
    for (const line of lines) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75)
      expect(decoder.decode(encoder.encode(line))).toBe(line)
    }
    expect(unfold(ics)).toContain(
      `UID:vacation-${state.plannedVacations[0].id}@schedule-planner.local`,
    )
    expect(unfold(ics)).toContain(`SUMMARY:🌴 Time off — ${state.plannedVacations[0].note}\r\n`)
    expect(ics).not.toContain('�')
    expect(ics).toBe(ics.replace(/\r?\n/g, '\r\n'))
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('escapes CRLF, lone CR/LF, commas, semicolons, and backslashes as text', () => {
    const state = makeTimedState({
      note: 'Check, this; path\\file\r\nSTATUS:CANCELLED\rATTENDEE:mailto:test@example.invalid\nEND:VEVENT',
    })
    const ics = buildIcalString(state, onlyTimeOff)
    const unfolded = unfold(ics)
    const escaped =
      'Check\\, this\\; path\\\\file\\nSTATUS:CANCELLED\\nATTENDEE:mailto:test@example.invalid\\nEND:VEVENT'
    expect(unfolded).toContain(`SUMMARY:🌴 Time off — ${escaped}\r\n`)
    expect(unfolded).toContain(`DESCRIPTION:Note: ${escaped}\\nPartial day: 2 hrs/day`)
    expect(unfolded).toContain(`DESCRIPTION:🌴 Time off — ${escaped}\r\n`)
    expect(ics.match(/(?:^|\r\n)BEGIN:VEVENT\r\n/g)).toHaveLength(1)
    expect(ics.match(/(?:^|\r\n)END:VEVENT\r\n/g)).toHaveLength(1)
    expect(ics).not.toContain('\r\nSTATUS:CANCELLED\r\n')
    expect(ics).not.toContain('\rATTENDEE:')
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('escapes imported entry IDs as UID text without allowing extra properties', () => {
    const state = makeTimedState({
      id: 'imported,entry;\\id\r\nSTATUS:CANCELLED\rEND:VEVENT\nBEGIN:VEVENT',
    })
    const ics = buildIcalString(state, onlyTimeOff)
    expect(unfold(ics)).toContain(
      'UID:vacation-imported\\,entry\\;\\\\id\\nSTATUS:CANCELLED\\nEND:VEVENT\\nBEGIN:VEVENT@schedule-planner.local\r\n',
    )
    expect(ics.match(/(?:^|\r\n)BEGIN:VEVENT\r\n/g)).toHaveLength(1)
    expect(ics.match(/(?:^|\r\n)END:VEVENT\r\n/g)).toHaveLength(1)
    expect(ics).not.toContain('\r\nSTATUS:CANCELLED\r\n')
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })
})

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
    expect(ics).toContain('DTSTART;VALUE=DATE:20260422')
    expect(ics).toContain('TRANSP:TRANSPARENT')
    expect(ics).toContain('X-MICROSOFT-CDO-BUSYSTATUS:FREE')
    expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
    expect(ics).not.toContain('TRANSP:OPAQUE')
    expect(ics).not.toContain('BEGIN:VALARM')
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
