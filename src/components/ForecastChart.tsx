import { useMemo, useRef, useState } from 'react'
import {
  addMonths,
  differenceInCalendarDays,
  format,
  startOfMonth,
} from 'date-fns'

export type ThresholdLine = {
  /** Distinct key for React list rendering. */
  key: string
  /** The threshold value at a given date, or null to omit the line there.
   *  A constant return draws a flat line; a date-dependent return (e.g. a
   *  tier-aware cap) draws a stepped line. */
  valueAt: (date: Date) => number | null
}

type Props = {
  /** Sampled series points (already sorted ascending by date). */
  samples: { date: Date; value: number }[]
  /** Dashed reference lines (caps / limits) drawn behind the series. */
  thresholds?: ThresholdLine[]
  /** Precise series value at an arbitrary hovered date. */
  valueAt: (date: Date) => number
  /** Start (today) and end of the x-axis range. */
  today: Date
  rangeEnd: Date
  /** Accent color as an "r, g, b" triple, e.g. "59, 130, 246". */
  accentRgb: string
  /** Format a series value for the tooltip. */
  formatValue: (n: number) => string
  /** Optional second tooltip line for the hovered date. */
  tooltipSecondary?: (date: Date) => string | null
  ariaLabel: string
  /** When true, the chart grows to fill its flex parent's height (the viewBox
   *  height tracks the container's pixel aspect ratio so it scales uniformly —
   *  no distortion). When false, it keeps a fixed compact aspect. */
  fill?: boolean
}

const W = 320
const DEFAULT_H = 84
const PAD_L = 6
const PAD_R = 6
const PAD_T = 8
const PAD_B = 16
const innerW = W - PAD_L - PAD_R

/**
 * Presentational sparkline shared by the vacation and sick forecasts: filled
 * area + series line + stepped dashed thresholds + month ticks + a hover
 * crosshair/tooltip. Pure geometry — all series/cap data is supplied by the
 * parent so the same chart renders either leave type.
 */
export function ForecastChart({
  samples,
  thresholds = [],
  valueAt,
  today,
  rangeEnd,
  accentRgb,
  formatValue,
  tooltipSecondary,
  ariaLabel,
  fill = false,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverDate, setHoverDate] = useState<Date | null>(null)

  // Fixed, width-driven aspect (h-auto): the rendered height follows the card
  // WIDTH, never the viewport height — so the sparkline can't balloon on a
  // tall/fullscreen screen (that was the production bug). In fill mode the card
  // stretches to sit flush with the calendar and the chart is centered in it,
  // keeping the page short enough to avoid a scrollbar at maximized heights.
  const H = DEFAULT_H
  const innerH = H - PAD_T - PAD_B

  const totalDaysInRange = Math.max(1, differenceInCalendarDays(rangeEnd, today))

  // Y scale spans 0 → a little above the tallest of the series and every
  // threshold value across the sampled dates, so cap lines always fit.
  const thresholdMax = useMemo(() => {
    let m = 0
    for (const t of thresholds) {
      for (const s of samples) {
        const v = t.valueAt(s.date)
        if (v !== null && v > m) m = v
      }
    }
    return m
  }, [thresholds, samples])

  const dataMax = Math.max(...samples.map((s) => s.value), thresholdMax, 1)
  const yMax = Math.max(dataMax * 1.12, 1)
  const yRange = yMax || 1

  const xForDate = (date: Date) => {
    const offset = differenceInCalendarDays(date, today)
    const frac = Math.max(0, Math.min(1, offset / totalDaysInRange))
    return PAD_L + frac * innerW
  }
  const yFor = (v: number) => PAD_T + innerH - (v / yRange) * innerH

  const linePath = samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${xForDate(s.date).toFixed(2)} ${yFor(s.value).toFixed(2)}`)
    .join(' ')
  const baselineY = yFor(0)
  const lastX = xForDate(samples[samples.length - 1].date)
  const firstX = xForDate(samples[0].date)
  const areaPath = `${linePath} L ${lastX.toFixed(2)} ${baselineY.toFixed(2)} L ${firstX.toFixed(2)} ${baselineY.toFixed(2)} Z`

  // Step-after path for a threshold: hold each value to the next x, then step
  // vertically. Gaps (null) break the path into separate segments.
  const thresholdPaths = thresholds.map((t) => {
    let d = ''
    let prev: { x: number; y: number } | null = null
    for (const s of samples) {
      const v = t.valueAt(s.date)
      if (v === null) {
        prev = null
        continue
      }
      const x = xForDate(s.date)
      const y = yFor(v)
      if (prev === null) {
        d += `${d ? ' ' : ''}M ${x.toFixed(2)} ${y.toFixed(2)}`
      } else {
        d += ` L ${x.toFixed(2)} ${prev.y.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`
      }
      prev = { x, y }
    }
    return { key: t.key, d }
  })

  const monthTicks = useMemo(() => {
    const ticks: Array<{ x: number; label: string }> = []
    let cursor = startOfMonth(addMonths(today, 1))
    let idx = 0
    while (cursor <= rangeEnd) {
      const monthsRemaining = (rangeEnd.getMonth() - cursor.getMonth() + 12) % 12
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
  }, [today, rangeEnd, totalDaysInRange])

  const hoverValue = hoverDate ? valueAt(hoverDate) : null
  const hoverX = hoverDate ? xForDate(hoverDate) : null
  const hoverY = hoverValue !== null ? yFor(hoverValue) : null
  const tooltipLeftPct =
    hoverX !== null ? Math.max(20, Math.min(80, (hoverX / W) * 100)) : 50
  const secondary = hoverDate && tooltipSecondary ? tooltipSecondary(hoverDate) : null

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const scale = W / rect.width
    const svgX = (e.clientX - rect.left) * scale
    const frac = Math.max(0, Math.min(1, (svgX - PAD_L) / innerW))
    const dayOffset = Math.round(frac * totalDaysInRange)
    setHoverDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset))
  }
  const onPointerLeave = () => setHoverDate(null)

  const gradId = `forecastGrad-${accentRgb.replace(/[^0-9]/g, '')}`

  return (
    <div className={`px-3 pb-1 ${fill ? 'lg:flex-1 lg:min-h-0 flex flex-col justify-center' : ''}`}>
      <div className="relative w-full">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto cursor-crosshair touch-none text-gray-500 dark:text-gray-400"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={onPointerLeave}
          role="img"
          aria-label={ariaLabel}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`rgb(${accentRgb})`} stopOpacity="0.38" />
              <stop offset="100%" stopColor={`rgb(${accentRgb})`} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {thresholdPaths.map((t) => (
            <path
              key={t.key}
              d={t.d}
              fill="none"
              stroke="rgb(148, 163, 184)"
              strokeWidth="0.75"
              strokeDasharray="2 3"
              strokeOpacity="0.6"
            />
          ))}

          <path d={areaPath} fill={`url(#${gradId})`} />
          <path
            d={linePath}
            fill="none"
            stroke={`rgb(${accentRgb})`}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <circle
            cx={firstX}
            cy={yFor(samples[0].value)}
            r="2.25"
            fill={`rgb(${accentRgb})`}
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
                fill={`rgb(${accentRgb})`}
                stroke="white"
                strokeWidth="1.5"
              />
            </g>
          )}
        </svg>

        {hoverDate && hoverValue !== null && (
          <div
            className="absolute pointer-events-none -translate-x-1/2 -translate-y-1 bg-gray-900 dark:bg-gray-800 text-white text-[11px] leading-tight px-2 py-1.5 rounded-lg shadow-lg whitespace-nowrap ring-1 ring-white/10"
            style={{ left: `${tooltipLeftPct}%`, top: 0 }}
          >
            <div className="flex items-baseline gap-1.5">
              <span className="font-bold tabular-nums text-[13px]">
                {formatValue(hoverValue)}
              </span>
              <span className="text-gray-400 text-[10px]">
                {format(hoverDate, 'MMM d')}
              </span>
            </div>
            {secondary && (
              <div className="text-gray-400 text-[10px] tabular-nums mt-0.5">
                {secondary}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
