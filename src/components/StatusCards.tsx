import { useMemo } from 'react'
import { format, parseISO, endOfYear, differenceInYears, subDays } from 'date-fns'
import { Calendar, TrendingUp, ArrowUpRight, AlertTriangle } from 'lucide-react'
import { useAppState } from '../context'
import {
  projectBalance,
  getNextPayday,
  computeAccrualTier,
  getCarryoverOutlook,
  accrualForPeriod,
} from '../lib/projection'
import { getNowInZone } from '../lib/timeUtils'
import { BalanceSummary } from './BalanceSummary'

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
    <div className="space-y-3">
      <BalanceSummary />
      <section aria-labelledby="outlook-title" className="px-1">
        <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-2">
          <h2 id="outlook-title" className="text-xs font-semibold text-gray-600 dark:text-gray-300">
            Looking ahead
          </h2>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Forecasts include future plans and accruals
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="flex gap-2.5 items-start rounded-xl border border-gray-200/70 dark:border-gray-700/40 px-3 py-2.5">
            <Calendar className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-xs text-gray-500 dark:text-gray-400">Next payday</h3>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {format(nextPayday, 'MMM d')}{' '}
                <span className="font-normal text-gray-400 dark:text-gray-500">·</span> +
                {fmt(nextAccrual)} hrs
              </p>
              <p className="text-[11px] mt-0.5 text-gray-500 dark:text-gray-400">
                Vacation accrual
              </p>
            </div>
          </div>
          <div className="flex gap-2.5 items-start rounded-xl border border-gray-200/70 dark:border-gray-700/40 px-3 py-2.5">
            <TrendingUp className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-xs text-gray-500 dark:text-gray-400">Vacation earning rate</h3>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {fmt(currentTier.hoursPerPayPeriod)} hrs{' '}
                <span className="font-normal text-gray-500 dark:text-gray-400">/ period</span>
              </p>
              <p className="text-[11px] mt-0.5 text-gray-500 dark:text-gray-400">
                ~{Math.round(annualHours)} hrs/year · {currentTier.label}
              </p>
            </div>
          </div>
          <div
            className={`col-span-2 lg:col-span-1 flex gap-2.5 items-start rounded-xl border px-3 py-2.5 ${exceedsCap ? 'border-amber-400/40 dark:border-amber-500/30 bg-amber-500/5' : 'border-gray-200/70 dark:border-gray-700/40'}`}
          >
            {exceedsCap ? (
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" aria-hidden />
            ) : (
              <ArrowUpRight className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" aria-hidden />
            )}
            <div className="min-w-0">
              <h3 className="text-xs text-gray-500 dark:text-gray-400">Projected Dec 31</h3>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {fmt(yearEnd.totalAvailable)} hrs{' '}
                <span className="font-normal text-gray-500 dark:text-gray-400">
                  across all pools
                </span>
              </p>
              <p className="text-[11px] mt-0.5 text-gray-500 dark:text-gray-400">
                Vacation {fmt(yearEnd.vacationBalance)} · Sick {fmt(yearEnd.sickBalance)}
                {!state.policy.hideBankHours && ` · Bank ${fmt(yearEnd.bankBalance)}`}
              </p>
              {exceedsCap && (
                <p className="text-[11px] mt-1 text-amber-700 dark:text-amber-400">
                  {fmt(carryover.projectedPayout)} vacation hrs may be paid out
                  {carryover.payoutDate ? ` ${format(carryover.payoutDate, 'MMM d')}` : ''} if
                  unused (cap {fmt(carryover.cap!)} hrs)
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
