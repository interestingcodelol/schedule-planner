import {
  addDays,
  differenceInYears,
  format,
  isAfter,
  isBefore,
  parseISO,
  startOfDay,
} from 'date-fns'
import type {
  AccrualTier,
  AppliedTimeOffDeduction,
  AppState,
  PolicyConfig,
  UserProfile,
} from './types'
import {
  accrualForPeriod,
  computeAccrualTier,
  firstPaydayOnOrAfter,
  getScheduledDeductions,
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
  // Match projection: draw only positive capacity, preserving any already-
  // recorded debt rather than crediting it back by flooring the pool to zero.
  // Attribute only the actual hours drawn, never an unfunded request.
  if (source === 'vacation') {
    const drawn = Math.min(hours, Math.max(0, pools.vacation))
    pools.vacation -= drawn
    return [{ from: 'vacation', amount: drawn }]
  }
  if (source === 'sick') {
    const drawn = Math.min(hours, Math.max(0, pools.sick))
    pools.sick -= drawn
    return [{ from: 'sick', amount: drawn }]
  }
  if (source === 'bank') {
    const drawn = Math.min(hours, Math.max(0, pools.bank))
    pools.bank -= drawn
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
 * Reconcile paydays, grants, payouts and scheduled workdays chronologically
 * through the user's local today. Payroll events fire only after lastSyncDate;
 * scheduled days carry their own per-entry ledger so newly added same-day PTO
 * can be booked without replaying payroll. Ended entries become logged_past.
 * Repeated calls are idempotent, including an active multi-day trip.
 */
export function catchUpState(state: AppState, now: Date = new Date()): CatchUpResult {
  const tz = state.profile.timezone || DEFAULT_TZ
  const todayIso = getNowInZone(tz, now).isoDate
  const today = startOfDay(parseISO(todayIso))

  const lastSyncIso =
    state.profile.lastSyncDate ?? state.profile.lastPaydayDate
  const lastSync = startOfDay(parseISO(lastSyncIso))

  if (isBefore(today, lastSync)) {
    // Clock went backwards (manual change or timezone shift). Refusing
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

  // --- Scheduled vacation deductions through local today ----------------
  // Book each elapsed workday exactly once, even for trips still in progress.
  // Doing this in the same stream as accruals/payouts prevents reopening
  // mid-trip from changing which pool funds the trip or what gets paid out.
  const finalizedVacationIds = new Set(
    state.plannedVacations
      .filter((v) => v.kind !== 'logged_past' && isBefore(parseISO(v.endDate), today))
      .map((v) => v.id),
  )
  const changedVacationIds = new Set(finalizedVacationIds)
  const vacationActuals: Record<string, number> = {}
  const vacationDebits: Record<string, Pools> = {}
  const appliedDeductions: Record<string, AppliedTimeOffDeduction[]> = {}
  for (const vacation of state.plannedVacations) {
    if (vacation.kind === 'logged_past') continue
    const applied = vacation.appliedDeductions ?? []
    appliedDeductions[vacation.id] = [...applied]
    vacationActuals[vacation.id] = applied.reduce((total, d) => total + d.hours, 0)
    vacationDebits[vacation.id] = applied.reduce((total, d) => ({
      vacation: total.vacation + d.drawn.vacation,
      sick: total.sick + d.drawn.sick,
      bank: total.bank + d.drawn.bank,
    }), { vacation: 0, sick: 0, bank: 0 })
  }

  for (const { date, hours, vacation } of getScheduledDeductions(state, today)) {
    changedVacationIds.add(vacation.id)
    vacationActuals[vacation.id] += hours
    pending.push({
      date,
      order: 2,
      apply: () => {
        const breakdown = applyDeduction(hours, vacation.hourSource || 'any', pools)
        const drawn = { vacation: 0, sick: 0, bank: 0 }
        for (const draw of breakdown) {
          // Stored profile balances use hundredths. Store matching precision
          // for refunds so a depleted fractional accrual cannot reintroduce
          // a value such as 3.076 when the recorded balance was 3.08.
          const recordedDraw = r2(draw.amount)
          vacationDebits[vacation.id][draw.from] = r2(vacationDebits[vacation.id][draw.from] + recordedDraw)
          drawn[draw.from] = r2(drawn[draw.from] + recordedDraw)
          if (draw.amount === 0) continue
          events.push({
            date: format(date, 'yyyy-MM-dd'),
            type: 'vacation_deduction',
            pool: draw.from,
            delta: -draw.amount,
            label: vacation.note ? `Time off — ${vacation.note}` : 'Time off',
          })
        }
        // A zero draw is still an applied day; recording it prevents a later
        // payday from silently funding a past shortage on the next app open.
        appliedDeductions[vacation.id].push({ date: format(date, 'yyyy-MM-dd'), hours, drawn })
      },
    })
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
    changedVacationIds.size === 0
      ? state.plannedVacations
      : state.plannedVacations.map((v) => {
          if (!changedVacationIds.has(v.id)) return v
          const finalized = finalizedVacationIds.has(v.id)
          return {
            ...v,
            kind: finalized ? 'logged_past' as const : v.kind,
            // Active actual-hours totals remain the original whole-trip plan.
            // Finalized totals describe only this entry's reconciled days.
            actualHoursUsed: finalized ? r2(vacationActuals[v.id]) : v.actualHoursUsed,
            debitedFrom: {
              vacation: r2(vacationDebits[v.id].vacation),
              sick: r2(vacationDebits[v.id].sick),
              bank: r2(vacationDebits[v.id].bank),
            },
            appliedDeductions: appliedDeductions[v.id],
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
