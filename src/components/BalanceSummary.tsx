import { useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import { AlertTriangle, Check, ChevronDown, Clock, HeartPulse } from 'lucide-react'
import { useAppState } from '../context'
import { getCurrentBalanceSummary } from '../lib/projection'
import { getNowInZone } from '../lib/timeUtils'
import { BankCard } from './BankCard'

function fmt(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2)
}

export function BalanceSummary() {
  const { state } = useAppState()
  const summary = useMemo(() => getCurrentBalanceSummary(state), [state])
  const { stored, deductions, available, todayDeductions, todayUnallocatedHours, shortfall } =
    summary
  const todayUsed = todayDeductions.total + todayUnallocatedHours
  const today = getNowInZone(state.profile.timezone || 'America/New_York').isoDate
  const showBank = !state.policy.hideBankHours
  const pools = [
    { key: 'vacation' as const, label: 'Vacation' },
    { key: 'sick' as const, label: 'Sick' },
    // Imported balances can retain hidden bank hours; keep the total auditable.
    ...(showBank || stored.bank !== 0 || deductions.bank !== 0
      ? [{ key: 'bank' as const, label: 'Bank' }]
      : []),
  ]
  const todayBreakdown = [
    ...pools
      .filter(({ key }) => todayDeductions[key] > 0)
      .map(({ key, label }) => `${fmt(todayDeductions[key])} hrs ${label.toLowerCase()}`),
    ...(todayUnallocatedHours > 0 ? [`${fmt(todayUnallocatedHours)} hrs unspecified pool`] : []),
  ].join(' · ')

  return (
    <section className="glass-card rounded-2xl" aria-labelledby="balance-title">
      <div className="px-4 pt-4 sm:px-5 flex items-center justify-between gap-3">
        <h2 id="balance-title" className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Your balance
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Today, {format(parseISO(today), 'MMM d')}
        </span>
      </div>

      <div className="p-4 sm:px-5 grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_2fr] gap-4 sm:gap-5 items-stretch">
        <div
          className="flex flex-col justify-center"
          aria-label={`Available now: ${fmt(available.total)} hours`}
        >
          <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
            Available now
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl sm:text-[2.75rem] leading-none font-bold tracking-tight tabular-nums">
              {fmt(available.total)}
            </span>
            <span className="text-base text-gray-500 dark:text-gray-400">hrs</span>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Across your leave pools · through today
          </p>
        </div>

        <div className={`grid ${showBank ? 'grid-cols-3' : 'grid-cols-2'} gap-2 sm:gap-3 min-w-0`}>
          <div
            className="rounded-xl border border-gray-200/70 dark:border-gray-700/40 bg-gray-50/70 dark:bg-gray-800/35 p-2 sm:p-4 min-w-0"
            aria-label={`Vacation available: ${fmt(available.vacation)} hours`}
          >
            <div className="flex min-h-5 items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
              <Clock className="w-3.5 h-3.5 text-blue-500 shrink-0" aria-hidden />
              Vacation
            </div>
            <div className="mt-2 text-lg sm:text-2xl font-bold tracking-tight tabular-nums">
              {fmt(available.vacation)}{' '}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">hrs</span>
            </div>
            <p className="mt-1 text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
              Vacation leave
            </p>
          </div>
          <div
            className="rounded-xl border border-gray-200/70 dark:border-gray-700/40 bg-gray-50/70 dark:bg-gray-800/35 p-2 sm:p-4 min-w-0"
            aria-label={`Sick leave available: ${fmt(available.sick)} hours`}
          >
            <div className="flex min-h-5 items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
              <HeartPulse className="w-3.5 h-3.5 text-rose-500 shrink-0" aria-hidden />
              Sick
            </div>
            <div className="mt-2 text-lg sm:text-2xl font-bold tracking-tight tabular-nums">
              {fmt(available.sick)}{' '}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">hrs</span>
            </div>
            <p className="mt-1 text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
              Sick leave
            </p>
          </div>
          {showBank && <BankCard embedded />}
        </div>
      </div>

      {shortfall > 0 && (
        <div
          role="status"
          className="mx-4 sm:mx-5 mb-3 flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span>
            {fmt(shortfall)} hrs of time off through today could not be covered by the selected
            leave pools.
          </span>
        </div>
      )}

      <details className="group border-t border-gray-200/70 dark:border-gray-700/40">
        <summary className="flex list-none cursor-pointer items-center justify-between gap-3 px-4 py-3 sm:px-5 rounded-b-2xl hover:bg-gray-50/70 dark:hover:bg-gray-800/30 transition-colors [&::-webkit-details-marker]:hidden">
          <div className="flex items-start gap-2 min-w-0">
            <Check
              className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5"
              aria-hidden
            />
            <div className="text-xs leading-relaxed">
              <p className="font-medium text-gray-700 dark:text-gray-200">
                {todayUsed > 0
                  ? `${fmt(todayUsed)} hrs used today, already included`
                  : 'No time off charged today'}
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                {todayBreakdown || 'Future plans only affect forecasts'}
              </p>
            </div>
          </div>
          <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 shrink-0">
            Balance details
            <ChevronDown
              className="w-3.5 h-3.5 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </span>
        </summary>
        <div className="px-4 sm:px-5 pb-4">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-3">
            Recorded balance − applied time off = available now
          </p>
          <table className="w-full text-xs tabular-nums text-right">
            <caption className="sr-only">
              How your available leave balance is calculated, in hours
            </caption>
            <thead className="text-gray-500 dark:text-gray-400">
              <tr>
                <th scope="col" className="pb-2 text-left font-medium">
                  Hours
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Recorded
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Applied
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Available
                </th>
              </tr>
            </thead>
            <tbody className="text-gray-700 dark:text-gray-200">
              {pools.map(({ key, label }) => (
                <tr key={key} className="border-t border-gray-100 dark:border-gray-800">
                  <th scope="row" className="py-2 text-left font-medium">
                    {label}
                  </th>
                  <td className="py-2">{fmt(stored[key])}</td>
                  <td className="py-2 text-gray-500 dark:text-gray-400">
                    {deductions[key] > 0 ? '−' : ''}
                    {fmt(deductions[key])}
                  </td>
                  <td className="py-2 font-semibold">{fmt(available[key])}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-gray-200 dark:border-gray-700 font-semibold text-gray-800 dark:text-gray-100">
              <tr>
                <th scope="row" className="pt-2 text-left">
                  Total
                </th>
                <td className="pt-2">{fmt(stored.total)}</td>
                <td className="pt-2">
                  {deductions.total > 0 ? '−' : ''}
                  {fmt(deductions.total)}
                </td>
                <td className="pt-2">{fmt(available.total)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            Recorded includes time off already processed. Applied shows scheduled hours through
            today that are not recorded yet. Each absence is counted once. Future time off and
            future accruals appear in forecasts.
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Sick leave limit: {fmt(state.policy.sickLeaveMaxBalance)} hrs.
          </p>
          {todayUnallocatedHours > 0 && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              An older logged entry has no pool breakdown. Its hours are already included in your
              recorded balance.
            </p>
          )}
        </div>
      </details>
    </section>
  )
}
