import {
  getDay,
  addDays,
  subDays,
  lastDayOfMonth,
  startOfMonth,
  isSameDay,
  format,
} from 'date-fns'
import type { HolidayRule, PolicyConfig } from './types'

/**
 * Compute the concrete date of a single holiday rule for a given year.
 * Returns the raw date (before weekend observance adjustment).
 */
function computeRawHolidayDate(rule: HolidayRule, year: number): Date {
  switch (rule.type) {
    case 'fixed':
      return new Date(year, rule.month - 1, rule.day)

    case 'nth_weekday': {
      // Find the nth occurrence of a weekday in a month
      const firstOfMonth = startOfMonth(new Date(year, rule.month - 1, 1))
      const firstDow = getDay(firstOfMonth)
      let dayOffset = rule.weekday - firstDow
      if (dayOffset < 0) dayOffset += 7
      return addDays(firstOfMonth, dayOffset + (rule.n - 1) * 7)
    }

    case 'last_weekday': {
      // Find the last occurrence of a weekday in a month
      const last = lastDayOfMonth(new Date(year, rule.month - 1, 1))
      const lastDow = getDay(last)
      let diff = lastDow - rule.weekday
      if (diff < 0) diff += 7
      return subDays(last, diff)
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
  const dow = getDay(date)
  if (dow === 6) return subDays(date, 1) // Saturday -> Friday
  if (dow === 0) return addDays(date, 1) // Sunday -> Monday
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
  const push = (d: Date) => {
    if (d.getFullYear() !== year) return
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
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
  for (const checkYear of [date.getFullYear(), date.getFullYear() + 1]) {
    for (const rule of policy.holidays) {
      if (rule.startYear !== undefined && rule.startYear > checkYear) continue
      const raw = computeRawHolidayDate(rule, checkYear)
      const observed = applyWeekendObservance(raw, rule.weekendObservance)
      if (isSameDay(observed, date)) return rule.name
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
