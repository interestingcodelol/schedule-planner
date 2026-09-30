import { useMemo, useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { format, parseISO } from 'date-fns'
import { AlertTriangle, ChevronDown, Clock, HeartPulse } from 'lucide-react'
import { useAppState } from '../context'
import { getCurrentBalanceSummary } from '../lib/projection'
import { getNowInZone } from '../lib/timeUtils'
import { BankCard } from './BankCard'

function fmt(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2)
}

export function BalanceSummary({ children }: { children?: ReactNode }) {
  const { state } = useAppState()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const [detailsMaxHeight, setDetailsMaxHeight] = useState<number>()
  const sizeDetails = useCallback(() => {
    const details = detailsRef.current
    if (details?.open)
      setDetailsMaxHeight(
        Math.max(0, window.innerHeight - details.getBoundingClientRect().bottom - 12),
      )
  }, [])
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      const details = detailsRef.current
      if (details?.open && !details.contains(event.target as Node)) details.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && detailsRef.current?.open) detailsRef.current.open = false
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', sizeDetails)
    window.addEventListener('scroll', sizeDetails, true)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', sizeDetails)
      window.removeEventListener('scroll', sizeDetails, true)
    }
  }, [sizeDetails])
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
    <section aria-label="Your balance">
      <div
        data-testid="balance-card-grid"
        className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 ${showBank ? 'xl:grid-cols-7' : 'xl:grid-cols-6'} gap-2 sm:gap-3 auto-rows-fr`}
      >
        <details
          ref={detailsRef}
          onToggle={sizeDetails}
          className="group relative col-span-2 sm:col-span-3 md:col-span-2 xl:col-span-1 glass-card rounded-xl min-w-0 h-full open:z-40"
          aria-label={`Available now: ${fmt(available.total)} hours`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.open = false
              event.currentTarget.querySelector('summary')?.focus()
              event.stopPropagation()
            }
          }}
        >
          <summary
            aria-label="Balance details"
            className="list-none cursor-pointer px-3 py-2.5 h-full rounded-xl hover:bg-white/50 dark:hover:bg-gray-800/30 [&::-webkit-details-marker]:hidden"
          >
            <div className="flex items-center justify-between min-h-5 text-xs font-medium text-gray-500 dark:text-gray-400">
              Available now
              <ChevronDown
                className="w-3.5 h-3.5 text-blue-500 group-open:rotate-180"
                aria-hidden
              />
              <span className="sr-only">Balance details</span>
            </div>
            <div className="mt-0.5 text-lg sm:text-xl font-bold tabular-nums tracking-tight">
              {fmt(available.total)}{' '}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">hrs</span>
            </div>
            <div className="mt-0.5 text-xs leading-snug text-gray-500 dark:text-gray-400">
              {shortfall > 0 ? (
                <span role="status" className="text-amber-700 dark:text-amber-400">
                  {fmt(shortfall)}h uncovered · details
                </span>
              ) : todayUsed > 0 ? (
                `${fmt(todayUsed)}h used today · included`
              ) : (
                'No time off charged today'
              )}
            </div>
          </summary>
          <div
            style={{ maxHeight: detailsMaxHeight }}
            className="absolute left-0 top-full mt-1 w-[min(40rem,calc(100vw-2rem))] max-h-[min(70dvh,calc(100dvh-12rem))] overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-xl"
          >
            <p className="mb-2 text-xs font-medium">
              {todayUsed > 0
                ? `${fmt(todayUsed)} hrs used today, already included`
                : 'No hours charged today'}
            </p>
            {shortfall > 0 && (
              <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
                <span>
                  {fmt(shortfall)} hrs of time off through today could not be covered by the
                  selected leave pools.
                </span>
              </div>
            )}

            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              <span>Today, {format(parseISO(today), 'MMM d')}</span> ·{' '}
              <span>{todayBreakdown || 'Future plans only affect forecasts'}</span>
            </p>
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
        <CompactBalanceCard
          label="Vacation"
          value={fmt(available.vacation)}
          description="Available through today"
          ariaLabel={`Vacation available: ${fmt(available.vacation)} hours`}
          icon={<Clock className="w-3.5 h-3.5 text-blue-500" aria-hidden />}
        />
        <CompactBalanceCard
          label="Sick"
          value={fmt(available.sick)}
          description={`Limit ${fmt(state.policy.sickLeaveMaxBalance)} hrs`}
          ariaLabel={`Sick leave available: ${fmt(available.sick)} hours`}
          icon={<HeartPulse className="w-3.5 h-3.5 text-rose-500" aria-hidden />}
        />
        {showBank && <BankCard embedded />}
        {children}
      </div>
    </section>
  )
}

export function CompactBalanceCard({
  label,
  value,
  description,
  ariaLabel,
  icon,
  unit = 'hrs',
  className = '',
}: {
  className?: string
  label: string
  value: string
  description: ReactNode
  ariaLabel?: string
  icon?: ReactNode
  unit?: string
}) {
  return (
    <div
      className={`glass-card rounded-xl px-3 py-2.5 min-w-0 h-full ${className}`}
      aria-label={ariaLabel}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 min-h-5">
        {icon}
        {label}
      </div>
      <div className="text-lg sm:text-xl font-bold tabular-nums tracking-tight mt-0.5">
        {value} <span className="text-xs font-normal text-gray-500 dark:text-gray-400">{unit}</span>
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
        {description}
      </div>
    </div>
  )
}
