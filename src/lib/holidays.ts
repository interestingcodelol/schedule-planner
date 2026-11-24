import {
  addDays,
  format,
} from 'date-fns'
import type { HolidayRule, PolicyConfig } from './types'

/** Build a LOCAL-midnight Date for a (y, m, d) civil-date triple. Every
 *  date-only value in the app is a civil date (no time component): it's
 *  constructed at local midnight AND read back with the LOCAL getters
 *  (getDay/getFullYear/getMonth/getDate), so the civil date round-trips
 *  exactly in ANY timezone. (Reading these with getUTC* — as the engine used
 *  to — only agreed with the civil date at UTC/behind-UTC offsets, so it
 *  shifted holidays onto the wrong day for users east of UTC.) */
function isoMidnight(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day)
}

/**
 * Compute the concrete date of a single holiday rule for a given year.
 * Returns the raw date (before weekend observance adjustment).
 *
 * All anchors are constructed at local midnight and all weekday arithmetic
 * uses getDay/addDays (DST-safe, wall-clock based) so the civil date is exact
 * regardless of the runner/browser timezone.
 */
function computeRawHolidayDate(rule: HolidayRule, year: number): Date {
  switch (rule.type) {
    case 'fixed':
      return isoMidnight(year, rule.month, rule.day)

    case 'nth_weekday': {
      // "Day after Thanksgiving" has historically been stored as the 4th
      // Friday of November, which is wrong whenever November starts on a
      // Friday (2024, 2030, 2035…): the 4th Friday then falls BEFORE
      // Thanksgiving. Interpret that legacy shape as the Friday after the 4th
      // Thursday so saved policies stay correct without rewriting user data.
      if (isLegacyDayAfterThanksgiving(rule)) {
        return addDays(computeRawHolidayDate({ ...rule, weekday: 4, name: 'Thanksgiving Day' }, year), 1)
      }
      // Find the nth occurrence of a weekday in a month
      const firstOfMonth = isoMidnight(year, rule.month, 1)
      const firstDow = firstOfMonth.getDay()
      let dayOffset = rule.weekday - firstDow
      if (dayOffset < 0) dayOffset += 7
      return addDays(firstOfMonth, dayOffset + (rule.n - 1) * 7)
    }

    case 'last_weekday': {
      // Find the last occurrence of a weekday in a month. The last day of
      // the month = (first day of next month) minus 1 day. December (month
      // 12) rolls into January of the next year.
      const nextMonth = rule.month === 12 ? 1 : rule.month + 1
      const nextMonthYear = rule.month === 12 ? year + 1 : year
      const firstOfNextMonth = isoMidnight(nextMonthYear, nextMonth, 1)
      const last = addDays(firstOfNextMonth, -1)
      const lastDow = last.getDay()
      let diff = lastDow - rule.weekday
      if (diff < 0) diff += 7
      return addDays(last, -diff)
    }
  }
}

/** The legacy "Day after Thanksgiving" rule shape: 4th Friday of November. */
function isLegacyDayAfterThanksgiving(rule: HolidayRule): boolean {
  return (
    rule.type === 'nth_weekday' &&
    rule.month === 11 &&
    rule.weekday === 5 &&
    rule.n === 4 &&
    /thanksgiving/i.test(rule.name)
  )
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
  const dow = date.getDay()
  if (dow === 6) return addDays(date, -1) // Saturday -> Friday
  if (dow === 0) return addDays(date, 1) // Sunday -> Monday
  return date
}

type ObservedHoliday = { date: Date; name: string }

const civilKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/**
 * Observed holidays for the rules of `year - 1`, `year` and `year + 1`, with
 * weekend observance applied and collisions resolved.
 *
 * A collision happens when a weekend-shifted holiday lands on another
 * holiday — e.g. in 2027 Christmas Day (Sat) shifts onto Christmas Eve (Fri),
 * and in 2028 Christmas Eve (Sun) shifts onto Christmas Day (Mon). Dropping
 * one of them would silently take a paid holiday away (and charge PTO for a
 * day the employee is actually off), so the shifted holiday keeps moving in
 * its shift direction to the next free weekday instead: Christmas 2027 is
 * observed Thu Dec 23, Christmas Eve 2028 Tue Dec 26. Holidays on their real
 * date claim their day first. Two rules on the same real date (a duplicate
 * rule) are still deduped.
 *
 * Neighbouring rule-years are included so a shift across Jan 1 (New Year's
 * Day on a Saturday is observed Dec 31 of the previous year) lands on the
 * right calendar year.
 */
function observedHolidaysAround(policy: PolicyConfig, year: number): ObservedHoliday[] {
  type Candidate = { raw: Date; observed: Date; name: string; order: number }
  const candidates: Candidate[] = []
  let order = 0
  for (const ruleYear of [year - 1, year, year + 1]) {
    for (const rule of policy.holidays) {
      if (rule.startYear !== undefined && rule.startYear > ruleYear) continue
      const raw = computeRawHolidayDate(rule, ruleYear)
      const observed = applyWeekendObservance(raw, rule.weekendObservance)
      candidates.push({ raw, observed, name: rule.name, order: order++ })
    }
  }
  const shifted = (c: Candidate) => civilKey(c.raw) !== civilKey(c.observed)
  // Real-date holidays first; then shifted ones in date order.
  candidates.sort((a, b) => {
    const sa = shifted(a) ? 1 : 0
    const sb = shifted(b) ? 1 : 0
    if (sa !== sb) return sa - sb
    return a.observed.getTime() - b.observed.getTime() || a.order - b.order
  })
  const taken = new Set<string>()
  const seenRules = new Set<string>()
  const out: ObservedHoliday[] = []
  for (const c of candidates) {
    // A duplicated rule (same real and observed date) is one holiday, not two.
    const ruleKey = `${civilKey(c.raw)}>${civilKey(c.observed)}`
    if (seenRules.has(ruleKey)) continue
    seenRules.add(ruleKey)
    let date = c.observed
    if (taken.has(civilKey(date))) {
      if (!shifted(c)) continue // duplicate rule on the same real date
      const step = c.observed.getTime() < c.raw.getTime() ? -1 : 1
      let guard = 0
      do {
        date = addDays(date, step)
        guard++
      } while (guard < 14 && (date.getDay() === 0 || date.getDay() === 6 || taken.has(civilKey(date))))
      if (guard >= 14) continue
    }
    taken.add(civilKey(date))
    out.push({ date, name: c.name })
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime())
}

/** Observed holidays (date + name) that fall on the given calendar year. */
export function getObservedHolidays(policy: PolicyConfig, year: number): ObservedHoliday[] {
  return observedHolidaysAround(policy, year).filter((h) => h.date.getFullYear() === year)
}

/**
 * Expand all holiday rules into concrete observed dates for a given year.
 *
 * Handles the edge cases that broke the naive map-and-observe path:
 *   1. Holidays that didn't exist yet (rule.startYear > year) are skipped.
 *   2. Two holidays whose observed dates collide (e.g., Christmas Eve and
 *      Christmas Day when Dec 25 is a Saturday) both stay — the shifted one
 *      moves to the next free weekday (see observedHolidaysAround).
 *   3. New Year's Day landing on a Saturday is observed on Dec 31 of the
 *      *previous* year, so it appears in that year's list (and not in its own).
 */
export function computeHolidayDates(policy: PolicyConfig, year: number): Date[] {
  return getObservedHolidays(policy, year).map((h) => h.date)
}

/**
 * Get holiday name for a given date, or undefined if not a holiday.
 */
export function getHolidayName(
  policy: PolicyConfig,
  date: Date,
): string | undefined {
  const key = civilKey(date)
  return getObservedHolidays(policy, date.getFullYear()).find((h) => civilKey(h.date) === key)?.name
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
      if (isLegacyDayAfterThanksgiving(rule)) return `${rule.name} (Fri after 4th Thu in Nov)`
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
