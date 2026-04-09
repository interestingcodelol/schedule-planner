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
 */
export function computeHolidayDates(policy: PolicyConfig, year: number): Date[] {
  return policy.holidays.map((rule) => {
    const raw = computeRawHolidayDate(rule, year)
    return applyWeekendObservance(raw, rule.weekendObservance)
  })
}

/**
 * Get holiday name for a given date, or undefined if not a holiday.
 */
export function getHolidayName(
  policy: PolicyConfig,
  date: Date,
): string | undefined {
  const year = date.getFullYear()
  for (const rule of policy.holidays) {
    const raw = computeRawHolidayDate(rule, year)
    const observed = applyWeekendObservance(raw, rule.weekendObservance)
    if (isSameDay(observed, date)) {
      return rule.name
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
