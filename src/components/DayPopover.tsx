import { useState, useEffect, useRef } from 'react'
import { format, isBefore, startOfDay } from 'date-fns'
import { X, Clock, CalendarOff, CalendarCheck, Pencil, History } from 'lucide-react'
import type { PlannedVacation } from '../lib/types'
import {
  hhmmToHours,
  hoursToHHMM,
  formatTimeLabel,
  roundToQuarter,
} from '../lib/timeUtils'

type DayPopoverMode = 'plan' | 'log_past' | 'adjust_past'

type SaveConfig = {
  hoursPerDay?: number
  timeOffStart?: string
  timeOffEnd?: string
  hourSource: 'vacation' | 'sick' | 'bank' | 'any'
  note?: string
  asPastAbsence?: boolean
  adjustActualHoursTo?: number
}

type Props = {
  date: Date
  existing?: PlannedVacation
  hoursPerWorkDay: number
  onSave: (config: SaveConfig) => void
  onRemove: () => void
  onClose: () => void
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString()
}

export function DayPopover({
  date,
  existing,
  hoursPerWorkDay,
  onSave,
  onRemove,
  onClose,
}: Props) {
  const workStart = 8
  const workEnd = workStart + hoursPerWorkDay
  const isPastDay = isBefore(date, startOfDay(new Date()))

  const mode: DayPopoverMode = isPastDay
    ? existing
      ? 'adjust_past'
      : 'log_past'
    : 'plan'

  const [partialOrFull, setPartialOrFull] = useState<'full' | 'partial'>(
    existing?.hoursPerDay !== undefined && existing.hoursPerDay < hoursPerWorkDay
      ? 'partial'
      : 'full',
  )
  const [startTime, setStartTime] = useState(existing?.timeOffStart ?? `${String(workStart).padStart(2, '0')}:00`)
  const [endTime, setEndTime] = useState(
    existing?.timeOffEnd ?? `${String(workStart + Math.floor(hoursPerWorkDay / 2)).padStart(2, '0')}:00`,
  )
  const [source, setSource] = useState<'vacation' | 'sick' | 'bank' | 'any'>(
    existing?.hourSource ?? (mode === 'log_past' ? 'sick' : 'any'),
  )
  const [note, setNote] = useState(existing?.note ?? '')
  const plannedHrs = existing
    ? existing.hoursPerDay ?? hoursPerWorkDay
    : hoursPerWorkDay
  const [actualHours, setActualHours] = useState<number>(
    existing?.actualHoursUsed ?? plannedHrs,
  )
  const modalRef = useRef<HTMLDivElement>(null)

  const hoursOff =
    partialOrFull === 'full'
      ? hoursPerWorkDay
      : Math.max(0, roundToQuarter(hhmmToHours(endTime) - hhmmToHours(startTime)))

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  useEffect(() => {
    modalRef.current?.focus()
  }, [])

  const handleSave = () => {
    if (mode === 'adjust_past') {
      onSave({
        hourSource: source,
        adjustActualHoursTo: roundToQuarter(actualHours),
      })
      return
    }
    const config: SaveConfig = {
      hoursPerDay: partialOrFull === 'partial' ? hoursOff : undefined,
      timeOffStart: partialOrFull === 'partial' ? startTime : undefined,
      timeOffEnd: partialOrFull === 'partial' ? endTime : undefined,
      hourSource: source,
      note: note || undefined,
      asPastAbsence: mode === 'log_past',
    }
    onSave(config)
  }

  // Visualization: continuous bar from workStart → workEnd with off region highlighted.
  const dayHours = workEnd - workStart
  const offStartFrac = Math.max(0, (hhmmToHours(startTime) - workStart) / dayHours)
  const offEndFrac = Math.min(1, (hhmmToHours(endTime) - workStart) / dayHours)
  const workStartHHMM = `${String(workStart).padStart(2, '0')}:00`
  const workEndHHMM = `${String(workEnd).padStart(2, '0')}:00`

  /** Snap a new time to the 15-minute grid in the direction of change, so a
   *  browser that steps minutes by 1 still lands on quarter-hour boundaries. */
  const snapDirectional = (nextHours: number, prevHours: number): number => {
    if (nextHours > prevHours) return Math.ceil(nextHours * 4) / 4
    if (nextHours < prevHours) return Math.floor(nextHours * 4) / 4
    return Math.round(nextHours * 4) / 4
  }

  const clampToDay = (h: number) => Math.max(0, Math.min(23.75, h))

  const onStartChange = (v: string) => {
    const snapped = clampToDay(snapDirectional(hhmmToHours(v), hhmmToHours(startTime)))
    setStartTime(hoursToHHMM(snapped))
    if (snapped >= hhmmToHours(endTime)) {
      setEndTime(hoursToHHMM(Math.min(23.75, snapped + 0.25)))
    }
  }

  const onEndChange = (v: string) => {
    const snapped = clampToDay(snapDirectional(hhmmToHours(v), hhmmToHours(endTime)))
    setEndTime(hoursToHHMM(snapped))
    if (snapped <= hhmmToHours(startTime)) {
      setStartTime(hoursToHHMM(Math.max(0, snapped - 0.25)))
    }
  }

  /** Keep arrow keys inside the modal so they can't leak into the calendar's
   *  month navigation (CalendarView listens for ArrowLeft/Right). */
  const stopArrowPropagation = (e: React.KeyboardEvent) => {
    if (e.key.startsWith('Arrow')) e.stopPropagation()
  }

  if (mode === 'adjust_past' && existing) {
    const diff = roundToQuarter(actualHours) - plannedHrs
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
        onKeyDown={stopArrowPropagation}
      >
        <div
          ref={modalRef}
          tabIndex={-1}
          className="glass-card rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
          role="dialog"
          aria-label={`Adjust actual hours used for ${format(date, 'MMMM d')}`}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200/60 dark:border-gray-700/40">
            <div>
              <div className="text-base font-bold flex items-center gap-2">
                <History className="w-4 h-4 text-amber-500" />
                {format(date, 'EEEE, MMM d')}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Adjust actual hours used
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all"
              title="Close"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Originally
                </div>
                <div className="text-lg font-bold tabular-nums mt-0.5">{fmt(plannedHrs)}h</div>
              </div>
              <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 px-3 py-2.5 border border-blue-200/50 dark:border-blue-800/30">
                <div className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
                  Actually used
                </div>
                <div className="text-lg font-bold tabular-nums mt-0.5">{fmt(actualHours)}h</div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Hours used (15-min increments)
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActualHours((h) => Math.max(0, roundToQuarter(h - 0.25)))}
                  className="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/60 text-sm font-bold"
                  aria-label="Decrease by 15 minutes"
                >
                  −15m
                </button>
                <input
                  type="number"
                  step="0.25"
                  min="0"
                  max={hoursPerWorkDay}
                  value={actualHours}
                  onChange={(e) => setActualHours(Number(e.target.value) || 0)}
                  className="flex-1 px-3 py-2 text-center text-base font-bold tabular-nums bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => setActualHours((h) => Math.min(hoursPerWorkDay, roundToQuarter(h + 0.25)))}
                  className="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/60 text-sm font-bold"
                  aria-label="Increase by 15 minutes"
                >
                  +15m
                </button>
              </div>
              {existing.kind === 'logged_past' && diff !== 0 && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {diff > 0
                    ? `Will deduct ${fmt(diff)} more hour${Math.abs(diff) === 1 ? '' : 's'} from your ${existing.hourSource === 'any' ? 'sick/vacation/bank' : existing.hourSource} balance.`
                    : `Will refund ${fmt(-diff)} hour${Math.abs(diff) === 1 ? '' : 's'} back to your ${existing.hourSource === 'any' ? 'vacation' : existing.hourSource} balance.`}
                </p>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              {!existing.locked && (
                <button
                  onClick={onRemove}
                  className="px-4 py-2.5 text-sm font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-xl transition-colors"
                  title="Remove this entry"
                >
                  Remove
                </button>
              )}
              <button
                onClick={handleSave}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-colors"
              >
                <Pencil className="w-4 h-4" />
                Save adjustment
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onKeyDown={stopArrowPropagation}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="glass-card rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden max-h-[90vh] flex flex-col"
        role="dialog"
        aria-label={`${mode === 'log_past' ? 'Log past absence' : 'Plan time off'} for ${format(date, 'MMMM d')}`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200/60 dark:border-gray-700/40 shrink-0">
          <div>
            <div className="text-base font-bold flex items-center gap-2">
              {mode === 'log_past' && <History className="w-4 h-4 text-rose-500" />}
              {format(date, 'EEEE, MMM d')}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {mode === 'log_past' ? 'Log past absence' : `${fmt(hoursOff)}h off · ${fmt(hoursPerWorkDay - hoursOff)}h working`}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all"
            title="Close"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto scroll-panel">
          {mode === 'log_past' && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200/50 dark:border-rose-800/30 px-3 py-2.5 text-xs text-rose-700 dark:text-rose-300">
              This will deduct hours from your current balance to keep the planner in sync with your timecard system.
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setPartialOrFull('full')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl border-2 transition-all ${
                partialOrFull === 'full'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700/60 hover:border-blue-400'
              }`}
              title="The full day"
            >
              <CalendarOff className="w-4 h-4" />
              Full Day
            </button>
            <button
              onClick={() => {
                setPartialOrFull('partial')
                if (hhmmToHours(endTime) - hhmmToHours(startTime) >= hoursPerWorkDay) {
                  setStartTime(`${String(workStart).padStart(2, '0')}:00`)
                  setEndTime(`${String(workStart + Math.floor(hoursPerWorkDay / 2)).padStart(2, '0')}:00`)
                }
              }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl border-2 transition-all ${
                partialOrFull === 'partial'
                  ? 'bg-sky-600 text-white border-sky-600'
                  : 'bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700/60 hover:border-sky-400'
              }`}
              title="Part of the day (15-minute increments)"
            >
              <Clock className="w-4 h-4" />
              Partial Day
            </button>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">
              Your day ({formatTimeLabel(workStartHHMM)} – {formatTimeLabel(workEndHHMM)})
            </div>
            <div className="relative h-10 rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-700">
              {partialOrFull === 'full' ? (
                <div className="absolute inset-0 bg-blue-500" />
              ) : (
                hoursOff > 0 && (
                  <div
                    className="absolute top-0 bottom-0 bg-sky-500"
                    style={{
                      left: `${offStartFrac * 100}%`,
                      width: `${(offEndFrac - offStartFrac) * 100}%`,
                    }}
                  />
                )
              )}
              <div className="absolute inset-0 flex pointer-events-none">
                {Array.from({ length: dayHours }).map((_, i) => (
                  <div
                    key={i}
                    className="flex-1 border-r border-white/15 last:border-r-0"
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-between items-center mt-1.5">
              <span className="text-xs text-gray-400">{formatTimeLabel(workStartHHMM)}</span>
              <span
                className={`text-xs font-bold ${
                  partialOrFull === 'full'
                    ? 'text-blue-500'
                    : hoursOff > 0
                      ? 'text-sky-500'
                      : 'text-gray-400'
                }`}
              >
                {fmt(hoursOff)}h off
              </span>
              <span className="text-xs text-gray-400">{formatTimeLabel(workEndHHMM)}</span>
            </div>
          </div>

          {partialOrFull === 'partial' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                  Off from
                </label>
                <input
                  type="time"
                  step={900}
                  value={startTime}
                  onChange={(e) => onStartChange(e.target.value)}
                  className="w-full px-3 py-2.5 text-base bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500 tabular-nums [color-scheme:dark]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                  Off until
                </label>
                <input
                  type="time"
                  step={900}
                  value={endTime}
                  onChange={(e) => onEndChange(e.target.value)}
                  className="w-full px-3 py-2.5 text-base bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500 tabular-nums [color-scheme:dark]"
                />
              </div>
            </div>
          )}
          {partialOrFull === 'partial' && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 -mt-2">
              Type the time directly, or use ↑ ↓ arrow keys to step by 15 minutes.
            </p>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                {mode === 'log_past' ? 'Deduct hours from' : 'Use hours from'}
              </label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
                className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {mode === 'log_past' ? (
                  <>
                    <option value="sick">Sick</option>
                    <option value="vacation">Vacation</option>
                    <option value="bank">Bank</option>
                    <option value="any">Auto (best available)</option>
                  </>
                ) : (
                  <>
                    <option value="any">Auto (best available)</option>
                    <option value="vacation">Vacation</option>
                    <option value="sick">Sick</option>
                    <option value="bank">Bank</option>
                  </>
                )}
              </select>
            </div>
            <input
              type="text"
              placeholder={mode === 'log_past' ? "Note (optional, e.g. 'Flu')" : "Note (optional, e.g. 'Dentist appointment')"}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-2 pt-1">
            {existing && !existing.locked && (
              <button
                onClick={onRemove}
                className="px-4 py-2.5 text-sm font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-xl transition-colors"
                title="Remove this time off"
              >
                Remove
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={partialOrFull === 'partial' && hoursOff <= 0}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-gray-400 text-white rounded-xl transition-colors"
              title={
                mode === 'log_past'
                  ? 'Log this past absence'
                  : existing
                    ? 'Update this time off'
                    : 'Add to calendar'
              }
            >
              {mode === 'log_past' ? (
                <><History className="w-4 h-4" />Log absence</>
              ) : (
                <><CalendarCheck className="w-4 h-4" />{existing ? 'Update' : 'Add to calendar'}</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
