import { addDays, addYears, differenceInYears, endOfYear, format, parseISO } from 'date-fns'
import type { AppState } from './types'
import { computeHolidayDates, getHolidayName } from './holidays'
import { getNowInZone } from './timeUtils'
import { accrualForPeriod, computeAccrualTier, firstPaydayOnOrAfter } from './projection'

export type IcalExportOptions = {
  /** Scheduled future time off + logged past absences (toggled separately
   *  so users can keep their work calendar free of past entries). */
  includePlannedTimeOff: boolean
  includeLoggedPast: boolean
  includeHolidays: boolean
  includePaydays: boolean
  includeCarryoverPayout: boolean
  includeBankWindow: boolean
  includeAnniversaries: boolean
  /** How many years forward to project recurring events (paydays, holidays,
   *  anniversaries, carryover, bank window). 1-3 years is typical — keeps
   *  the file size sane while covering the planning horizon. */
  yearsAhead: number
  /** Days before a *planned* time-off event to fire a display reminder
   *  (VALARM). 0 disables the alarm. Logged-past absences never get alarms. */
  reminderDaysBeforeTimeOff?: number
}

export const DEFAULT_ICAL_OPTIONS: IcalExportOptions = {
  includePlannedTimeOff: true,
  includeLoggedPast: false,
  includeHolidays: true,
  includePaydays: true,
  includeCarryoverPayout: true,
  includeBankWindow: true,
  includeAnniversaries: true,
  yearsAhead: 2,
  reminderDaysBeforeTimeOff: 1,
}

/** Per-category event colour hint (RFC 7986 COLOR property, CSS3 colour names).
 *  Calendar applications may ignore it.
 *  Key matches the first entry in each event's `categories` array. */
const CATEGORY_COLORS: Record<string, string> = {
  'Time Off': 'royalblue',
  Holiday: 'seagreen',
  Payday: 'goldenrod',
  Payout: 'darkorange',
  Bank: 'teal',
  Anniversary: 'mediumpurple',
}

/** Preserve existing event identities. A stable UID does not guarantee that a
 *  calendar application's file-import workflow updates instead of duplicating. */
const UID_DOMAIN = 'schedule-planner.local'

/** RFC 5545 escaping for TEXT-typed properties. CRLF inside SUMMARY/DESCRIPTION
 *  must be encoded as `\n`; commas, semicolons, and backslashes must be
 *  escaped. We don't use control characters, so this is the full list. */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

/** Fold at 75 UTF-8 octets, including the continuation space, without
 *  splitting an emoji or other multi-byte code point (RFC 5545 §3.1). */
function foldLine(line: string): string {
  const encoder = new TextEncoder()
  const parts: string[] = []
  let chunk = ''
  let octets = 0
  for (const character of line) {
    const size = encoder.encode(character).length
    if (octets + size > 75) {
      parts.push(chunk)
      chunk = ' '
      octets = 1
    }
    chunk += character
    octets += size
  }
  parts.push(chunk)
  return parts.join('\r\n')
}

/** Format an all-day DATE value (YYYYMMDD). Every event date in this module is
 *  a local-midnight civil date (parseISO / new Date), matching the projection
 *  engine's convention, so read the LOCAL components — reading UTC would render
 *  the previous day for any user east of UTC. */
function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function fmtHrs(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

function formatUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Convert a saved civil clock time using the profile's IANA timezone, not
 *  the computer's timezone. Check both sides of DST transitions; repeated
 *  times use the first occurrence, as in RFC 5545 §3.3.5. Missing times are
 *  rejected rather than silently shifting the user's appointment. */
function clockTimeInZone(date: Date, time: string, timezone: string): Date {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  } catch {
    throw new Error('Calendar export needs a valid profile timezone. Check your timezone in Settings.')
  }
  const [hour, minute] = time.split(':').map(Number)
  const wallTime = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute)
  const readWallTime = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant))
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  }
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = wallTime + hours * 3_600_000
    offsets.add(readWallTime(instant) - instant)
  }
  const matches = [...offsets]
    .map((offset) => wallTime - offset)
    .filter((instant) => readWallTime(instant) === wallTime)
  if (matches.length === 0) {
    throw new Error(`Calendar export stopped: ${format(date, 'yyyy-MM-dd')} ${time} does not exist in ${timezone} because the clocks change. Review that entry's clock times.`)
  }
  return new Date(Math.min(...matches))
}

function isClockTime(time: string | undefined, allowMidnightEnd = false): time is string {
  return typeof time === 'string' && (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || (allowMidnightEnd && time === '24:00'))
}

type RawEvent = {
  uid: string
  summary: string
  description?: string
  /** All-day single date (DTSTART;VALUE=DATE). */
  date?: Date
  /** All-day range — DTEND is exclusive per RFC, so we add a day at write time. */
  startDate?: Date
  endDate?: Date
  /** Explicit single-day clock interval, resolved to UTC. */
  startTime?: Date
  endTime?: Date
  categories?: string[]
  /** True for time-off events that should show the user as Out of Office /
   *  busy (planned + logged absences). Informational events are FREE. */
  oof?: boolean
  /** True only for *planned* (future) time off — drives the VALARM reminder.
   *  Logged-past absences are oof=true but planned=false (no reminder). */
  planned?: boolean
}

function buildEvents(state: AppState, opts: IcalExportOptions): RawEvent[] {
  const events: RawEvent[] = []
  const today = parseISO(getNowInZone(state.profile.timezone || 'America/New_York').isoDate)
  const horizon = addYears(today, Math.max(1, opts.yearsAhead))

  // --- Planned time off -------------------------------------------------
  if (opts.includePlannedTimeOff || opts.includeLoggedPast) {
    for (const v of state.plannedVacations) {
      const isLogged = v.kind === 'logged_past'
      if (isLogged && !opts.includeLoggedPast) continue
      if (!isLogged && !opts.includePlannedTimeOff) continue
      const start = parseISO(v.startDate)
      const end = parseISO(v.endDate)
      const hrsPerDay = v.hoursPerDay ?? state.policy.hoursPerWorkDay
      const partial = hrsPerDay < state.policy.hoursPerWorkDay
      const hasClockInterval = partial && v.startDate === v.endDate &&
        isClockTime(v.timeOffStart) && isClockTime(v.timeOffEnd, true) &&
        v.timeOffEnd > v.timeOffStart
      const timezone = state.profile.timezone || 'America/New_York'
      const startTime = hasClockInterval ? clockTimeInZone(start, v.timeOffStart!, timezone) : undefined
      const endTime = hasClockInterval ? clockTimeInZone(end, v.timeOffEnd!, timezone) : undefined
      if (startTime && endTime && endTime <= startTime) {
        throw new Error('Calendar export stopped: a time-off clock interval ends before it starts. Review that entry’s clock times.')
      }
      const sourceLabel = v.hourSource === 'any' ? 'auto' : v.hourSource
      const summary = isLogged
        ? '🌴 Time off (logged)'
        : `🌴 Time off${v.note ? ' — ' + v.note : ''}`
      const descriptionLines = [
        v.note ? `Note: ${v.note}` : '',
        v.actualHoursUsed !== undefined
          ? `Actual hours used: ${fmtHrs(v.actualHoursUsed)} hrs total`
          : partial
            ? `Partial day: ${fmtHrs(hrsPerDay)} hrs/day`
            : `Full day: ${fmtHrs(hrsPerDay)} hrs`,
        `Source: ${sourceLabel}`,
        hasClockInterval ? `Clock times: ${v.timeOffStart}–${v.timeOffEnd} (${timezone})` : '',
        partial && !hasClockInterval ? 'Exported as all-day: no valid single-day clock interval is saved.' : '',
      ].filter(Boolean)
      events.push({
        uid: `vacation-${v.id}@${UID_DOMAIN}`,
        summary,
        description: descriptionLines.join('\n'),
        startDate: start,
        endDate: end,
        startTime,
        endTime,
        categories: ['Time Off'],
        oof: true,
        planned: !isLogged,
      })
    }
  }

  // --- Holidays ---------------------------------------------------------
  if (opts.includeHolidays) {
    const startYear = today.getFullYear()
    const endYear = horizon.getFullYear()
    for (let y = startYear; y <= endYear; y++) {
      for (const d of computeHolidayDates(state.policy, y)) {
        const name = getHolidayName(state.policy, d) ?? 'Holiday'
        events.push({
          uid: `holiday-${format(d, 'yyyyMMdd')}@${UID_DOMAIN}`,
          summary: `🎉 ${name}`,
          description: 'Paid holiday',
          date: d,
          categories: ['Holiday'],
        })
      }
    }
  }

  // --- Paydays ----------------------------------------------------------
  if (opts.includePaydays) {
    let payday = parseISO(state.profile.lastPaydayDate)
    const hireDate = parseISO(state.profile.hireDate)
    // Walk forward until we cross horizon; emit only paydays in the future.
    while (payday <= horizon) {
      if (payday >= today) {
        const yos = differenceInYears(payday, hireDate)
        const tier = computeAccrualTier(state.policy, yos)
        // Match forecasting and catch-up, including anniversary-crossing periods.
        const periodStart = addDays(payday, -state.policy.payPeriodLengthDays)
        const accrued = accrualForPeriod(state.policy, hireDate, periodStart, payday)
        events.push({
          uid: `payday-${format(payday, 'yyyyMMdd')}@${UID_DOMAIN}`,
          summary: `💰 Payday (+${fmtHrs(accrued)} hrs vacation)`,
          description: `Vacation accrual: +${fmtHrs(accrued)} hrs. Tier on payday: ${tier.label}.`,
          date: payday,
          categories: ['Payday'],
        })
      }
      payday = addDays(payday, state.policy.payPeriodLengthDays)
    }
  }

  // --- Carryover-cap payout date ---------------------------------------
  if (opts.includeCarryoverPayout && state.policy.carryoverCapStrategy !== 'unlimited') {
    const lastPayday = parseISO(state.profile.lastPaydayDate)
    const startYear = today.getFullYear()
    const endYear = horizon.getFullYear()
    for (let y = startYear; y <= endYear; y++) {
      const anchor = parseISO(
        `${y}-${String(state.policy.carryoverPayoutDate.month).padStart(
          2,
          '0',
        )}-${String(state.policy.carryoverPayoutDate.day).padStart(2, '0')}`,
      )
      const payoutDate = firstPaydayOnOrAfter(lastPayday, state.policy.payPeriodLengthDays, anchor)
      if (payoutDate < today || payoutDate > horizon) continue
      events.push({
        uid: `carryover-${y}@${UID_DOMAIN}`,
        summary: `📊 Vacation carryover payout date`,
        description:
          'Hours above the carryover cap are paid out on the first pay date in the configured payout window.',
        date: payoutDate,
        categories: ['Payout'],
      })
    }
  }

  // --- Bank hours payout -----------------------------------------------
  // Match both payout triggers in the balance engine. Preserve the existing
  // opening-date UID for identity compatibility with older exports; closing dates
  // get a distinct stable UID. Coincident payroll dates produce one event.
  if (opts.includeBankWindow && !state.policy.hideBankHours) {
    const startYear = today.getFullYear()
    const endYear = horizon.getFullYear()
    const lastPayday = parseISO(state.profile.lastPaydayDate)
    const seenDates = new Set<string>()
    const anchors = [
      { date: state.policy.bankHoursPayoutStart, kind: 'start' },
      { date: state.policy.bankHoursPayoutEnd, kind: 'end' },
    ] as const
    for (let y = startYear - 1; y <= endYear; y++) {
      for (const anchor of anchors) {
        const triggerDate = parseISO(
          `${y}-${String(anchor.date.month).padStart(2, '0')}-${String(anchor.date.day).padStart(2, '0')}`,
        )
        const payoutDate = firstPaydayOnOrAfter(
          lastPayday,
          state.policy.payPeriodLengthDays,
          triggerDate,
        )
        if (payoutDate < today || payoutDate > horizon) continue
        const iso = format(payoutDate, 'yyyy-MM-dd')
        if (seenDates.has(iso)) continue
        seenDates.add(iso)
        events.push({
          uid:
            anchor.kind === 'start'
              ? `bank-payout-${y}@${UID_DOMAIN}`
              : `bank-payout-end-${y}@${UID_DOMAIN}`,
          summary: '🏦 Bank hours payout',
          description: `Banked / overtime hours are paid out on this pay date — the first payday on or after the payout window ${anchor.kind === 'start' ? 'opens' : 'closes'}.`,
          date: payoutDate,
          categories: ['Bank'],
        })
      }
    }
  }

  // --- Work anniversaries / tier transitions ---------------------------
  if (opts.includeAnniversaries) {
    const hireDate = parseISO(state.profile.hireDate)
    for (let y = today.getFullYear(); y <= horizon.getFullYear(); y++) {
      const anniv = new Date(y, hireDate.getMonth(), hireDate.getDate())
      if (anniv < today || anniv > horizon) continue
      const yos = differenceInYears(anniv, hireDate)
      if (yos <= 0) continue
      // Find the tier just before and just after this anniversary; if they
      // differ, this is a tier transition.
      const before = computeAccrualTier(state.policy, yos - 1)
      const after = computeAccrualTier(state.policy, yos)
      if (before === after) {
        events.push({
          uid: `anniv-${y}@${UID_DOMAIN}`,
          summary: `🎂 Work anniversary (${yos} yr${yos === 1 ? '' : 's'})`,
          description: `${state.profile.displayName} — ${yos} year${yos === 1 ? '' : 's'} of service.`,
          date: anniv,
          categories: ['Anniversary'],
        })
      } else {
        events.push({
          uid: `tier-${y}@${UID_DOMAIN}`,
          summary: `📈 Accrual tier increase (${fmtHrs(before.hoursPerPayPeriod)} → ${fmtHrs(after.hoursPerPayPeriod)} hrs/period)`,
          description: `Work anniversary — ${yos} year${yos === 1 ? '' : 's'} of service. New tier: ${after.label}.`,
          date: anniv,
          categories: ['Anniversary', 'Tier'],
        })
      }
    }
  }

  return events
}

/**
 * Build a complete iCalendar (.ics) document for the given state and
 * options. Returns a string with CRLF line endings — caller writes it
 * to a Blob with type `text/calendar`.
 */
export function buildIcalString(state: AppState, opts: IcalExportOptions): string {
  const events = buildEvents(state, opts)
  const now = new Date()
  const dtstamp = formatUtc(now)
  // Retain the existing export-time hint for compatibility. It is not a
  // persisted per-event revision: same-second exports can repeat it, and a
  // clock correction can decrease it. It cannot ensure file-import deduplication.
  const sequence = Math.max(0, Math.floor((now.getTime() - Date.UTC(2020, 0, 1)) / 1000))
  const reminderDays = opts.reminderDaysBeforeTimeOff ?? 0

  const lines: string[] = []
  lines.push('BEGIN:VCALENDAR')
  lines.push('VERSION:2.0')
  lines.push('PRODID:-//Schedule Planner//EN')
  lines.push('METHOD:PUBLISH')
  lines.push('CALSCALE:GREGORIAN')
  lines.push(foldLine('X-WR-CALNAME:Schedule Planner'))
  lines.push(
    foldLine(
      'X-WR-CALDESC:Time off, holidays, paydays, and balance milestones from Schedule Planner',
    ),
  )
  // This is a downloaded snapshot, not a hosted calendar subscription. Timed
  // events use UTC; all-day events remain civil dates, without a timezone.

  for (const ev of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(foldLine(`UID:${escapeText(ev.uid)}`))
    lines.push(`DTSTAMP:${dtstamp}`)
    if (ev.startTime && ev.endTime) {
      lines.push(`DTSTART:${formatUtc(ev.startTime)}`)
      lines.push(`DTEND:${formatUtc(ev.endTime)}`)
    } else if (ev.date) {
      lines.push(`DTSTART;VALUE=DATE:${formatDate(ev.date)}`)
      // For single-day all-day events, DTEND is the next day (exclusive).
      lines.push(`DTEND;VALUE=DATE:${formatDate(addDays(ev.date, 1))}`)
    } else if (ev.startDate && ev.endDate) {
      lines.push(`DTSTART;VALUE=DATE:${formatDate(ev.startDate)}`)
      lines.push(`DTEND;VALUE=DATE:${formatDate(addDays(ev.endDate, 1))}`)
    }
    lines.push(foldLine(`SUMMARY:${escapeText(ev.summary)}`))
    if (ev.description) {
      lines.push(foldLine(`DESCRIPTION:${escapeText(ev.description)}`))
    }
    if (ev.categories && ev.categories.length > 0) {
      lines.push(foldLine(`CATEGORIES:${ev.categories.map(escapeText).join(',')}`))
      // RFC 7986 COLOR keyed off the primary category.
      const color = CATEGORY_COLORS[ev.categories[0]]
      if (color) lines.push(`COLOR:${color}`)
    }

    // Snapshot metadata does not instruct a file importer to replace or delete
    // events. No CREATED is emitted: original creation times are not stored.
    lines.push('STATUS:CONFIRMED')
    lines.push(`SEQUENCE:${sequence}`)
    lines.push('CLASS:PUBLIC')
    lines.push(`LAST-MODIFIED:${dtstamp}`)

    if (ev.oof) {
      // Preserve the existing Out-of-Office hint. Actual presence depends on
      // the destination calendar and the client's handling of imported events.
      lines.push('TRANSP:OPAQUE')
      lines.push('X-MICROSOFT-CDO-BUSYSTATUS:OOF')
      lines.push('X-MICROSOFT-CDO-INTENDEDSTATUS:OOF')
    } else {
      // Informational events (holidays, paydays, carryover/bank, anniversary/
      // tier) stay free so they never block the user's calendar. Holidays
      // could arguably be OOF, but we deliberately keep them FREE so an
      // imported holiday doesn't make the user look busy/out of office.
      lines.push('TRANSP:TRANSPARENT')
      lines.push('X-MICROSOFT-CDO-BUSYSTATUS:FREE')
    }
    lines.push(`X-MICROSOFT-CDO-ALLDAYEVENT:${ev.startTime ? 'FALSE' : 'TRUE'}`)

    // Reminder: only on *planned* (future) time off, never on logged-past
    // absences or informational events. Nested INSIDE the VEVENT.
    if (ev.planned && reminderDays > 0) {
      lines.push('BEGIN:VALARM')
      lines.push('ACTION:DISPLAY')
      lines.push(`TRIGGER:-P${reminderDays}D`)
      lines.push(foldLine(`DESCRIPTION:${escapeText(ev.summary)}`))
      lines.push('END:VALARM')
    }

    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

/**
 * Trigger a browser download of the iCalendar file. Returns the filename
 * used so the caller can confirm.
 */
export function downloadIcal(
  state: AppState,
  opts: IcalExportOptions = DEFAULT_ICAL_OPTIONS,
): string {
  const ics = buildIcalString(state, opts)
  const dateStr = getNowInZone(state.profile.timezone || 'America/New_York').isoDate
  const filename = `schedule-planner-${dateStr}.ics`
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return filename
}

/** Small helper used by the backup-nag UI: how many days of "looking ahead"
 *  the export covers, given a horizon of N years. We don't currently expose
 *  this in the UI but the function is here for tests. */
export function describeIcalHorizon(opts: IcalExportOptions): string {
  const y = Math.max(1, opts.yearsAhead)
  return `${y} year${y === 1 ? '' : 's'} ahead, ending ${format(endOfYear(addYears(new Date(), y - 1)), 'MMM d, yyyy')}`
}
