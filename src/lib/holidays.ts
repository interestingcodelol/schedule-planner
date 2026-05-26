import {
  format,
  parseISO,
} from 'date-fns'
import type { HolidayRule, PolicyConfig } from './types'

/** Build a UTC-midnight Date for a (y, m, d) triple via parseISO of the
 *  formatted Y-M-D string. Holiday dates MUST be on the same basis as the
 *  rest of the engine (`parseISO('YYYY-MM-DD')` → UTC midnight); `new Date(y,
 *  m-1, d)` produces LOCAL midnight, a different instant that shifts the
 *  holiday onto the wrong calendar day for users behind UTC. */
function isoMidnight(year: number, month: number, day: number): Date {
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return parseISO(`${year}-${mm}-${dd}`)
}

/** Add (or subtract) whole days on the pure-UTC instant timeline — exactly
 *  24h per day, with no DST/local-time compensation. Keeps a UTC-midnight
 *  input on UTC midnight, so getUTCDay()/getUTCDate() stay exact. (date-fns
 *  addDays keeps LOCAL wall-clock constant and can drift an hour across a DST
 *  boundary, which we must avoid for holiday weekday math.) */
function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000)
}

/**
 * Compute the concrete date of a single holiday rule for a given year.
 * Returns the raw date (before weekend observance adjustment).
 *
 * All anchors are constructed on the UTC-midnight basis and all weekday
 * arithmetic uses getUTCDay so the result agrees with parseISO-derived dates
 * regardless of the runner/browser timezone.
 */
function computeRawHolidayDate(rule: HolidayRule, year: number): Date {
  switch (rule.type) {
    case 'fixed':
      return isoMidnight(year, rule.month, rule.day)

    case 'nth_weekday': {
      // Find the nth occurrence of a weekday in a month
      const firstOfMonth = isoMidnight(year, rule.month, 1)
      const firstDow = firstOfMonth.getUTCDay()
      let dayOffset = rule.weekday - firstDow
      if (dayOffset < 0) dayOffset += 7
      return addUtcDays(firstOfMonth, dayOffset + (rule.n - 1) * 7)
    }

    case 'last_weekday': {
      // Find the last occurrence of a weekday in a month. The last day of
      // the month = (first day of next month) minus 1 day, all on the UTC
      // basis. December (month 12) rolls into January of the next year.
      const nextMonth = rule.month === 12 ? 1 : rule.month + 1
      const nextMonthYear = rule.month === 12 ? year + 1 : year
      const firstOfNextMonth = isoMidnight(nextMonthYear, nextMonth, 1)
      const last = addUtcDays(firstOfNextMonth, -1)
      const lastDow = last.getUTCDay()
      let diff = lastDow - rule.weekday
      if (diff < 0) diff += 7
      return addUtcDays(last, -diff)
    }
  }
}

/**
 * Apply weekend observance policy to a holiday date.
 * "nearest_weekday": if Saturday, observe on Friday; if Sunday, observe on Monday.
 */
function applyWeekendObservance(
  date: Date,
  observance: 'nearest_weekday' | 'none',
): Date {
  if (observance === 'none') return date
  const dow = date.getUTCDay()
  if (dow === 6) return addUtcDays(date, -1) // Saturday -> Friday
  if (dow === 0) return addUtcDays(date, 1) // Sunday -> Monday
  return date
}

/**
 * Expand all holiday rules into concrete dates for a given year.
 *
 * Handles three edge cases that broke the naive map-and-observe path:
 *   1. Holidays that didn't exist yet (rule.startYear > year) are skipped.
 *   2. Two rules whose observed dates collide (e.g., Christmas Eve and
 *      Christmas Day both shifting onto the same Friday when Dec 25 is a
 *      Saturday) are deduped — calendar code only needs one entry per date.
 *   3. New Year's Day landing on a Saturday is observed on Dec 31 of the
 *      *previous* year. We include both the requested year's observed dates
 *      AND the requested year's Dec-31-spillover from year+1's New Year, so
 *      the boundary day shows as a holiday from whichever year's loop runs.
 */
export function computeHolidayDates(policy: PolicyConfig, year: number): Date[] {
  const seen = new Set<string>()
  const out: Date[] = []
  // Holiday dates are now UTC-midnight; read their calendar fields in UTC so
  // the year filter and dedup key match the construction basis.
  const push = (d: Date) => {
    if (d.getUTCFullYear() !== year) return
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(d)
  }
  for (const rule of policy.holidays) {
    if (rule.startYear !== undefined && rule.startYear > year) continue
    const raw = computeRawHolidayDate(rule, year)
    push(applyWeekendObservance(raw, rule.weekendObservance))
  }
  // Pull next year's Jan 1 observance back into this year if it landed on
  // Dec 31 (Saturday → Friday shift).
  for (const rule of policy.holidays) {
    if (rule.type !== 'fixed' || rule.month !== 1 || rule.day !== 1) continue
    if (rule.startYear !== undefined && rule.startYear > year + 1) continue
    const nextRaw = computeRawHolidayDate(rule, year + 1)
    const nextObserved = applyWeekendObservance(nextRaw, rule.weekendObservance)
    push(nextObserved)
  }
  return out
}

/**
 * Get holiday name for a given date, or undefined if not a holiday.
 */
export function getHolidayName(
  policy: PolicyConfig,
  date: Date,
): string | undefined {
  // Check the year the date is in, plus next year (for a Dec 31 New Year's
  // observance which belongs to year+1's rule but lands on year's calendar).
  // Compare on the UTC basis since computed holiday dates are UTC-midnight.
  const sameUtcDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  for (const checkYear of [date.getUTCFullYear(), date.getUTCFullYear() + 1]) {
    for (const rule of policy.holidays) {
      if (rule.startYear !== undefined && rule.startYear > checkYear) continue
      const raw = computeRawHolidayDate(rule, checkYear)
      const observed = applyWeekendObservance(raw, rule.weekendObservance)
      if (sameUtcDay(observed, date)) return rule.name
    }
  }
  return undefined
}

/**
 * Check if a date is a holiday.
 */
export function isHoliday(policy: PolicyConfig, date: Date): boolean {
  return getHolidayName(policy, date) !== undefined
}

/**
 * Format a holiday rule for display.
 */
export function formatHolidayRule(rule: HolidayRule): string {
  switch (rule.type) {
    case 'fixed':
      return `${rule.name} (${format(new Date(2000, rule.month - 1, rule.day), 'MMM d')})`
    case 'nth_weekday': {
      const ordinals = ['', '1st', '2nd', '3rd', '4th', '5th']
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const months = [
        '',
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ]
      return `${rule.name} (${ordinals[rule.n]} ${days[rule.weekday]} in ${months[rule.month]})`
    }
    case 'last_weekday': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const months = [
        '',
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ]
      return `${rule.name} (Last ${days[rule.weekday]} in ${months[rule.month]})`
    }
  }
}
