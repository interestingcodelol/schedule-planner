import type { PolicyConfig } from '../types'

/** The bank payout schedule used before Dec 31 became the default: payouts on
 *  the first payday on/after Dec 15 and Feb 15. Still a supported setting, and
 *  what policies saved before the timing option existed keep using. */
export const LEGACY_BANK_POLICY: Pick<
  PolicyConfig,
  'bankHoursPayoutStart' | 'bankHoursPayoutEnd' | 'bankHoursPayoutTiming'
> = {
  bankHoursPayoutStart: { month: 12, day: 15 },
  bankHoursPayoutEnd: { month: 2, day: 15 },
  bankHoursPayoutTiming: undefined,
}
