import { useMemo, useRef, useState } from 'react'
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInYears,
  endOfYear,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
} from 'date-fns'
import { TrendingUp, AlertTriangle } from 'lucide-react'
import { useAppState } from '../context'
import { computeAccrualTier, projectBalance } from '../lib/projection'

export function BalanceForecast() {
  const { state } = useAppState()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverDate, setHoverDate] = useState<Date | null>(null)

  const today = useMemo(() => startOfDay(new Date()), [])
  const yearEnd = useMemo(() => endOfYear(today), [today])
  const totalDaysInRange = useMemo(
    () => Math.max(1, differenceInCalendarDays(yearEnd, today)),
    [today, yearEnd],
  )

  const samples = useMemo(() => {
    const out: Array<{ date: Date; total: number }> = []
    out.push({ date: today, total: projectBalance(state, today).totalAvailable })
    let cursor = addDays(today, 7)
    while (cursor <= yearEnd) {
      out.push({ date: cursor, total: projectBalance(state, cursor).totalAvailable })
      cursor = addDays(cursor, 7)
    }
    if (out[out.length - 1].date.getTime() !== yearEnd.getTime()) {
      out.push({ date: yearEnd, total: projectBalance(state, yearEnd).totalAvailable })
    }
    return out
  }, [state, today, yearEnd])

  const carryoverCap = useMemo(() => {
    if (state.policy.carryoverCapStrategy === 'unlimited') return null
    if (state.policy.carryoverCapStrategy === 'fixed_hours') {
      return state.policy.carryoverFixedCap ?? null
    }
    const yos = differenceInYears(new Date(), parseISO(state.profile.hireDate))
    const tier = computeAccrualTier(state.policy, yos)
    const periodsPerYear = Math.round(365 / state.policy.payPeriodLengthDays)
    return tier.hoursPerPayPeriod * periodsPerYear
  }, [state.policy, state.profile.hireDate])

  const W = 320
  const H = 84
  const PAD_L = 6
  const PAD_R = 6
  const PAD_T = 8
  const PAD_B = 16
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const dataMax = Math.max(...samples.map((s) => s.total), carryoverCap ?? 0)
  const yMin = 0
  const yMax = Math.max(dataMax * 1.12, 1)
  const yRange = yMax - yMin || 1

  const xForDate = (date: Date) => {
    const offset = differenceInCalendarDays(date, today)
    const frac = Math.max(0, Math.min(1, offset / totalDaysInRange))
    return PAD_L + frac * innerW
  }
  const xForIndex = (i: number) => xForDate(samples[i].date)
  const yFor = (v: number) => PAD_T + innerH - ((v - yMin) / yRange) * innerH

  const linePath = samples
    .map(
      (s, i) =>
        `${i === 0 ? 'M' : 'L'} ${xForIndex(i).toFixed(2)} ${yFor(s.total).toFixed(2)}`,
    )
    .join(' ')
  const baselineY = yFor(yMin)
  const areaPath = `${linePath} L ${xForIndex(samples.length - 1).toFixed(2)} ${baselineY.toFixed(2)} L ${xForIndex(0).toFixed(2)} ${baselineY.toFixed(2)} Z`

  const capY = carryoverCap !== null ? yFor(carryoverCap) : null
  const capExceeded =
    carryoverCap !== null && samples.some((s) => s.total > carryoverCap)
  const yearEndHours = samples[samples.length - 1].total
  const todayHours = samples[0].total
  const yearEndDelta = yearEndHours - todayHours

  const monthTicks = useMemo(() => {
    const ticks: Array<{ x: number; label: string }> = []
    let cursor = startOfMonth(addMonths(today, 1))
    let idx = 0
    while (cursor <= yearEnd) {
      const monthsRemaining = (yearEnd.getMonth() - cursor.getMonth() + 12) % 12
      const shouldShow = monthsRemaining > 5 ? idx % 2 === 0 : true
      if (shouldShow) {
        const offset = differenceInCalendarDays(cursor, today)
        const frac = Math.max(0, Math.min(1, offset / totalDaysInRange))
        ticks.push({ x: PAD_L + frac * innerW, label: format(cursor, 'MMM') })
      }
      cursor = addMonths(cursor, 1)
      idx++
    }
    return ticks
  }, [today, yearEnd, totalDaysInRange, innerW])

  const hoverProjection = useMemo(() => {
    if (!hoverDate) return null
    return projectBalance(state, hoverDate).totalAvailable
  }, [state, hoverDate])

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const scale = W / rect.width
    const svgX = (e.clientX - rect.left) * scale
    const frac = Math.max(0, Math.min(1, (svgX - PAD_L) / innerW))
    const dayOffset = Math.round(frac * totalDaysInRange)
    setHoverDate(addDays(today, dayOffset))
  }
  const onPointerLeave = () => setHoverDate(null)

  const hoverX = hoverDate ? xForDate(hoverDate) : null
  const hoverY = hoverProjection !== null ? yFor(hoverProjection) : null
  const tooltipLeftPct =
    hoverX !== null ? Math.max(14, Math.min(86, (hoverX / W) * 100)) : 50

  const fmtH = (n: number) =>
    Number.isInteger(n) ? `${n}h` : `${(Math.round(n * 10) / 10).toFixed(1)}h`
  const fmtHRound = (n: number) => `${Math.round(n)}h`

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-baseline gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
            Forecast
          </h3>
        </div>
        <div className="ml-auto flex items-baseline gap-2 text-sm tabular-nums">
          <span className="font-bold text-gray-700 dark:text-gray-100">
            {fmtH(todayHours)}
          </span>
          <span className="text-gray-400 dark:text-gray-500 text-xs">→ Dec 31</span>
          <span className="font-bold text-gray-700 dark:text-gray-100">
            {fmtH(yearEndHours)}
          </span>
          <span
            className={`text-sm font-bold inline-flex items-center gap-0.5 ${
              yearEndDelta >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            }`}
            aria-label={
              yearEndDelta >= 0
                ? `up ${fmtH(Math.abs(yearEndDelta))} from now`
                : `down ${fmtH(Math.abs(yearEndDelta))} from now`
            }
          >
            <span aria-hidden>{yearEndDelta >= 0 ? '▲' : '▼'}</span>
            {fmtH(Math.abs(yearEndDelta))}
          </span>
        </div>
      </div>

      <div className="px-3 pb-1">
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto cursor-crosshair touch-none text-gray-500 dark:text-gray-400"
            onPointerMove={onPointerMove}
            onPointerDown={onPointerMove}
            onPointerLeave={onPointerLeave}
            role="img"
            aria-label="Projected total hours from today through end of year"
          >
            <defs>
              <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(59, 130, 246)" stopOpacity="0.38" />
                <stop offset="100%" stopColor="rgb(59, 130, 246)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {capY !== null && (
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={capY}
                y2={capY}
                stroke="rgb(148, 163, 184)"
                strokeWidth="0.75"
                strokeDasharray="2 3"
                strokeOpacity="0.6"
              />
            )}

            <path d={areaPath} fill="url(#forecastGrad)" />
            <path
              d={linePath}
              fill="none"
              stroke="rgb(59, 130, 246)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            <circle
              cx={xForIndex(0)}
              cy={yFor(samples[0].total)}
              r="2.25"
              fill="rgb(59, 130, 246)"
              stroke="white"
              strokeWidth="1.25"
            />

            {monthTicks.map((t, i) => (
              <text
                key={i}
                x={t.x}
                y={H - 4}
                textAnchor="middle"
                fontSize="7.5"
                fill="currentColor"
                fillOpacity="0.5"
              >
                {t.label}
              </text>
            ))}

            {hoverX !== null && hoverY !== null && (
              <g pointerEvents="none">
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={PAD_T}
                  y2={H - PAD_B}
                  stroke="currentColor"
                  strokeOpacity="0.4"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={hoverX}
                  cy={hoverY}
                  r="2.75"
                  fill="rgb(59, 130, 246)"
                  stroke="white"
                  strokeWidth="1.5"
                />
              </g>
            )}
          </svg>

          {hoverDate && hoverProjection !== null && (
            <div
              className="absolute pointer-events-none -translate-x-1/2 -translate-y-1 bg-gray-900 dark:bg-gray-800 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap ring-1 ring-white/10"
              style={{ left: `${tooltipLeftPct}%`, top: 0 }}
            >
              <span className="font-bold tabular-nums">{fmtH(hoverProjection)}</span>
              <span className="text-gray-300 ml-1.5">{format(hoverDate, 'EEE, MMM d')}</span>
            </div>
          )}
        </div>
      </div>

      {carryoverCap !== null && (
        <div className="px-4 pb-3 pt-1.5 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5 leading-snug">
          {capExceeded ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>
                Vacation cap{' '}
                <span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
                  {fmtHRound(carryoverCap)}
                </span>{' '}
                — projected to exceed; excess is paid out in February.
              </span>
            </>
          ) : (
            <span>
              Dashed line is your vacation carryover cap of{' '}
              <span className="text-gray-700 dark:text-gray-200 font-semibold tabular-nums">
                {fmtHRound(carryoverCap)}
              </span>
              .
            </span>
          )}
        </div>
      )}
    </div>
  )
}
