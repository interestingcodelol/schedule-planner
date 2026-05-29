import {
  addDays,
  differenceInCalendarDays,
  differenceInYears,
  eachDayOfInterval,
  format,
  isAfter,
  isBefore,
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

/** Round to 2 decimals at the API boundary. Accumulation stays full-precision;
 *  only the RETURNED numbers are rounded so the UI never shows a float tail
 *  like 71.53999999999999. */
const r2 = (n: number): number => Math.round(n * 100) / 100

/** Two accrual tiers are "the same" when their resolved rate AND tenure floor
 *  match — by VALUE, not object identity. The policy is JSON-serialized to
 *  localStorage, so after a reload `===` would never hold between two tier
 *  objects even when they represent the identical tier. */
function sameTier(a: AccrualTier, b: AccrualTier): boolean {
  return a.hoursPerPayPeriod === b.hoursPerPayPeriod && a.minYears === b.minYears
}

/** Build a LOCAL-midnight Date for a (y, m, d) civil-date triple. Every
 *  date-only value is a civil date: constructed at local midnight and read
 *  back with the LOCAL getters, so it round-trips exactly in any timezone.
 *  (parseISO('YYYY-MM-DD') is also local midnight in date-fns v4, so streams
 *  built from stored date strings share this basis.) */
function isoMidnight(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day)
}

function applyDeduction(
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
  pools: { vacation: number; sick: number; bank: number },
): void {
  // Explicit sources floor at 0 like the 'any' branch already does — a
  // shortfall on an explicit pool shouldn't drag that pool negative; the
  // shortfall is tracked separately by the caller.
  if (source === 'vacation') {
    pools.vacation = Math.max(0, pools.vacation - hours)
    return
  }
  if (source === 'sick') {
    pools.sick = Math.max(0, pools.sick - hours)
    return
  }
  if (source === 'bank') {
    pools.bank = Math.max(0, pools.bank - hours)
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

function resolveDeductHours(
  v: PlannedVacation,
  hoursPerWorkDay: number,
  workDays: number,
): number {
  // `actualHoursUsed` is the ENTRY TOTAL across all work days (see types.ts);
  // spread it to a per-work-day figure. Mirrors catchUp.ts so projection and
  // the persisted balance stay in lockstep.
  if (v.actualHoursUsed !== undefined) {
    return workDays > 0 ? v.actualHoursUsed / workDays : v.actualHoursUsed
  }
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
  const isoToday = getNowInZone(tz).isoDate
  for (const v of state.plannedVacations) {
    if (v.kind === 'logged_past') continue
    // Only entries that SPAN today need same-day handling. Fully-past entries
    // are already booked into the stored balance by catch-up; fully-future
    // ones don't affect today.
    if (!(v.startDate <= isoToday && v.endDate >= isoToday)) continue

    const vStart = parseISO(v.startDate)
    const vEnd = parseISO(v.endDate)
    // catch-up only books a vacation once it has FULLY ended, so for a
    // multi-day entry that merely spans today the stored balance reflects NONE
    // of its elapsed days. Deduct every elapsed work day (days before today are
    // fully elapsed; today counts only once its work day is over) so the
    // displayed balance matches what catch-up will book the next morning —
    // instead of silently dropping by (elapsed days − 1) on the next reopen.
    const holidays: Date[] = []
    for (
      let y = vStart.getFullYear();
      y <= parseISO(isoToday).getFullYear();
      y++
    ) {
      holidays.push(...computeHolidayDates(state.policy, y))
    }
    const entryWorkDays = countWorkDays(vStart, vEnd, state.policy)
    const perDay = resolveDeductHours(v, state.policy.hoursPerWorkDay, entryWorkDays)
    for (const day of eachDayOfInterval({ start: vStart, end: vEnd })) {
      const dayIso = format(day, 'yyyy-MM-dd')
      if (dayIso > isoToday) break
      if (dayIso === isoToday && !todayIsOver) continue
      if (!isWorkDay(day, state.policy, holidays)) continue
      applyDeduction(perDay, v.hourSource || 'any', pools)
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
 * Vacation hours accrued for a single pay period ending on `payday`, with
 * proration when a service anniversary (tier transition) falls inside the
 * period: portion-of-period in the old tier × old rate + remainder × new rate.
 *
 * This is the single source of truth for per-period accrual. Both the
 * projection's accrual path AND catchUp's payday loop call it so the persisted
 * balance can never drift from the projected one over an anniversary period.
 *
 * The logic here reproduces projection's previous inline behaviour exactly,
 * so projection's numeric output is unchanged.
 */
export function accrualForPeriod(
  policy: PolicyConfig,
  hireDate: Date,
  periodStart: Date,
  payday: Date,
): number {
  const periodDays = differenceInCalendarDays(payday, periodStart)
  if (periodDays <= 0) {
    const yos = differenceInYears(payday, hireDate)
    return computeAccrualTier(policy, yos).hoursPerPayPeriod
  }
  const yosStart = differenceInYears(periodStart, hireDate)
  const yosEnd = differenceInYears(payday, hireDate)
  const tierStart = computeAccrualTier(policy, yosStart)
  const tierEnd = computeAccrualTier(policy, yosEnd)
  // Compare by VALUE, not object identity: a JSON round-trip of the policy
  // (localStorage load) produces fresh tier objects, so `===` would always
  // think the tier changed and wrongly prorate every pay period. Prorate only
  // when the resolved rate actually differs.
  if (sameTier(tierStart, tierEnd)) return tierEnd.hoursPerPayPeriod

  // Find the anniversary day inside (periodStart, payday] that triggered the
  // tier change. differenceInYears jumps on the anniversary day, so we walk
  // from periodStart+1 until we land on the day yos increments.
  let anniversaryDay: Date | null = null
  for (let d = 1; d <= periodDays; d++) {
    const probe = addDays(periodStart, d)
    if (differenceInYears(probe, hireDate) > yosStart) {
      anniversaryDay = probe
      break
    }
  }
  if (!anniversaryDay) return tierEnd.hoursPerPayPeriod
  const daysInOldTier = differenceInCalendarDays(anniversaryDay, periodStart)
  const daysInNewTier = periodDays - daysInOldTier
  return (
    (tierStart.hoursPerPayPeriod * daysInOldTier) / periodDays +
    (tierEnd.hoursPerPayPeriod * daysInNewTier) / periodDays
  )
}

/**
 * Generate all payday dates from a starting payday forward to (and including) a target date.
 */
function generatePaydays(
  lastPayday: Date,
  targetDate: Date,
  periodDays: number,
): Date[] {
  // Defensive: a bad policy value (0 or negative) would make addDays a no-op
  // and spin this loop forever. Clamp to a minimum 1-day stride.
  const period = Math.max(1, periodDays)
  const paydays: Date[] = []
  let current = addDays(lastPayday, period)
  while (!isAfter(current, targetDate)) {
    paydays.push(current)
    current = addDays(current, period)
  }
  return paydays
}

/**
 * First payday on or after `anchor`, computed from the stored lastPayday
 * anchor and the configured pay-period length. Used to snap the carryover
 * payout event to an actual pay date (e.g., "first pay date in February")
 * rather than a literal calendar day.
 */
export function firstPaydayOnOrAfter(
  lastPayday: Date,
  periodDays: number,
  anchor: Date,
): Date {
  const period = Math.max(1, periodDays)
  let payday = startOfDay(lastPayday)
  // The anchor can sit BEFORE lastPayday (e.g. a Feb 1 carryover anchor with a
  // May lastPayday). A forward-only walk would never run and return lastPayday
  // unchanged. Jump close with a day-count estimate (which may overshoot in
  // either direction), then correct both ways so we land on the first payday on
  // the lastPayday ± n*period cycle that is on/after the anchor.
  const est = Math.ceil(differenceInCalendarDays(anchor, payday) / period)
  payday = addDays(payday, est * period)
  while (isBefore(payday, anchor)) payday = addDays(payday, period)
  while (!isBefore(addDays(payday, -period), anchor)) payday = addDays(payday, -period)
  return payday
}

/**
 * The concrete date on which the vacation carryover cap payout will fire for
 * a given calendar year: the first payday on or after the
 * `carryoverPayoutDate` anchor. Returns null if the policy has no carryover
 * cap (strategy = 'unlimited').
 */
export function getCarryoverPayoutDate(
  state: AppState,
  year: number,
): Date | null {
  if (state.policy.carryoverCapStrategy === 'unlimited') return null
  const anchor = isoMidnight(
    year,
    state.policy.carryoverPayoutDate.month,
    state.policy.carryoverPayoutDate.day,
  )
  const lastPayday = parseISO(state.profile.lastPaydayDate)
  return firstPaydayOnOrAfter(lastPayday, state.policy.payPeriodLengthDays, anchor)
}

/** Same civil calendar day? Holiday dates and day-stream dates are all built at
 *  local midnight (parseISO / isoMidnight / eachDayOfInterval over local
 *  anchors) and read with the LOCAL getters, so the civil date round-trips
 *  correctly in any timezone — unlike the previous getUTC* reads, which only
 *  matched at UTC/behind-UTC offsets. */
function isSameCivilDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Check if a date is a work day (in workDaysPerWeek and not a holiday).
 * Uses getDay (local) to match the local civil-date basis the holiday dates
 * and vacation day-streams are built on.
 */
function isWorkDay(date: Date, policy: PolicyConfig, holidays: Date[]): boolean {
  const dow = date.getDay()
  if (!policy.workDaysPerWeek.includes(dow)) return false
  return !holidays.some((h) => isSameCivilDay(h, date))
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
  // Anchor "today" to the user's profile timezone, not the browser's local
  // timezone — otherwise an East-coast user who travels to LA would see the
  // wrong day's events fire.
  const tz0 = state.profile.timezone || DEFAULT_TZ
  const todayIso = getNowInZone(tz0).isoDate
  const today = parseISO(todayIso)
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

  if (!isAfter(target, today)) {
    const eff = getEffectiveCurrentBalances(state)
    return {
      vacationBalance: r2(eff.vacation),
      sickBalance: r2(eff.sick),
      bankBalance: r2(eff.bank),
      totalAvailable: r2(eff.total),
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
    type:
      | 'accrual'
      | 'vacation_deduction'
      | 'carryover_adjustment'
      | 'bank_payout'
      | 'bank_credit'
      | 'sick_grant'
    process: () => number
    label?: string
    hourSource?: 'vacation' | 'sick' | 'bank' | 'any'
  }
  const pendingEvents: PendingEvent[] = []

  // Future-dated bank-log entries (e.g. a known upcoming overtime shift) are
  // credited on their OWN date, in chronological order with the payouts — NOT
  // folded in up-front. Folding them in early let a payout dated before the
  // entry pay out hours that weren't banked yet, diverging from catch-up (which
  // schedules each entry on entry.date). `appliedToBalance !== false` matches
  // catch-up: only entries not yet credited to the stored balance are folded.
  if (state.bankHoursLog) {
    for (const entry of state.bankHoursLog) {
      if (entry.appliedToBalance !== false) continue
      const entryDate = parseISO(entry.date)
      if (isAfter(entryDate, today) && !isAfter(entryDate, target)) {
        pendingEvents.push({
          date: entryDate,
          type: 'bank_credit',
          process: () => entry.hours,
          label: entry.note ? `Bank adjustment — ${entry.note}` : 'Bank adjustment',
        })
      }
    }
  }

  for (let i = 0; i < paydays.length; i++) {
    const payday = paydays[i]
    if (!isAfter(payday, today)) continue
    pendingEvents.push({
      date: payday,
      type: 'accrual',
      process: () => {
        // Pro-rate when a tier transition (service anniversary) falls inside
        // the pay period. Delegated to the shared accrualForPeriod helper so
        // projection and catch-up stay in lockstep over anniversary periods.
        const periodStart = i > 0 ? paydays[i - 1] : lastPayday
        return accrualForPeriod(state.policy, hireDate, periodStart, payday)
      },
      label: 'Vacation accrual',
    })
  }

  for (const vacation of futureVacations) {
    const vStart = parseISO(vacation.startDate)
    const vEnd = parseISO(vacation.endDate)
    // Charge from the entry's true start (not from today): for an entry that
    // SPANS today, its already-elapsed work days aren't in the stored balance
    // yet (catch-up only books once fully past), so the projection must deduct
    // them too — otherwise the projected balance is too high until the next
    // reopen. Today itself is charged only once its work day is over.
    const rangeEnd = isAfter(vEnd, target) ? target : vEnd
    if (isAfter(vStart, rangeEnd)) continue

    // Spread an entry total (`actualHoursUsed`) over ALL the entry's work days,
    // not just the ones inside this projection range.
    const entryWorkDays = countWorkDays(vStart, vEnd, state.policy)
    const deductHours = resolveDeductHours(
      vacation,
      state.policy.hoursPerWorkDay,
      entryWorkDays,
    )
    const days = eachDayOfInterval({ start: vStart, end: rangeEnd })
    for (const day of days) {
      // Skip today before the work-day cutoff (it hasn't been "taken" yet).
      if (format(day, 'yyyy-MM-dd') === todayIso && !todayIsOver) continue
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
    // The policy date is an anchor ("Feb 1" by default); the actual event
    // fires on the first payday on or after that date so it lands on a real
    // pay cycle rather than a random calendar day.
    const anchor = isoMidnight(
      y,
      state.policy.carryoverPayoutDate.month,
      state.policy.carryoverPayoutDate.day,
    )
    const payoutDate = firstPaydayOnOrAfter(
      lastPayday,
      state.policy.payPeriodLengthDays,
      anchor,
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

  // Bank hours pay out on the FIRST PAYDAY on/after EACH configured payout date
  // — both the window-open (bankHoursPayoutStart, e.g. Dec 15) AND the
  // window-close (bankHoursPayoutEnd, e.g. Feb 15). Between the two, bank hours
  // can still be banked/used; each trigger zeroes whatever is banked as of its
  // payday. Iterate one extra year each side to catch a payday from an adjacent
  // year; dedup so a start/end pair resolving to the same payday pays once.
  // Mirrors catchUp.ts exactly so projection and the persisted balance agree.
  const bankAnchors = [
    state.policy.bankHoursPayoutStart,
    state.policy.bankHoursPayoutEnd,
  ]
  const bankPayoutPaydays = new Set<number>()
  for (let y = startYear - 1; y <= endYear + 1; y++) {
    for (const anchor of bankAnchors) {
      const triggerDate = isoMidnight(y, anchor.month, anchor.day)
      const payoutDate = firstPaydayOnOrAfter(
        lastPayday,
        state.policy.payPeriodLengthDays,
        triggerDate,
      )
      if (!isAfter(payoutDate, today) || isAfter(payoutDate, target)) continue
      if (bankPayoutPaydays.has(payoutDate.getTime())) continue
      bankPayoutPaydays.add(payoutDate.getTime())
      pendingEvents.push({
        date: payoutDate,
        type: 'bank_payout',
        process: () => 0,
        label: `Bank hours payout (${format(payoutDate, 'MMM d')})`,
      })
    }
  }

  for (let y = startYear + 1; y <= endYear; y++) {
    const grantDate = isoMidnight(y, 1, 1) // January 1
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
    const order = {
      sick_grant: 0,
      accrual: 1,
      vacation_deduction: 2,
      bank_credit: 3,
      carryover_adjustment: 3,
      bank_payout: 4,
    }
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
          // This event mutates the SICK pool, so report the sick running
          // balance (not vacation, which it doesn't touch).
          runningBalance: sickBalance,
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
    } else if (pe.type === 'bank_credit') {
      // A future-dated bank-log entry reaching its date. Credit the bank pool
      // chronologically so a payout earlier in the horizon doesn't pay out
      // hours that aren't banked yet.
      bankBalance += pe.process()
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
    vacationBalance: r2(vacationBalance),
    sickBalance: r2(sickBalance),
    bankBalance: r2(bankBalance),
    totalAvailable: r2(vacationBalance + sickBalance + bankBalance),
    carryoverAdjustment: r2(totalCarryoverAdjustment),
    bankPayout: r2(totalBankPayout),
    shortfall: r2(totalShortfall),
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
  const period = Math.max(1, state.policy.payPeriodLengthDays)
  const lastPayday = parseISO(state.profile.lastPaydayDate)
  const checkDate = startOfDay(notBefore)

  const initial = projectBalance(state, checkDate)
  if (initial.totalAvailable >= hoursNeeded) return checkDate

  let payday = addDays(lastPayday, period)
  while (!isAfter(payday, checkDate)) {
    payday = addDays(payday, period)
  }

  while (!isAfter(payday, maxDate)) {
    const result = projectBalance(state, payday)
    if (result.totalAvailable >= hoursNeeded) {
      // The payday walk overshoots: a non-payday event (Jan 1 sick grant,
      // carryover/bank payout, a vacation ending) may have made the balance
      // affordable BEFORE this payday. Refine to day precision by testing each
      // such event date in [checkDate, payday) ascending and returning the
      // first that already covers the need.
      const candidates = Array.from(
        new Set(
          result.events
            .map((e) => e.date)
            .filter((iso) => iso >= format(checkDate, 'yyyy-MM-dd') && parseISO(iso) < payday),
        ),
      ).sort()
      for (const iso of candidates) {
        const d = parseISO(iso)
        if (projectBalance(state, d).totalAvailable >= hoursNeeded) return d
      }
      return payday
    }
    payday = addDays(payday, period)
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

  const period = Math.max(1, state.policy.payPeriodLengthDays)
  const lastPayday = parseISO(state.profile.lastPaydayDate)
  let payday = addDays(lastPayday, period)
  while (!isAfter(payday, initial)) {
    payday = addDays(payday, period)
  }

  while (!isAfter(payday, maxDate)) {
    if (tryStart(payday)) {
      // Refine to day precision: a mid-period event may let the trip start
      // earlier than this payday. Test each baseline event date in
      // (initial, payday) ascending and return the first start that fits.
      const baseline = projectBalance(state, payday)
      const candidates = Array.from(
        new Set(
          baseline.events
            .map((e) => e.date)
            .filter((iso) => parseISO(iso) > initial && parseISO(iso) < payday),
        ),
      ).sort()
      for (const iso of candidates) {
        const d = parseISO(iso)
        if (tryStart(d)) return d
      }
      return payday
    }
    payday = addDays(payday, period)
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
export function getNextPayday(
  lastPayday: Date,
  periodDays: number,
  // Anchor "today" to the caller's zoned today (parseISO(getNowInZone(tz).isoDate))
  // so the next payday agrees with projectBalance for a traveling user whose
  // browser timezone differs from profile.timezone. Defaults to local midnight.
  today: Date = startOfDay(new Date()),
): Date {
  const period = Math.max(1, periodDays)
  let next = addDays(lastPayday, period)
  while (!isAfter(next, today)) {
    next = addDays(next, period)
  }
  return next
}

/**
 * Check if a date is in the bank hours payout window.
 */
export { isInBankPayoutWindow }
