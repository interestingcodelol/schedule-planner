import {
  addDays,
  addYears,
  differenceInYears,
  endOfYear,
  format,
  parseISO,
  startOfDay,
} from 'date-fns'
import type { AppState } from './types'
import { computeHolidayDates, getHolidayName } from './holidays'
import {
  computeAccrualTier,
  firstPaydayOnOrAfter,
} from './projection'

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
}

/** Stable per-app domain so re-imports update existing events instead of
 *  duplicating. Outlook/Google match on UID. */
const UID_DOMAIN = 'schedule-planner.local'

/** RFC 5545 escaping for TEXT-typed properties. CRLF inside SUMMARY/DESCRIPTION
 *  must be encoded as `\n`; commas, semicolons, and backslashes must be
 *  escaped. We don't use control characters, so this is the full list. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

/** Fold long lines to 75 octets per RFC 5545. We're conservative and fold
 *  on character count — fine for ASCII subjects/descriptions which is all
 *  we generate. */
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  let i = 0
  while (i < line.length) {
    const chunk = line.slice(i, i + (i === 0 ? 75 : 74))
    parts.push(chunk)
    i += chunk.length
  }
  return parts.join('\r\n ')
}

function formatDate(d: Date): string {
  return format(d, 'yyyyMMdd')
}

function fmtHrs(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
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
  categories?: string[]
}

function buildEvents(state: AppState, opts: IcalExportOptions): RawEvent[] {
  const events: RawEvent[] = []
  const today = startOfDay(new Date())
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
      const sourceLabel =
        v.hourSource === 'any'
          ? 'auto'
          : v.hourSource
      const summary = isLogged
        ? `Time off (logged) ${v.note ? '— ' + v.note : ''}`.trim()
        : `Time off ${v.note ? '— ' + v.note : ''}`.trim()
      const descriptionLines = [
        v.note ? `Note: ${v.note}` : '',
        partial
          ? `Partial day: ${fmtHrs(hrsPerDay)} hrs/day`
          : `Full day: ${fmtHrs(hrsPerDay)} hrs`,
        `Source: ${sourceLabel}`,
      ].filter(Boolean)
      events.push({
        uid: `vacation-${v.id}@${UID_DOMAIN}`,
        summary,
        description: descriptionLines.join('\n'),
        startDate: start,
        endDate: end,
        categories: ['Time Off'],
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
        events.push({
          uid: `payday-${format(payday, 'yyyyMMdd')}@${UID_DOMAIN}`,
          summary: `💰 Payday (+${fmtHrs(tier.hoursPerPayPeriod)} hrs vacation)`,
          description: `Vacation accrual at ${tier.label}: +${fmtHrs(
            tier.hoursPerPayPeriod,
          )} hrs.`,
          date: payday,
          categories: ['Payday'],
        })
      }
      payday = addDays(payday, state.policy.payPeriodLengthDays)
    }
  }

  // --- Carryover-cap payout date ---------------------------------------
  if (
    opts.includeCarryoverPayout &&
    state.policy.carryoverCapStrategy !== 'unlimited'
  ) {
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
      const payoutDate = firstPaydayOnOrAfter(
        lastPayday,
        state.policy.payPeriodLengthDays,
        anchor,
      )
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

  // --- Bank payout window ----------------------------------------------
  if (opts.includeBankWindow) {
    const startYear = today.getFullYear()
    const endYear = horizon.getFullYear()
    const startM = state.policy.bankHoursPayoutStart.month
    const startD = state.policy.bankHoursPayoutStart.day
    const endM = state.policy.bankHoursPayoutEnd.month
    const endD = state.policy.bankHoursPayoutEnd.day
    const wraps =
      endM < startM || (endM === startM && endD < startD)
    for (let y = startYear; y <= endYear; y++) {
      const winStart = parseISO(
        `${y}-${String(startM).padStart(2, '0')}-${String(startD).padStart(2, '0')}`,
      )
      const winEnd = parseISO(
        `${wraps ? y + 1 : y}-${String(endM).padStart(2, '0')}-${String(endD).padStart(2, '0')}`,
      )
      if (winStart > horizon) continue
      if (winEnd < today) continue
      events.push({
        uid: `bank-window-${y}@${UID_DOMAIN}`,
        summary: '🏦 Bank hours payout window',
        description: 'Bank hours can be paid out during this window.',
        startDate: winStart,
        endDate: winEnd,
        categories: ['Bank'],
      })
    }
  }

  // --- Work anniversaries / tier transitions ---------------------------
  if (opts.includeAnniversaries) {
    const hireDate = parseISO(state.profile.hireDate)
    for (let y = today.getFullYear(); y <= horizon.getFullYear(); y++) {
      const anniv = new Date(
        y,
        hireDate.getMonth(),
        hireDate.getDate(),
      )
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
export function buildIcalString(
  state: AppState,
  opts: IcalExportOptions,
): string {
  const events = buildEvents(state, opts)
  const now = new Date()
  const dtstamp =
    format(now, "yyyyMMdd'T'HHmmss") + 'Z'

  const lines: string[] = []
  lines.push('BEGIN:VCALENDAR')
  lines.push('VERSION:2.0')
  lines.push('PRODID:-//Schedule Planner//EN')
  lines.push('METHOD:PUBLISH')
  lines.push('CALSCALE:GREGORIAN')
  lines.push(foldLine('X-WR-CALNAME:Schedule Planner'))
  lines.push(
    foldLine('X-WR-CALDESC:Time off, holidays, paydays, and balance milestones from Schedule Planner'),
  )

  for (const ev of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${ev.uid}`)
    lines.push(`DTSTAMP:${dtstamp}`)
    if (ev.date) {
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
    }
    lines.push('TRANSP:TRANSPARENT')
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
  const dateStr = format(new Date(), 'yyyy-MM-dd')
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
