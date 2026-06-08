import { useMemo, useState } from 'react'
import {
  addDays,
  endOfYear,
  format,
  parseISO,
  startOfDay,
} from 'date-fns'
import { TrendingUp, AlertTriangle, HeartPulse } from 'lucide-react'
import { useAppState } from '../context'
import {
  carryoverCapForDate,
  getCarryoverOutlook,
  getSickOutlook,
  projectBalance,
} from '../lib/projection'
import { ForecastChart, type ThresholdLine } from './ForecastChart'

type Mode = 'vacation' | 'sick'

const ACCENT: Record<Mode, string> = {
  vacation: '59, 130, 246', // blue-500
  sick: '244, 63, 94', // rose-500
}

const fmtH = (n: number) =>
  Number.isInteger(n) ? `${n}h` : `${(Math.round(n * 10) / 10).toFixed(1)}h`
const fmtHRound = (n: number) => `${Math.round(n)}h`

export function BalanceForecast() {
  const { state } = useAppState()
  const [mode, setMode] = useState<Mode>('vacation')

  const today = useMemo(() => startOfDay(new Date()), [])
  const yearEnd = useMemo(() => endOfYear(today), [today])

  // Tier-boundary anniversaries inside the range — inserted as explicit sample
  // x's so the vacation cap line steps crisply on the anniversary rather than
  // snapping to the nearest weekly sample.
  const anniversaries = useMemo(() => {
    const hire = parseISO(state.profile.hireDate)
    const out: Date[] = []
    for (const tier of state.policy.accrualTiers) {
      if (tier.minYears <= 0) continue
      const anniv = new Date(
        hire.getFullYear() + tier.minYears,
        hire.getMonth(),
        hire.getDate(),
      )
      if (anniv > today && anniv <= yearEnd) out.push(anniv)
    }
    return out
  }, [state.profile.hireDate, state.policy.accrualTiers, today, yearEnd])

  // Sample the active series weekly (plus today, year-end, and any anniversaries
  // for vacation). Only the selected mode is projected, so toggling is cheap.
  const samples = useMemo(() => {
    const pick = (d: Date) =>
      mode === 'vacation'
        ? projectBalance(state, d).vacationBalance
        : projectBalance(state, d).sickBalance

    const dates: Date[] = [today]
    let cursor = addDays(today, 7)
    while (cursor <= yearEnd) {
      dates.push(cursor)
      cursor = addDays(cursor, 7)
    }
    dates.push(yearEnd)
    if (mode === 'vacation') dates.push(...anniversaries)

    // Sort + dedup by ISO day.
    const seen = new Set<string>()
    const unique = dates
      .sort((a, b) => a.getTime() - b.getTime())
      .filter((d) => {
        const iso = format(d, 'yyyy-MM-dd')
        if (seen.has(iso)) return false
        seen.add(iso)
        return true
      })
    return unique.map((d) => ({ date: d, value: pick(d) }))
  }, [state, mode, today, yearEnd, anniversaries])

  const valueAt = (d: Date) =>
    mode === 'vacation'
      ? projectBalance(state, d).vacationBalance
      : projectBalance(state, d).sickBalance

  const tooltipSecondary = (d: Date) => {
    const p = projectBalance(state, d)
    return mode === 'vacation'
      ? `${fmtH(p.totalAvailable)} total available`
      : `${fmtH(p.sickBalance)} of ${fmtHRound(state.policy.sickLeaveMaxBalance)} max`
  }

  const thresholds: ThresholdLine[] = useMemo(() => {
    if (mode === 'vacation') {
      // Tier-aware cap → stepped line (null when unlimited omits it entirely).
      const sample = carryoverCapForDate(state, today)
      if (sample === null && carryoverCapForDate(state, yearEnd) === null) return []
      return [{ key: 'vac-cap', valueAt: (d) => carryoverCapForDate(state, d) }]
    }
    const lines: ThresholdLine[] = [
      { key: 'sick-max', valueAt: () => state.policy.sickLeaveMaxBalance },
    ]
    if (state.policy.sickLeaveCarryoverCap !== undefined) {
      lines.push({ key: 'sick-carry', valueAt: () => state.policy.sickLeaveCarryoverCap ?? null })
    }
    return lines
  }, [mode, state, today, yearEnd])

  const startVal = samples[0].value
  const endVal = samples[samples.length - 1].value
  const delta = endVal - startVal

  const carryover = useMemo(() => getCarryoverOutlook(state), [state])
  const sick = useMemo(() => getSickOutlook(state), [state])

  // When the vacation cap rises before the next payout (an anniversary lands in
  // between), surface the month so the higher cap on the chart makes sense.
  const capRiseNote = useMemo(() => {
    if (mode !== 'vacation' || carryover.cap === null) return null
    const capToday = carryoverCapForDate(state, today)
    if (capToday === null || capToday >= carryover.cap) return null
    // The anniversary that raises the cap (first whose cap exceeds today's).
    const riser = anniversaries.find(
      (a) => (carryoverCapForDate(state, a) ?? 0) > capToday,
    )
    return riser
      ? `cap rises to ${fmtHRound(carryover.cap)} after your ${format(riser, 'MMMM')} work anniversary`
      : `cap rises to ${fmtHRound(carryover.cap)} at your next work anniversary`
  }, [mode, carryover.cap, state, today, anniversaries])

  const accent = ACCENT[mode]
  const title = mode === 'vacation' ? 'Vacation Hours Forecast' : 'Sick Leave Forecast'
  const Icon = mode === 'vacation' ? TrendingUp : HeartPulse

  return (
    <div className="glass-card rounded-2xl overflow-hidden flex flex-col h-full">
      <div className="px-4 pt-3 pb-2 flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={`w-4 h-4 ${mode === 'vacation' ? 'text-blue-500' : 'text-rose-500'}`} />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300 truncate">
            {title}
          </h3>
        </div>

        {/* Vacation / Sick toggle — one card, two charts. */}
        <div
          className="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold"
          role="tablist"
          aria-label="Forecast type"
        >
          {(['vacation', 'sick'] as Mode[]).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 rounded-md transition-colors ${
                mode === m
                  ? 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {m === 'vacation' ? 'Vacation' : 'Sick'}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-baseline gap-2 text-sm tabular-nums">
          <span className="font-bold text-gray-700 dark:text-gray-100">{fmtH(startVal)}</span>
          <span className="text-gray-400 dark:text-gray-500 text-xs">→ Dec 31</span>
          <span className="font-bold text-gray-700 dark:text-gray-100">{fmtH(endVal)}</span>
          <span
            className={`text-sm font-bold inline-flex items-center gap-0.5 ${
              delta >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            }`}
            aria-label={
              delta >= 0
                ? `up ${fmtH(Math.abs(delta))} from now`
                : `down ${fmtH(Math.abs(delta))} from now`
            }
          >
            <span aria-hidden>{delta >= 0 ? '▲' : '▼'}</span>
            {fmtH(Math.abs(delta))}
          </span>
        </div>
      </div>

      <ForecastChart
        samples={samples}
        thresholds={thresholds}
        valueAt={valueAt}
        today={today}
        rangeEnd={yearEnd}
        accentRgb={accent}
        formatValue={fmtH}
        tooltipSecondary={tooltipSecondary}
        fill
        ariaLabel={
          mode === 'vacation'
            ? 'Projected vacation balance from today through end of year'
            : 'Projected sick balance from today through end of year'
        }
      />

      {mode === 'vacation' && carryover.cap !== null && (
        <div className="px-4 pb-3 pt-1.5 text-xs text-gray-500 dark:text-gray-400 flex items-start gap-1.5 leading-snug shrink-0">
          {carryover.projectedPayout > 0 ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
              {/* Reconciling breakdown: year-end balance → cap → amount paid out.
                  Only the over-the-cap amount is paid; new-year accruals carry on. */}
              <span>
                Year-end{' '}
                <span className="text-gray-700 dark:text-gray-200 font-semibold tabular-nums">
                  {fmtH(endVal)}
                </span>
                {' → cap '}
                <span className="text-gray-700 dark:text-gray-200 font-semibold tabular-nums">
                  {fmtHRound(carryover.cap)}
                </span>
                {' → '}
                <span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
                  {fmtH(carryover.projectedPayout)}
                </span>
                {' paid out'}
                {carryover.payoutDate
                  ? ` ${format(carryover.payoutDate, 'MMM d')}`
                  : ' on the first February pay date'}{' '}
                if unused{capRiseNote ? ` (${capRiseNote})` : ''}.
              </span>
            </>
          ) : (
            <span>
              Dashed line is your vacation carry-over cap of{' '}
              <span className="text-gray-700 dark:text-gray-200 font-semibold tabular-nums">
                {fmtHRound(carryover.cap)}
              </span>
              {capRiseNote ? ` — ${capRiseNote}` : '.'}
            </span>
          )}
        </div>
      )}

      {mode === 'sick' && (
        <div className="px-4 pb-3 pt-1.5 text-xs text-gray-500 dark:text-gray-400 flex items-start gap-1.5 leading-snug shrink-0">
          {sick.projectedForfeit > 0 ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
              <span>
                About{' '}
                <span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
                  {fmtH(sick.projectedForfeit)}
                </span>
                {' '}forfeited on Jan 1 — over the{' '}
                <span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
                  {fmtHRound(sick.carryoverCap ?? 0)}
                </span>
                {' '}carry-over limit. Sick time isn't paid out, so use it or lose it.
              </span>
            </>
          ) : (
            <span>
              {sick.carryoverCap !== undefined && (
                <>
                  Carry-over limit{' '}
                  <span className="text-gray-700 dark:text-gray-200 font-semibold tabular-nums">
                    {fmtHRound(sick.carryoverCap)}
                  </span>
                  {' · '}
                </>
              )}
              Annual max{' '}
              <span className="text-gray-700 dark:text-gray-200 font-semibold tabular-nums">
                {fmtHRound(sick.maxBalance)}
              </span>
              . Unused sick hours aren't paid out.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
