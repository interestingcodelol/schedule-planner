import {
  addDays,
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
  PlannedVacation,
  PolicyConfig,
  UserProfile,
} from './types'
import { computeHolidayDates } from './holidays'
import { computeAccrualTier, firstPaydayOnOrAfter } from './projection'
import { getNowInZone } from './timeUtils'

const DEFAULT_TZ = 'America/New_York'

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

function isWorkDay(date: Date, policy: PolicyConfig, holidays: Date[]): boolean {
  const dow = getDay(date)
  if (!policy.workDaysPerWeek.includes(dow)) return false
  return !holidays.some((h) => isSameDay(h, date))
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

function resolveDeductHours(v: PlannedVacation, hoursPerWorkDay: number): number {
  if (v.actualHoursUsed !== undefined) return v.actualHoursUsed
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
  let payday = lastPayday
  while (!isAfter(payday, lastSync)) {
    payday = addDays(payday, state.policy.payPeriodLengthDays)
  }
  while (!isAfter(payday, today)) {
    const paydayCopy = payday
    pending.push({
      date: paydayCopy,
      order: 1,
      apply: () => {
        const yos = differenceInYears(paydayCopy, hireDate)
        const tier = computeAccrualTier(state.policy, yos)
        pools.vacation += tier.hoursPerPayPeriod
        events.push({
          date: format(paydayCopy, 'yyyy-MM-dd'),
          type: 'accrual',
          pool: 'vacation',
          delta: tier.hoursPerPayPeriod,
          label: `Vacation accrual (${tier.label})`,
        })
      },
    })
    payday = addDays(payday, state.policy.payPeriodLengthDays)
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
            if (cap !== null && pools.vacation > cap) {
              const paidOut = pools.vacation - cap
              pools.vacation = cap
              events.push({
                date: format(payoutDateCopy, 'yyyy-MM-dd'),
                type: 'carryover_payout',
                pool: 'vacation',
                delta: -paidOut,
                label: `Carryover cap ${cap.toFixed(2)} hrs — ${paidOut.toFixed(2)} hrs paid out`,
              })
            }
          },
        })
      }
    }
  }

  // --- Bank payouts ------------------------------------------------------
  // Window can span the year boundary (e.g., Dec 15 → Feb 15), so the END date
  // belongs to the NEXT year when end-month <= start-month. Iterate one year
  // before startYear too, so a payout that fired during the catch-up gap is
  // correctly captured.
  const bankStartM = state.policy.bankHoursPayoutStart.month
  const bankEndM = state.policy.bankHoursPayoutEnd.month
  const endsNextYear =
    bankEndM < bankStartM ||
    (bankEndM === bankStartM &&
      state.policy.bankHoursPayoutEnd.day < state.policy.bankHoursPayoutStart.day)
  for (let y = startYear - 1; y <= endYear + 1; y++) {
    const start = isoMidnight(y, bankStartM, state.policy.bankHoursPayoutStart.day)
    const end = isoMidnight(
      endsNextYear ? y + 1 : y,
      bankEndM,
      state.policy.bankHoursPayoutEnd.day,
    )
    for (const p of [start, end]) {
      if (isAfter(p, lastSync) && !isAfter(p, today)) {
        const pCopy = p
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

  for (const vacation of state.plannedVacations) {
    if (vacation.kind === 'logged_past') continue
    const vEnd = parseISO(vacation.endDate)
    if (!isBefore(vEnd, today)) continue
    const vStart = parseISO(vacation.startDate)
    const days = eachDayOfInterval({ start: vStart, end: vEnd })
    const deductHours = resolveDeductHours(vacation, state.policy.hoursPerWorkDay)

    for (const day of days) {
      if (!isWorkDay(day, state.policy, allHolidays)) continue
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
          for (const b of breakdown) {
            events.push({
              date: format(dayCopy, 'yyyy-MM-dd'),
              type: 'vacation_deduction',
              pool: b.from,
              delta: -b.amount,
              label: vacation.note ? `Time off — ${vacation.note}` : 'Time off',
            })
          }
          processedVacationIds.add(vacation.id)
          vacationActuals[vacation.id] =
            (vacationActuals[vacation.id] ?? 0) + deductHours
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
  while (!isAfter(addDays(probe, state.policy.payPeriodLengthDays), today)) {
    probe = addDays(probe, state.policy.payPeriodLengthDays)
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
          }
        })

  const newProfile: UserProfile = {
    ...state.profile,
    currentVacationHours: pools.vacation,
    currentSickHours: pools.sick,
    currentBankHours: pools.bank,
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
