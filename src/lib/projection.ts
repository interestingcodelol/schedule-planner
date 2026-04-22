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
  subDays,
} from 'date-fns'
import type {
  AccrualTier,
  AppState,
  PlannedVacation,
  PolicyConfig,
  ProjectionEvent,
  ProjectionResult,
} from './types'
import { computeHolidayDates } from './holidays'
import { getNowInZone, isWorkDayOverInZone } from './timeUtils'

const DEFAULT_TZ = 'America/New_York'

function applyDeduction(
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
  pools: { vacation: number; sick: number; bank: number },
): void {
  if (source === 'vacation') {
    pools.vacation -= hours
    return
  }
  if (source === 'sick') {
    pools.sick -= hours
    return
  }
  if (source === 'bank') {
    pools.bank -= hours
    return
  }
  let remaining = hours
  const fromBank = Math.min(remaining, Math.max(0, pools.bank))
  pools.bank -= fromBank
  remaining -= fromBank
  if (remaining > 0) {
    const fromVaca = Math.min(remaining, Math.max(0, pools.vacation))
    pools.vacation -= fromVaca
    remaining -= fromVaca
  }
  if (remaining > 0) {
    const fromSick = Math.min(remaining, Math.max(0, pools.sick))
    pools.sick -= fromSick
  }
}

function resolveDeductHours(v: PlannedVacation, hoursPerWorkDay: number): number {
  if (v.actualHoursUsed !== undefined) return v.actualHoursUsed
  if (v.hoursPerDay !== undefined) return v.hoursPerDay
  return hoursPerWorkDay
}

/**
 * The user's currently-displayable balance, with same-day planned time off
 * applied only after the user's local end-of-work-day cutoff. `logged_past`
 * entries are excluded since they already mutated the stored balances when
 * created.
 */
export function getEffectiveCurrentBalances(state: AppState): {
  vacation: number
  sick: number
  bank: number
  total: number
} {
  const pools = {
    vacation: state.profile.currentVacationHours,
    sick: state.profile.currentSickHours,
    bank: state.profile.currentBankHours,
  }

  const tz = state.profile.timezone || DEFAULT_TZ
  const todayIsOver = isWorkDayOverInZone(tz, state.policy.hoursPerWorkDay)
  if (todayIsOver) {
    const isoToday = getNowInZone(tz).isoDate
    for (const v of state.plannedVacations) {
      if (v.kind === 'logged_past') continue
      if (v.startDate <= isoToday && v.endDate >= isoToday) {
        const hrs = resolveDeductHours(v, state.policy.hoursPerWorkDay)
        applyDeduction(hrs, v.hourSource || 'any', pools)
      }
    }
  }

  return {
    vacation: pools.vacation,
    sick: pools.sick,
    bank: pools.bank,
    total: pools.vacation + pools.sick + pools.bank,
  }
}

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
 * Project balances forward from today to a target date by walking the
 * chronological event stream: paydays (accruals), planned vacation deductions,
 * carryover cap adjustments, bank hours payouts, and annual sick grants.
 *
 * Tier transitions take effect on the first payday on or after the service
 * anniversary. Returns the final balances together with the full event trail.
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
  let totalShortfall = 0

  const tz = state.profile.timezone || DEFAULT_TZ
  const todayIsOver = isWorkDayOverInZone(tz, state.policy.hoursPerWorkDay)
  const earliestDeductDay = todayIsOver ? today : addDays(today, 1)

  if (state.bankHoursLog) {
    for (const entry of state.bankHoursLog) {
      const entryDate = parseISO(entry.date)
      if (isAfter(entryDate, today) && !isAfter(entryDate, target)) {
        bankBalance += entry.hours
      }
    }
  }

  if (!isAfter(target, today)) {
    const eff = getEffectiveCurrentBalances(state)
    return {
      vacationBalance: eff.vacation,
      sickBalance: eff.sick,
      bankBalance: eff.bank,
      totalAvailable: eff.total,
      carryoverAdjustment: 0,
      bankPayout: 0,
      shortfall: 0,
      events: [],
    }
  }

  const startYear = today.getFullYear()
  const endYear = target.getFullYear()
  const allHolidays: Date[] = []
  for (let y = startYear; y <= endYear; y++) {
    allHolidays.push(...computeHolidayDates(state.policy, y))
  }

  const futureVacations = state.plannedVacations.filter(
    (v) => v.kind !== 'logged_past' && !isBefore(parseISO(v.endDate), today),
  )

  const paydays = generatePaydays(lastPayday, target, state.policy.payPeriodLengthDays)

  type PendingEvent = {
    date: Date
    type: 'accrual' | 'vacation_deduction' | 'carryover_adjustment' | 'bank_payout' | 'sick_grant'
    process: () => number
    label?: string
    hourSource?: 'vacation' | 'sick' | 'bank' | 'any'
  }
  const pendingEvents: PendingEvent[] = []

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

  for (const vacation of futureVacations) {
    const vStart = parseISO(vacation.startDate)
    const vEnd = parseISO(vacation.endDate)
    const rangeStart = isBefore(vStart, earliestDeductDay) ? earliestDeductDay : vStart
    const rangeEnd = isAfter(vEnd, target) ? target : vEnd

    if (isAfter(rangeStart, rangeEnd)) continue

    const deductHours = resolveDeductHours(vacation, state.policy.hoursPerWorkDay)
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

  for (let y = startYear; y <= endYear + 1; y++) {
    const payoutStart = new Date(
      y,
      state.policy.bankHoursPayoutStart.month - 1,
      state.policy.bankHoursPayoutStart.day,
    )
    const payoutEnd = new Date(
      y,
      state.policy.bankHoursPayoutEnd.month - 1,
      state.policy.bankHoursPayoutEnd.day,
    )
    for (const payoutDate of [payoutStart, payoutEnd]) {
      if (isAfter(payoutDate, today) && !isAfter(payoutDate, target)) {
        pendingEvents.push({
          date: payoutDate,
          type: 'bank_payout',
          process: () => 0,
          label: `Bank hours payout (${format(payoutDate, 'MMM d')})`,
        })
      }
    }
  }

  for (let y = startYear + 1; y <= endYear; y++) {
    const grantDate = new Date(y, 0, 1) // January 1
    if (isAfter(grantDate, today) && !isAfter(grantDate, target)) {
      pendingEvents.push({
        date: grantDate,
        type: 'sick_grant',
        process: () => state.policy.sickLeaveAnnualGrant,
        label: `Annual sick leave grant (+${state.policy.sickLeaveAnnualGrant} hrs)`,
      })
    }
  }

  pendingEvents.sort((a, b) => {
    const dayDiff = differenceInCalendarDays(a.date, b.date)
    if (dayDiff !== 0) return dayDiff
    const order = { sick_grant: 0, accrual: 1, vacation_deduction: 2, carryover_adjustment: 3, bank_payout: 4 }
    return order[a.type] - order[b.type]
  })

  for (const pe of pendingEvents) {
    if (pe.type === 'sick_grant') {
      const carryoverCap = state.policy.sickLeaveCarryoverCap
      let forfeited = 0
      if (carryoverCap !== undefined && sickBalance > carryoverCap) {
        forfeited = sickBalance - carryoverCap
        sickBalance = carryoverCap
      }
      const grant = pe.process()
      const newBalance = Math.min(sickBalance + grant, state.policy.sickLeaveMaxBalance)
      const actualGrant = newBalance - sickBalance
      if (actualGrant > 0 || forfeited > 0) {
        sickBalance = newBalance
        events.push({
          date: format(pe.date, 'yyyy-MM-dd'),
          type: 'sick_grant',
          delta: actualGrant - forfeited,
          runningBalance: vacationBalance,
          label:
            forfeited > 0
              ? `${pe.label} (forfeited ${forfeited.toFixed(2)} hrs over carryover cap)`
              : pe.label,
        })
      }
    } else if (pe.type === 'carryover_adjustment') {
      const yos = differenceInYears(pe.date, hireDate)
      const tier = computeAccrualTier(state.policy, yos)
      const cap = computeCarryoverCap(state.policy, tier)

      if (cap !== null && vacationBalance > cap) {
        const adjustment = cap - vacationBalance
        const paidOut = Math.abs(adjustment)
        totalCarryoverAdjustment += paidOut
        vacationBalance = cap
        events.push({
          date: format(pe.date, 'yyyy-MM-dd'),
          type: 'carryover_adjustment',
          delta: adjustment,
          runningBalance: vacationBalance,
          label: `Carryover cap ${cap.toFixed(2)} hrs — ${paidOut.toFixed(2)} hrs paid out`,
        })
      }
    } else if (pe.type === 'bank_payout') {
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
      const hours = Math.abs(pe.process())
      const source = pe.hourSource || 'any'

      // Compute the pool capacity available to cover this deduction. Pools are
      // floored at 0 so a previously over-drawn explicit source doesn't subsidize
      // a later draw.
      const available =
        source === 'vacation'
          ? Math.max(0, vacationBalance)
          : source === 'sick'
            ? Math.max(0, sickBalance)
            : source === 'bank'
              ? Math.max(0, bankBalance)
              : Math.max(0, vacationBalance) + Math.max(0, sickBalance) + Math.max(0, bankBalance)
      if (hours > available) {
        totalShortfall += hours - available
      }

      const pools = { vacation: vacationBalance, sick: sickBalance, bank: bankBalance }
      applyDeduction(hours, source, pools)
      vacationBalance = pools.vacation
      sickBalance = pools.sick
      bankBalance = pools.bank

      events.push({
        date: format(pe.date, 'yyyy-MM-dd'),
        type: 'vacation_deduction',
        delta: -hours,
        runningBalance: vacationBalance,
        label: pe.label,
      })
    } else {
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
    shortfall: totalShortfall,
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

export type TripImpact = {
  /** Hours during the proposed trip's own range that cannot be covered, even
   *  after mid-trip accruals, the Jan 1 sick grant, the vacation carryover
   *  cap haircut, and the bank hours payout are applied in date order. */
  tripItselfShortfall: number
  /** Additional shortfall AFTER the trip ends — i.e. other planned time off
   *  that the proposed trip would push into deficit. */
  downstreamShortfall: number
  /** Total balance the moment the trip begins (excludes the trip's own
   *  deductions). */
  balanceBeforeTrip: number
  /** Total balance after the trip ends, with the trip applied AND every
   *  mid-trip event (sick grant, accruals, etc.) processed. */
  balanceAfterTrip: number
  /** Per-pool balances after the trip — useful for tooltips. */
  vacationAfterTrip: number
  sickAfterTrip: number
  bankAfterTrip: number
}

/**
 * Compute the additional shortfall a hypothetical trip would add to the
 * user's plan. Splits the answer into trip-itself vs. downstream so the UI
 * can distinguish "your trip doesn't fit" from "your trip pushes a later
 * trip into deficit."
 *
 * The diff against a baseline projection is what makes mid-trip events
 * (Jan 1 sick grant, paydays, Feb 1 carryover cap, bank payouts) flow
 * through correctly: each side runs the same event engine, so anything
 * that is NOT caused by adding the trip cancels out.
 */
export function analyzeTripImpact(
  state: AppState,
  proposedTrip: PlannedVacation,
  horizon: Date,
): TripImpact {
  const tripStart = parseISO(proposedTrip.startDate)
  const tripEnd = parseISO(proposedTrip.endDate)

  const stateWithTrip: AppState = {
    ...state,
    plannedVacations: [...state.plannedVacations, proposedTrip],
  }

  const baselineThruEnd = projectBalance(state, tripEnd)
  const withTripThruEnd = projectBalance(stateWithTrip, tripEnd)
  const tripItselfShortfall = Math.max(
    0,
    withTripThruEnd.shortfall - baselineThruEnd.shortfall,
  )

  const baselineHorizon = projectBalance(state, horizon)
  const withTripHorizon = projectBalance(stateWithTrip, horizon)
  const totalAdditional = Math.max(
    0,
    withTripHorizon.shortfall - baselineHorizon.shortfall,
  )
  const downstreamShortfall = Math.max(0, totalAdditional - tripItselfShortfall)

  const beforeTrip = projectBalance(state, subDays(tripStart, 1))

  return {
    tripItselfShortfall,
    downstreamShortfall,
    balanceBeforeTrip: beforeTrip.totalAvailable,
    balanceAfterTrip: withTripThruEnd.totalAvailable,
    vacationAfterTrip: withTripThruEnd.vacationBalance,
    sickAfterTrip: withTripThruEnd.sickBalance,
    bankAfterTrip: withTripThruEnd.bankBalance,
  }
}

/**
 * Find the earliest date the proposed trip could START — preserving its
 * calendar duration and other attributes — such that the trip itself causes
 * no shortfall. Walks forward by pay periods. Returns null if not reachable
 * within 3 years.
 *
 * Unlike `earliestAffordableDate`, this respects mid-trip replenishments:
 * a Dec 28 → Jan 5 trip funded by the Jan 1 sick grant is recognised as
 * affordable on its requested start date.
 */
export function earliestAffordableTripStart(
  state: AppState,
  proposedTrip: PlannedVacation,
  notBefore: Date,
): Date | null {
  const maxDate = addDays(new Date(), 365 * 3)
  const tripStart = parseISO(proposedTrip.startDate)
  const tripEnd = parseISO(proposedTrip.endDate)
  const durationDays = differenceInCalendarDays(tripEnd, tripStart)

  const tryStart = (candidate: Date): boolean => {
    const candidateEnd = addDays(candidate, durationDays)
    const shifted: PlannedVacation = {
      ...proposedTrip,
      startDate: format(candidate, 'yyyy-MM-dd'),
      endDate: format(candidateEnd, 'yyyy-MM-dd'),
    }
    const impact = analyzeTripImpact(state, shifted, candidateEnd)
    return impact.tripItselfShortfall === 0
  }

  const initial = startOfDay(notBefore)
  if (tryStart(initial)) return initial

  const lastPayday = parseISO(state.profile.lastPaydayDate)
  let payday = addDays(lastPayday, state.policy.payPeriodLengthDays)
  while (!isAfter(payday, initial)) {
    payday = addDays(payday, state.policy.payPeriodLengthDays)
  }

  while (!isAfter(payday, maxDate)) {
    if (tryStart(payday)) return payday
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
