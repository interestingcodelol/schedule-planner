import {
  addDays,
  differenceInCalendarDays,
  differenceInYears,
  eachDayOfInterval,
  format,
  getDay,
  isAfter,
  isBefore,
  isSameDay,
  parseISO,
  startOfDay,
} from 'date-fns'
import type {
  AccrualTier,
  AppState,
  PolicyConfig,
  ProjectionEvent,
  ProjectionResult,
} from './types'
import { computeHolidayDates } from './holidays'

/**
 * Determine which accrual tier applies based on years of service.
 * Tiers are matched by [minYears, maxYears). A null maxYears means unbounded.
 */
export function computeAccrualTier(
  policy: PolicyConfig,
  yearsOfService: number,
): AccrualTier {
  for (const tier of policy.accrualTiers) {
    if (
      yearsOfService >= tier.minYears &&
      (tier.maxYears === null || yearsOfService < tier.maxYears)
    ) {
      return tier
    }
  }
  return policy.accrualTiers[policy.accrualTiers.length - 1]
}

/**
 * Generate all payday dates from a starting payday forward to (and including) a target date.
 */
function generatePaydays(
  lastPayday: Date,
  targetDate: Date,
  periodDays: number,
): Date[] {
  const paydays: Date[] = []
  let current = addDays(lastPayday, periodDays)
  while (!isAfter(current, targetDate)) {
    paydays.push(current)
    current = addDays(current, periodDays)
  }
  return paydays
}

/**
 * Check if a date is a work day (in workDaysPerWeek and not a holiday).
 */
function isWorkDay(date: Date, policy: PolicyConfig, holidays: Date[]): boolean {
  const dow = getDay(date)
  if (!policy.workDaysPerWeek.includes(dow)) return false
  return !holidays.some((h) => isSameDay(h, date))
}

/**
 * Compute the carryover cap in hours based on the policy strategy and current tier.
 */
function computeCarryoverCap(
  policy: PolicyConfig,
  tier: AccrualTier,
): number | null {
  switch (policy.carryoverCapStrategy) {
    case 'unlimited':
      return null
    case 'fixed_hours':
      return policy.carryoverFixedCap ?? 0
    case 'annual_accrual': {
      const periodsPerYear = Math.round(365 / policy.payPeriodLengthDays)
      return tier.hoursPerPayPeriod * periodsPerYear
    }
  }
}

/**
 * Check if a date falls within the bank hours payout window.
 * The payout window can span across year boundary (e.g., Dec 15 -> Feb 15).
 */
function isInBankPayoutWindow(date: Date, policy: PolicyConfig): boolean {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const startM = policy.bankHoursPayoutStart.month
  const startD = policy.bankHoursPayoutStart.day
  const endM = policy.bankHoursPayoutEnd.month
  const endD = policy.bankHoursPayoutEnd.day

  const dateVal = month * 100 + day
  const startVal = startM * 100 + startD
  const endVal = endM * 100 + endD

  if (startVal <= endVal) {
    // Same year range (e.g., Mar 1 -> Jun 1)
    return dateVal >= startVal && dateVal <= endVal
  } else {
    // Spans year boundary (e.g., Dec 15 -> Feb 15)
    return dateVal >= startVal || dateVal <= endVal
  }
}

/**
 * Project vacation balance forward from today to a target date.
 *
 * Algorithm:
 * 1. Start from profile.currentVacationHours on today.
 * 2. Generate all payday boundaries from lastPaydayDate forward to targetDate.
 * 3. For each payday, determine accrual tier based on years since hireDate.
 *    IMPORTANT: Tier transitions take effect on the FIRST payday that falls on
 *    or after the anniversary date.
 * 4. For each planned vacation day, deduct hoursPerWorkDay if the day is a work
 *    day and falls in a planned range. Hours come from the specified source pool
 *    (vacation, sick, bank, or "any" which uses vacation first, then sick, then bank).
 * 5. On each carryoverPayoutDate, if balance exceeds cap, reduce to cap.
 * 6. On the bank hours payout start date, bank hours are zeroed (paid out).
 * 7. Return final balances and complete event trail.
 */
export function projectBalance(
  state: AppState,
  targetDate: Date,
): ProjectionResult {
  const today = startOfDay(new Date())
  const target = startOfDay(targetDate)
  const hireDate = parseISO(state.profile.hireDate)
  const lastPayday = parseISO(state.profile.lastPaydayDate)

  const events: ProjectionEvent[] = []
  let vacationBalance = state.profile.currentVacationHours
  let sickBalance = state.profile.currentSickHours
  let bankBalance = state.profile.currentBankHours
  let totalCarryoverAdjustment = 0
  let totalBankPayout = 0

  // Add future bank log entries to bankBalance
  if (state.bankHoursLog) {
    for (const entry of state.bankHoursLog) {
      const entryDate = parseISO(entry.date)
      if (isAfter(entryDate, today) && !isAfter(entryDate, target)) {
        bankBalance += entry.hours
      }
    }
  }

  // If target is today or in the past, return current state
  if (!isAfter(target, today)) {
    const total = vacationBalance + sickBalance + bankBalance
    return {
      vacationBalance,
      sickBalance,
      bankBalance,
      totalAvailable: total,
      carryoverAdjustment: 0,
      bankPayout: 0,
      events: [],
    }
  }

  // Collect holidays for all years in the projection range
  const startYear = today.getFullYear()
  const endYear = target.getFullYear()
  const allHolidays: Date[] = []
  for (let y = startYear; y <= endYear; y++) {
    allHolidays.push(...computeHolidayDates(state.policy, y))
  }

  // Only consider future planned vacations
  const futureVacations = state.plannedVacations.filter(
    (v) => !isBefore(parseISO(v.endDate), today),
  )

  const paydays = generatePaydays(lastPayday, target, state.policy.payPeriodLengthDays)

  type PendingEvent = {
    date: Date
    type: 'accrual' | 'vacation_deduction' | 'carryover_adjustment' | 'bank_payout'
    process: () => number
    label?: string
    hourSource?: 'vacation' | 'sick' | 'bank' | 'any'
  }
  const pendingEvents: PendingEvent[] = []

  // Add accrual events
  for (const payday of paydays) {
    if (!isAfter(payday, today)) continue
    pendingEvents.push({
      date: payday,
      type: 'accrual',
      process: () => {
        const yos = differenceInYears(payday, hireDate)
        const tier = computeAccrualTier(state.policy, yos)
        return tier.hoursPerPayPeriod
      },
      label: 'Vacation accrual',
    })
  }

  // Add vacation deduction events
  for (const vacation of futureVacations) {
    const vStart = parseISO(vacation.startDate)
    const vEnd = parseISO(vacation.endDate)
    const rangeStart = isAfter(vStart, today) ? vStart : addDays(today, 1)
    const rangeEnd = isAfter(vEnd, target) ? target : vEnd

    if (isAfter(rangeStart, rangeEnd)) continue

    const deductHours = vacation.hoursPerDay ?? state.policy.hoursPerWorkDay
    const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd })
    for (const day of days) {
      if (isWorkDay(day, state.policy, allHolidays)) {
        pendingEvents.push({
          date: day,
          type: 'vacation_deduction',
          process: () => -deductHours,
          label: vacation.note || 'Planned time off',
          hourSource: vacation.hourSource || 'any',
        })
      }
    }
  }

  // Add carryover payout events
  for (let y = startYear; y <= endYear; y++) {
    const payoutDate = new Date(
      y,
      state.policy.carryoverPayoutDate.month - 1,
      state.policy.carryoverPayoutDate.day,
    )
    if (isAfter(payoutDate, today) && !isAfter(payoutDate, target)) {
      pendingEvents.push({
        date: payoutDate,
        type: 'carryover_adjustment',
        process: () => 0,
        label: 'Carryover cap adjustment',
      })
    }
  }

  // Add bank hours payout events (start of payout window each year)
  for (let y = startYear; y <= endYear; y++) {
    const bankPayoutDate = new Date(
      y,
      state.policy.bankHoursPayoutStart.month - 1,
      state.policy.bankHoursPayoutStart.day,
    )
    if (isAfter(bankPayoutDate, today) && !isAfter(bankPayoutDate, target)) {
      pendingEvents.push({
        date: bankPayoutDate,
        type: 'bank_payout',
        process: () => 0,
        label: 'Bank hours payout',
      })
    }
  }

  // Sort events chronologically
  pendingEvents.sort((a, b) => {
    const dayDiff = differenceInCalendarDays(a.date, b.date)
    if (dayDiff !== 0) return dayDiff
    const order = { accrual: 0, vacation_deduction: 1, carryover_adjustment: 2, bank_payout: 3 }
    return order[a.type] - order[b.type]
  })

  // Process events
  for (const pe of pendingEvents) {
    if (pe.type === 'carryover_adjustment') {
      const yos = differenceInYears(pe.date, hireDate)
      const tier = computeAccrualTier(state.policy, yos)
      const cap = computeCarryoverCap(state.policy, tier)

      if (cap !== null && vacationBalance > cap) {
        const adjustment = cap - vacationBalance
        totalCarryoverAdjustment += Math.abs(adjustment)
        vacationBalance = cap
        events.push({
          date: format(pe.date, 'yyyy-MM-dd'),
          type: 'carryover_adjustment',
          delta: adjustment,
          runningBalance: vacationBalance,
          label: `Carryover cap: ${cap.toFixed(2)} hrs`,
        })
      }
    } else if (pe.type === 'bank_payout') {
      // Bank hours get paid out — balance goes to zero
      if (bankBalance > 0) {
        const payout = bankBalance
        totalBankPayout += payout
        bankBalance = 0
        events.push({
          date: format(pe.date, 'yyyy-MM-dd'),
          type: 'bank_payout',
          delta: -payout,
          runningBalance: vacationBalance,
          label: `Bank hours paid out: ${payout.toFixed(2)} hrs`,
        })
      }
    } else if (pe.type === 'vacation_deduction') {
      const hours = state.policy.hoursPerWorkDay
      const source = pe.hourSource || 'any'

      // Deduct from the appropriate pool
      if (source === 'vacation') {
        vacationBalance -= hours
      } else if (source === 'sick') {
        sickBalance -= hours
      } else if (source === 'bank') {
        bankBalance -= hours
      } else {
        // "any" — use bank first (use-it-or-lose-it), then vacation, then sick
        let remaining = hours
        const fromBank = Math.min(remaining, Math.max(0, bankBalance))
        bankBalance -= fromBank
        remaining -= fromBank
        if (remaining > 0) {
          const fromVaca = Math.min(remaining, Math.max(0, vacationBalance))
          vacationBalance -= fromVaca
          remaining -= fromVaca
        }
        if (remaining > 0) {
          sickBalance -= remaining
        }
      }

      events.push({
        date: format(pe.date, 'yyyy-MM-dd'),
        type: 'vacation_deduction',
        delta: -hours,
        runningBalance: vacationBalance,
        label: pe.label,
      })
    } else {
      // Accrual
      const delta = pe.process()
      vacationBalance += delta
      events.push({
        date: format(pe.date, 'yyyy-MM-dd'),
        type: pe.type,
        delta,
        runningBalance: vacationBalance,
        label: pe.label,
      })
    }
  }

  return {
    vacationBalance,
    sickBalance,
    bankBalance,
    totalAvailable: vacationBalance + sickBalance + bankBalance,
    carryoverAdjustment: totalCarryoverAdjustment,
    bankPayout: totalBankPayout,
    events,
  }
}

/**
 * Find the earliest date on or after `notBefore` where the total available
 * balance reaches `hoursNeeded`. Walks forward pay period by pay period.
 * Returns null if not reachable within 3 years.
 */
export function earliestAffordableDate(
  state: AppState,
  hoursNeeded: number,
  notBefore: Date,
): Date | null {
  const maxDate = addDays(new Date(), 365 * 3)
  const lastPayday = parseISO(state.profile.lastPaydayDate)
  const checkDate = startOfDay(notBefore)

  const initial = projectBalance(state, checkDate)
  if (initial.totalAvailable >= hoursNeeded) return checkDate

  let payday = addDays(lastPayday, state.policy.payPeriodLengthDays)
  while (!isAfter(payday, checkDate)) {
    payday = addDays(payday, state.policy.payPeriodLengthDays)
  }

  while (!isAfter(payday, maxDate)) {
    const result = projectBalance(state, payday)
    if (result.totalAvailable >= hoursNeeded) return payday
    payday = addDays(payday, state.policy.payPeriodLengthDays)
  }

  return null
}

/**
 * Calculate the number of work days in a date range, excluding holidays and non-work days.
 */
export function countWorkDays(
  startDate: Date,
  endDate: Date,
  policy: PolicyConfig,
): number {
  if (isAfter(startDate, endDate)) return 0
  const holidays = computeHolidayDates(policy, startDate.getFullYear())
  const holidays2 =
    startDate.getFullYear() !== endDate.getFullYear()
      ? computeHolidayDates(policy, endDate.getFullYear())
      : []
  const allHolidays = [...holidays, ...holidays2]

  const days = eachDayOfInterval({ start: startDate, end: endDate })
  return days.filter((d) => isWorkDay(d, policy, allHolidays)).length
}

/**
 * Get the next payday date after today.
 */
export function getNextPayday(lastPayday: Date, periodDays: number): Date {
  const today = startOfDay(new Date())
  let next = addDays(lastPayday, periodDays)
  while (!isAfter(next, today)) {
    next = addDays(next, periodDays)
  }
  return next
}

/**
 * Check if a date is in the bank hours payout window.
 */
export { isInBankPayoutWindow }
