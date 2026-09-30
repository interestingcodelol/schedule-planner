import { useMemo } from 'react'
import { format, parseISO, endOfYear, differenceInYears, subDays } from 'date-fns'
import { Calendar, TrendingUp } from 'lucide-react'
import { useAppState } from '../context'
import {
  projectBalance,
  getNextPayday,
  computeAccrualTier,
  getCarryoverOutlook,
  accrualForPeriod,
} from '../lib/projection'
import { getNowInZone } from '../lib/timeUtils'
import { BalanceSummary, CompactBalanceCard } from './BalanceSummary'

function fmt(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2)
}

export function StatusCards() {
  const { state } = useAppState()
  const todayIso = getNowInZone(state.profile.timezone || 'America/New_York').isoDate
  const outlook = useMemo(() => {
    const today = parseISO(todayIso)
    const lastPayday = parseISO(state.profile.lastPaydayDate)
    const hireDate = parseISO(state.profile.hireDate)
    const nextPayday = getNextPayday(lastPayday, state.policy.payPeriodLengthDays, today)
    const periodStart = subDays(nextPayday, Math.max(1, state.policy.payPeriodLengthDays))
    const currentTier = computeAccrualTier(state.policy, differenceInYears(today, hireDate))
    return {
      nextPayday,
      nextAccrual: accrualForPeriod(state.policy, hireDate, periodStart, nextPayday),
      currentTier,
      annualHours:
        currentTier.hoursPerPayPeriod * Math.round(365 / state.policy.payPeriodLengthDays),
      yearEnd: projectBalance(state, endOfYear(today)),
      carryover: getCarryoverOutlook(state),
    }
  }, [state, todayIso])
  const { nextPayday, nextAccrual, currentTier, annualHours, yearEnd, carryover } = outlook
  const exceedsCap = carryover.projectedPayout > 0

  return (
    <BalanceSummary>
      <CompactBalanceCard
        label="Accrual rate"
        value={String(Math.round(annualHours))}
        unit="hrs/yr"
        icon={<TrendingUp className="w-3.5 h-3.5 text-blue-500" aria-hidden />}
        description={`${fmt(currentTier.hoursPerPayPeriod)} hrs/period`}
      />
      <CompactBalanceCard
        label="Next payday"
        value={format(nextPayday, 'MMM d')}
        unit=""
        icon={<Calendar className="w-3.5 h-3.5 text-blue-500" aria-hidden />}
        description={`+${fmt(nextAccrual)} hrs vacation`}
      />
      <CompactBalanceCard
        label="Year-end forecast"
        value={fmt(yearEnd.totalAvailable)}
        description={
          exceedsCap ? (
            <span className="text-amber-700 dark:text-amber-400">
              {fmt(carryover.projectedPayout)} vacation hrs may pay out
            </span>
          ) : (
            'Includes future plans'
          )
        }
      />
    </BalanceSummary>
  )
}
