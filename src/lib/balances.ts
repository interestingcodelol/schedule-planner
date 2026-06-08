import type { AppState } from './types'

type HourSource = 'vacation' | 'sick' | 'bank' | 'any'

/** Per-pool breakdown of how many hours a debit actually drew from each pool.
 *  Stored on a logged_past entry as `debitedFrom` so a later refund credits the
 *  exact same pools instead of guessing. */
export type PoolBreakdown = { vacation: number; sick: number; bank: number }

/** Result of a debit: the new pool balances PLUS the per-pool amounts that were
 *  actually deducted. Callers persist `drawn` into the entry's `debitedFrom` so
 *  the refund side is symmetric with the debit side. */
export type DebitResult = {
  balances: PoolBreakdown
  drawn: PoolBreakdown
}

/** Subtract hours from the matching pool. For 'any', drain bank → vacation → sick.
 *  Returns both the new balances and the per-pool breakdown actually deducted. */
export function applyDebit(
  state: AppState,
  hours: number,
  source: HourSource,
): DebitResult {
  let vacation = state.profile.currentVacationHours
  let sick = state.profile.currentSickHours
  let bank = state.profile.currentBankHours
  const drawn: PoolBreakdown = { vacation: 0, sick: 0, bank: 0 }
  if (source === 'vacation') {
    vacation -= hours
    drawn.vacation = hours
  } else if (source === 'sick') {
    sick -= hours
    drawn.sick = hours
  } else if (source === 'bank') {
    bank -= hours
    drawn.bank = hours
  } else {
    let remaining = hours
    const fromBank = Math.min(remaining, Math.max(0, bank))
    bank -= fromBank
    remaining -= fromBank
    drawn.bank = fromBank
    if (remaining > 0) {
      const fromVaca = Math.min(remaining, Math.max(0, vacation))
      vacation -= fromVaca
      remaining -= fromVaca
      drawn.vacation = fromVaca
    }
    if (remaining > 0) {
      const fromSick = Math.min(remaining, Math.max(0, sick))
      sick -= fromSick
      drawn.sick = fromSick
    }
  }
  return { balances: { vacation, sick, bank }, drawn }
}

/** Refund hours to the matching pool. 'any' credits back to vacation. Used as
 *  the fallback for older entries that have no recorded `debitedFrom`. */
export function applyRefund(
  state: AppState,
  hours: number,
  source: HourSource,
): PoolBreakdown {
  const vacation = state.profile.currentVacationHours
  const sick = state.profile.currentSickHours
  const bank = state.profile.currentBankHours
  if (source === 'sick') return { vacation, sick: sick + hours, bank }
  if (source === 'bank') return { vacation, sick, bank: bank + hours }
  return { vacation: vacation + hours, sick, bank }
}

/** Refund an entry's exact recorded per-pool breakdown back to those pools.
 *  Used when `debitedFrom` is present so a bank-only debit refunds to bank,
 *  not vacation. */
export function applyBreakdownRefund(
  state: AppState,
  breakdown: PoolBreakdown,
): PoolBreakdown {
  return {
    vacation: state.profile.currentVacationHours + breakdown.vacation,
    sick: state.profile.currentSickHours + breakdown.sick,
    bank: state.profile.currentBankHours + breakdown.bank,
  }
}
