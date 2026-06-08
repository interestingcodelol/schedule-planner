import {
  addDays,
  differenceInYears,
  eachDayOfInterval,
  format,
  isAfter,
  isBefore,
  parseISO,
  startOfDay,
} from 'date-fns'
import type {
  AccrualTier,
  AppState,
  PlannedVacation,
  PolicyConfig,
  UserProfile,
} from './types'
import { computeHolidayDates } from './holidays'
import {
  accrualForPeriod,
  computeAccrualTier,
  firstPaydayOnOrAfter,
  newYearAccrualThrough,
} from './projection'
import { getNowInZone } from './timeUtils'

const DEFAULT_TZ = 'America/New_York'

/** Round to 2 decimals at the boundary. Pools accumulate full-precision in
 *  the loop; only the balances written back into the profile are rounded so
 *  stored/displayed values never carry a float tail like 71.53999999999999. */
const r2 = (n: number): number => Math.round(n * 100) / 100

function isoMidnight(year: number, month: number, day: number): Date {
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return parseISO(`${year}-${mm}-${dd}`)
}

export type CatchUpEvent = {
  date: string
  type:
    | 'accrual'
    | 'sick_grant'
    | 'sick_carryover_forfeit'
    | 'carryover_payout'
    | 'bank_payout'
    | 'vacation_deduction'
  pool: 'vacation' | 'sick' | 'bank'
  delta: number
  label: string
}

export type CatchUpResult = {
  state: AppState
  events: CatchUpEvent[]
  /** True when the function applied at least one balance-changing event. */
  applied: boolean
  /** ISO date the run treated as "today" — written back as lastSyncDate. */
  syncedTo: string
}

type Pools = { vacation: number; sick: number; bank: number }

/** Same civil calendar day? Every date-only value here is constructed at local
 *  midnight (parseISO / isoMidnight) and read with LOCAL getters, so the civil
 *  date round-trips correctly in any timezone. (Reading getUTC* — as before —
 *  only matched the civil date at UTC/behind-UTC offsets.) */
function isSameCivilDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function isWorkDay(date: Date, policy: PolicyConfig, holidays: Date[]): boolean {
  const dow = date.getDay()
  if (!policy.workDaysPerWeek.includes(dow)) return false
  return !holidays.some((h) => isSameCivilDay(h, date))
}

function computeCarryoverCap(policy: PolicyConfig, tier: AccrualTier): number | null {
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

function resolveDeductHours(
  v: PlannedVacation,
  hoursPerWorkDay: number,
  workDays: number,
): number {
  // `actualHoursUsed` is the ENTRY TOTAL across every work day in the span (see
  // types.ts). The per-day deduction loop needs a per-work-day figure, so spread
  // the total evenly. `hoursPerDay` is already per-day; full days fall back to
  // the policy work-day length.
  if (v.actualHoursUsed !== undefined) {
    return workDays > 0 ? v.actualHoursUsed / workDays : v.actualHoursUsed
  }
  if (v.hoursPerDay !== undefined) return v.hoursPerDay
  return hoursPerWorkDay
}

/**
 * Subtract `hours` from the appropriate pool(s) and return the per-pool
 * breakdown so the catch-up log can attribute each draw to a specific bucket.
 * Mirrors the projection's deduction logic — for 'any', drains bank → vacation
 * → sick, and never overdraws beyond zero.
 */
function applyDeduction(
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
  pools: Pools,
): { from: 'vacation' | 'sick' | 'bank'; amount: number }[] {
  // Match projection's behaviour: explicit pool sources floor at 0. The
  // attributed amount is the actual hours drawn (capped to what was
  // available), not the requested hours — the caller tracks any shortfall.
  if (source === 'vacation') {
    const drawn = Math.min(hours, Math.max(0, pools.vacation))
    pools.vacation = Math.max(0, pools.vacation - hours)
    return [{ from: 'vacation', amount: drawn }]
  }
  if (source === 'sick') {
    const drawn = Math.min(hours, Math.max(0, pools.sick))
    pools.sick = Math.max(0, pools.sick - hours)
    return [{ from: 'sick', amount: drawn }]
  }
  if (source === 'bank') {
    const drawn = Math.min(hours, Math.max(0, pools.bank))
    pools.bank = Math.max(0, pools.bank - hours)
    return [{ from: 'bank', amount: drawn }]
  }
  const breakdown: { from: 'vacation' | 'sick' | 'bank'; amount: number }[] = []
  let remaining = hours
  const fromBank = Math.min(remaining, Math.max(0, pools.bank))
  if (fromBank > 0) {
    pools.bank -= fromBank
    remaining -= fromBank
    breakdown.push({ from: 'bank', amount: fromBank })
  }
  if (remaining > 0) {
    const fromVaca = Math.min(remaining, Math.max(0, pools.vacation))
    if (fromVaca > 0) {
      pools.vacation -= fromVaca
      remaining -= fromVaca
      breakdown.push({ from: 'vacation', amount: fromVaca })
    }
  }
  if (remaining > 0) {
    const fromSick = Math.min(remaining, Math.max(0, pools.sick))
    if (fromSick > 0) {
      pools.sick -= fromSick
      breakdown.push({ from: 'sick', amount: fromSick })
    }
  }
  return breakdown
}

type PendingEvent = {
  date: Date
  /** Same-day ordering — matches projection.ts: sick_grant < accrual <
   *  vacation_deduction < carryover_payout < bank_payout. */
  order: number
  apply: () => void
}

/**
 * Walk every event that should have fired between
 * `state.profile.lastSyncDate` (or `lastPaydayDate` if missing) and the
 * current local day, applying them to the stored balances and marking
 * fully-past planned vacations as `logged_past` so they don't re-process
 * on the next run. Idempotent: subsequent calls without elapsed time are
 * no-ops apart from refreshing `lastSyncDate`.
 *
 * Events handled, in chronological order with same-day ties broken in the
 * order projection.ts uses:
 *   - Jan 1 sick grant (with carryover-cap forfeiture)
 *   - Pay-period accruals at each payday after lastSync
 *   - Per-work-day deductions for any planned vacation that fully ended
 *     in the catch-up window (entire range is processed; running this
 *     across multiple sessions never double-counts because the entry is
 *     flipped to `logged_past` once applied)
 *   - Carryover-cap payouts (first payday on/after carryoverPayoutDate)
 *   - Bank-hours payouts at the start AND end of the bank payout window,
 *     matching the projection's behaviour
 */
export function catchUpState(state: AppState, now: Date = new Date()): CatchUpResult {
  const tz = state.profile.timezone || DEFAULT_TZ
  const todayIso = getNowInZone(tz, now).isoDate
  const today = startOfDay(parseISO(todayIso))

  const lastSyncIso =
    state.profile.lastSyncDate ?? state.profile.lastPaydayDate
  const lastSync = startOfDay(parseISO(lastSyncIso))

  if (!isAfter(today, lastSync)) {
    // Clock went backwards (DST jump, manual change, timezone shift). Refusing
    // to rewind lastSyncDate prevents the next forward-in-time run from
    // re-applying paydays/vacations that were already booked.
    return { state, events: [], applied: false, syncedTo: lastSyncIso }
  }

  const lastPayday = parseISO(state.profile.lastPaydayDate)
  const hireDate = parseISO(state.profile.hireDate)
  const events: CatchUpEvent[] = []
  const pools: Pools = {
    vacation: state.profile.currentVacationHours,
    sick: state.profile.currentSickHours,
    bank: state.profile.currentBankHours,
  }

  const pending: PendingEvent[] = []

  // --- Paydays / accruals -------------------------------------------------
  // Defensive: clamp the stride to >= 1 day so a bad policy value (0/negative)
  // can't make addDays a no-op and spin these payday-walk loops forever.
  const period = Math.max(1, state.policy.payPeriodLengthDays)
  let payday = lastPayday
  while (!isAfter(payday, lastSync)) {
    payday = addDays(payday, period)
  }
  while (!isAfter(payday, today)) {
    const paydayCopy = payday
    // The pay period covered by this payday runs from the PREVIOUS payday
    // (one period earlier) to this one. Pass it to accrualForPeriod so the
    // accrual is pro-rated across a service-anniversary boundary exactly the
    // way projection does — otherwise catch-up applies the full new-tier rate
    // as a cliff and the persisted balance drifts from the projected balance.
    const periodStart = addDays(paydayCopy, -period)
    pending.push({
      date: paydayCopy,
      order: 1,
      apply: () => {
        const accrued = accrualForPeriod(
          state.policy,
          hireDate,
          periodStart,
          paydayCopy,
        )
        const yos = differenceInYears(paydayCopy, hireDate)
        const tier = computeAccrualTier(state.policy, yos)
        pools.vacation += accrued
        events.push({
          date: format(paydayCopy, 'yyyy-MM-dd'),
          type: 'accrual',
          pool: 'vacation',
          delta: accrued,
          label: `Vacation accrual (${tier.label})`,
        })
      },
    })
    payday = addDays(payday, period)
  }

  // --- Jan 1 sick grants --------------------------------------------------
  const startYear = lastSync.getFullYear()
  const endYear = today.getFullYear()
  for (let y = startYear; y <= endYear; y++) {
    const jan1 = isoMidnight(y, 1, 1)
    if (isAfter(jan1, lastSync) && !isAfter(jan1, today)) {
      pending.push({
        date: jan1,
        order: 0,
        apply: () => {
          const cap = state.policy.sickLeaveCarryoverCap
          let forfeited = 0
          if (cap !== undefined && pools.sick > cap) {
            forfeited = pools.sick - cap
            pools.sick = cap
          }
          if (forfeited > 0) {
            events.push({
              date: format(jan1, 'yyyy-MM-dd'),
              type: 'sick_carryover_forfeit',
              pool: 'sick',
              delta: -forfeited,
              label: `Sick carryover cap — forfeited ${forfeited.toFixed(2)} hrs`,
            })
          }
          const grant = state.policy.sickLeaveAnnualGrant
          const newBalance = Math.min(pools.sick + grant, state.policy.sickLeaveMaxBalance)
          const actual = newBalance - pools.sick
          if (actual > 0) {
            pools.sick = newBalance
            events.push({
              date: format(jan1, 'yyyy-MM-dd'),
              type: 'sick_grant',
              pool: 'sick',
              delta: actual,
              label: `Annual sick leave grant (+${actual.toFixed(2)} hrs)`,
            })
          }
        },
      })
    }
  }

  // --- Carryover-cap payouts ---------------------------------------------
  if (state.policy.carryoverCapStrategy !== 'unlimited') {
    for (let y = startYear; y <= endYear; y++) {
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
      if (isAfter(payoutDate, lastSync) && !isAfter(payoutDate, today)) {
        const payoutDateCopy = payoutDate
        pending.push({
          date: payoutDateCopy,
          order: 3,
          apply: () => {
            const yos = differenceInYears(payoutDateCopy, hireDate)
            const tier = computeAccrualTier(state.policy, yos)
            const cap = computeCarryoverCap(state.policy, tier)
            if (cap !== null) {
              // Pay out only the prior year's carried-over excess over the cap;
              // this year's accruals (paychecks since Jan 1) carry on. Mirrors
              // projection.ts exactly so the stored balance never drifts.
              const newYearAccr = newYearAccrualThrough(
                state.policy,
                hireDate,
                lastPayday,
                payoutDateCopy.getFullYear(),
                payoutDateCopy,
              )
              const paidOut = pools.vacation - newYearAccr - cap
              if (paidOut > 0) {
                pools.vacation -= paidOut
                events.push({
                  date: format(payoutDateCopy, 'yyyy-MM-dd'),
                  type: 'carryover_payout',
                  pool: 'vacation',
                  delta: -paidOut,
                  label: `Carry-over cap ${cap.toFixed(2)} hrs — ${paidOut.toFixed(2)} hrs over the cap paid out`,
                })
              }
            }
          },
        })
      }
    }
  }

  // --- Bank payouts ------------------------------------------------------
  // Bank hours are paid out via payroll on the FIRST PAYDAY on/after EACH
  // configured payout date — BOTH the window-open (bankHoursPayoutStart, e.g.
  // Dec 15) AND the window-close (bankHoursPayoutEnd, e.g. Feb 15). Between the
  // two dates bank hours can still be banked and used; each trigger zeroes
  // whatever is banked as of its payday, so the cycle is: pay out in Dec → bank
  // refills → pay out again in Feb → nothing until the next Dec. Iterate one
  // year on each side so a payday that fell during the catch-up gap from an
  // adjacent calendar year is captured. Dedup so a start/end pair that happens
  // to resolve to the same payday only pays out once.
  const bankAnchors = [
    state.policy.bankHoursPayoutStart,
    state.policy.bankHoursPayoutEnd,
  ]
  const bankPayoutPaydays = new Set<number>()
  for (let y = startYear - 1; y <= endYear + 1; y++) {
    for (const anchor of bankAnchors) {
      const triggerDate = isoMidnight(y, anchor.month, anchor.day)
      const payday = firstPaydayOnOrAfter(
        lastPayday,
        state.policy.payPeriodLengthDays,
        triggerDate,
      )
      if (!isAfter(payday, lastSync) || isAfter(payday, today)) continue
      if (bankPayoutPaydays.has(payday.getTime())) continue
      bankPayoutPaydays.add(payday.getTime())
      const pCopy = payday
      pending.push({
        date: pCopy,
        order: 4,
        apply: () => {
          if (pools.bank > 0) {
            const payout = pools.bank
            pools.bank = 0
            events.push({
              date: format(pCopy, 'yyyy-MM-dd'),
              type: 'bank_payout',
              pool: 'bank',
              delta: -payout,
              label: `Bank hours paid out: ${payout.toFixed(2)} hrs`,
            })
          }
        },
      })
    }
  }

  // --- Future-dated bank-log entries that have now passed --------------
  // addBankHours() only credits currentBankHours for entries on/before today.
  // Future-dated entries (e.g., a known overtime shift coming up) get folded
  // in here once their date has arrived so the persisted balance matches what
  // the projection has been showing.
  const appliedBankEntryIds = new Set<string>()
  if (state.bankHoursLog) {
    for (const entry of state.bankHoursLog) {
      const entryDate = startOfDay(parseISO(entry.date))
      if (isAfter(entryDate, lastSync) && !isAfter(entryDate, today)) {
        if (entry.appliedToBalance !== false) continue
        pending.push({
          date: entryDate,
          order: 3,
          apply: () => {
            pools.bank += entry.hours
            appliedBankEntryIds.add(entry.id)
            events.push({
              date: format(entryDate, 'yyyy-MM-dd'),
              type: 'bank_payout',
              pool: 'bank',
              delta: entry.hours,
              label: entry.note
                ? `Bank adjustment — ${entry.note}`
                : `Bank adjustment ${entry.hours >= 0 ? '+' : ''}${entry.hours.toFixed(2)} hrs`,
            })
          },
        })
      }
    }
  }

  // --- Past planned-vacation deductions ----------------------------------
  // Any vacation that *fully* ended before today and isn't already logged_past
  // gets its full work-day range deducted in one pass. A vacation still
  // spanning today is left alone — getEffectiveCurrentBalances handles its
  // same-day display, projection handles its future days, and the next
  // catch-up after it ends will deduct the whole thing. This keeps the
  // logic idempotent without depending on whether the user happened to
  // open the app mid-vacation.
  const allHolidays: Date[] = []
  // Vacations could start in earlier years than lastSync (e.g., a long
  // vacation that began before the last sync but ended after); compute
  // holidays across every year a candidate vacation could touch.
  const earliestVacYear = state.plannedVacations.reduce<number>(
    (min, v) => {
      if (v.kind === 'logged_past') return min
      const y = parseISO(v.startDate).getFullYear()
      return y < min ? y : min
    },
    startYear,
  )
  for (let y = earliestVacYear; y <= endYear; y++) {
    allHolidays.push(...computeHolidayDates(state.policy, y))
  }

  const processedVacationIds = new Set<string>()
  const vacationActuals: Record<string, number> = {}
  // Per-pool breakdown of what each converted vacation actually debited, so
  // the App layer can record `debitedFrom` for exact future refunds.
  const vacationDebits: Record<
    string,
    { vacation: number; sick: number; bank: number }
  > = {}

  // Days already debited by an existing logged_past entry. A newly-elapsed
  // planned entry that overlaps one of these must NOT debit it a second time.
  const loggedPastDates = new Set<string>()
  for (const v of state.plannedVacations) {
    if (v.kind !== 'logged_past') continue
    for (const d of eachDayOfInterval({
      start: parseISO(v.startDate),
      end: parseISO(v.endDate),
    })) {
      loggedPastDates.add(format(d, 'yyyy-MM-dd'))
    }
  }

  for (const vacation of state.plannedVacations) {
    if (vacation.kind === 'logged_past') continue
    const vEnd = parseISO(vacation.endDate)
    if (!isBefore(vEnd, today)) continue
    const vStart = parseISO(vacation.startDate)
    const days = eachDayOfInterval({ start: vStart, end: vEnd })
    // Work days this entry will actually debit: real work days not already
    // covered by a separate logged_past entry. The per-day deduction is the
    // entry total spread across exactly these days.
    const chargeableDays = days.filter(
      (d) =>
        isWorkDay(d, state.policy, allHolidays) &&
        !loggedPastDates.has(format(d, 'yyyy-MM-dd')),
    )
    const workDays = chargeableDays.length
    const deductHours = resolveDeductHours(
      vacation,
      state.policy.hoursPerWorkDay,
      workDays,
    )
    // The entry's total intended hours across the charged days. Stored back as
    // `actualHoursUsed` so the value is unambiguously a TOTAL (not per-day),
    // matching what the adjust UI and refund logic expect.
    const entryTotal = vacation.actualHoursUsed ?? deductHours * workDays

    for (const day of chargeableDays) {
      const dayCopy = day
      pending.push({
        date: dayCopy,
        order: 2,
        apply: () => {
          const breakdown = applyDeduction(
            deductHours,
            vacation.hourSource || 'any',
            pools,
          )
          const debit = (vacationDebits[vacation.id] ??= {
            vacation: 0,
            sick: 0,
            bank: 0,
          })
          for (const b of breakdown) {
            debit[b.from] += b.amount
            events.push({
              date: format(dayCopy, 'yyyy-MM-dd'),
              type: 'vacation_deduction',
              pool: b.from,
              delta: -b.amount,
              label: vacation.note ? `Time off — ${vacation.note}` : 'Time off',
            })
          }
          processedVacationIds.add(vacation.id)
          vacationActuals[vacation.id] = entryTotal
        },
      })
    }
  }

  pending.sort((a, b) => {
    const dayDiff = a.date.getTime() - b.date.getTime()
    if (dayDiff !== 0) return dayDiff
    return a.order - b.order
  })
  for (const p of pending) p.apply()

  // Advance lastPaydayDate to the most recent payday <= today so projections
  // continue to anchor on a real pay cycle.
  let mostRecentPayday = lastPayday
  let probe = lastPayday
  while (!isAfter(addDays(probe, period), today)) {
    probe = addDays(probe, period)
    if (!isAfter(probe, today)) mostRecentPayday = probe
  }

  const newPlannedVacations =
    processedVacationIds.size === 0
      ? state.plannedVacations
      : state.plannedVacations.map((v) => {
          if (!processedVacationIds.has(v.id)) return v
          return {
            ...v,
            kind: 'logged_past' as const,
            actualHoursUsed: v.actualHoursUsed ?? vacationActuals[v.id],
            // Record the exact per-pool draw so a later refund can reverse it
            // precisely. Preserve any pre-existing value defensively.
            debitedFrom: v.debitedFrom ?? vacationDebits[v.id],
          }
        })

  const newProfile: UserProfile = {
    ...state.profile,
    currentVacationHours: r2(pools.vacation),
    currentSickHours: r2(pools.sick),
    currentBankHours: r2(pools.bank),
    lastPaydayDate: format(mostRecentPayday, 'yyyy-MM-dd'),
    lastSyncDate: todayIso,
  }

  const newBankHoursLog =
    appliedBankEntryIds.size === 0
      ? state.bankHoursLog
      : state.bankHoursLog.map((e) =>
          appliedBankEntryIds.has(e.id) ? { ...e, appliedToBalance: true } : e,
        )

  return {
    state: {
      ...state,
      profile: newProfile,
      plannedVacations: newPlannedVacations,
      bankHoursLog: newBankHoursLog,
    },
    events,
    applied: events.length > 0,
    syncedTo: todayIso,
  }
}

/**
 * One-line summary of the events the most recent catch-up applied. Used by
 * the toast surface so the user sees what changed without opening a panel.
 */
export function summarizeCatchUp(events: CatchUpEvent[]): string {
  if (events.length === 0) return 'Up to date'
  const totals = {
    vacation: 0,
    sick: 0,
    bank: 0,
  }
  for (const e of events) totals[e.pool] += e.delta

  const parts: string[] = []
  const fmtDelta = (n: number) => {
    const sign = n >= 0 ? '+' : '−'
    const abs = Math.abs(n)
    return `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(2)}`
  }
  if (totals.vacation !== 0) parts.push(`${fmtDelta(totals.vacation)} vac`)
  if (totals.sick !== 0) parts.push(`${fmtDelta(totals.sick)} sick`)
  if (totals.bank !== 0) parts.push(`${fmtDelta(totals.bank)} bank`)
  if (parts.length === 0) {
    return `Synced ${events.length} event${events.length === 1 ? '' : 's'}`
  }
  return `Synced ${events.length} event${events.length === 1 ? '' : 's'}: ${parts.join(', ')}`
}
