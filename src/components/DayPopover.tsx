import { useState, useEffect, useRef } from 'react'
import { format, isBefore, startOfDay } from 'date-fns'
import { X, Clock, CalendarOff, CalendarCheck, Pencil } from 'lucide-react'
import type { PlannedVacation } from '../lib/types'

type Props = {
  date: Date
  existing?: PlannedVacation
  hoursPerWorkDay: number
  onSave: (config: {
    hoursPerDay?: number
    timeOffStart?: string
    timeOffEnd?: string
    hourSource: 'vacation' | 'sick' | 'bank' | 'any'
    note?: string
  }) => void
  onRemove: () => void
  onClose: () => void
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

function hourToTime(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

function timeToHour(t: string): number {
  return parseInt(t.split(':')[0])
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

  const [mode, setMode] = useState<'full' | 'partial'>(
    existing?.hoursPerDay !== undefined && existing.hoursPerDay < hoursPerWorkDay
      ? 'partial'
      : 'full',
  )
  const [startHour, setStartHour] = useState(
    existing?.timeOffStart ? timeToHour(existing.timeOffStart) : workStart,
  )
  const [endHour, setEndHour] = useState(
    existing?.timeOffEnd ? timeToHour(existing.timeOffEnd) : workEnd,
  )
  const [source, setSource] = useState<'vacation' | 'sick' | 'bank' | 'any'>(
    existing?.hourSource ?? 'any',
  )
  const [note, setNote] = useState(existing?.note ?? '')
  const modalRef = useRef<HTMLDivElement>(null)

  const hoursOff = mode === 'full' ? hoursPerWorkDay : Math.max(0, endHour - startHour)

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
    onSave({
      hoursPerDay: mode === 'partial' ? hoursOff : undefined,
      timeOffStart: mode === 'partial' ? hourToTime(startHour) : undefined,
      timeOffEnd: mode === 'partial' ? hourToTime(endHour) : undefined,
      hourSource: source,
      note: note || undefined,
    })
  }

  const workHours = Array.from({ length: workEnd - workStart }, (_, i) => workStart + i)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="glass-card rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        role="dialog"
        aria-label={`Plan time off for ${format(date, 'MMMM d')}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200/60 dark:border-gray-700/40">
          <div>
            <div className="text-base font-bold">{format(date, 'EEEE, MMM d')}</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {hoursOff}h off &middot; {hoursPerWorkDay - hoursOff}h working
              {isPastDay && existing && (
                <span className="ml-1.5 text-amber-500 font-medium">· Editing</span>
              )}
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

        <div className="p-5 space-y-5">
          {/* Full / Partial toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => {
                setMode('full')
                setStartHour(workStart)
                setEndHour(workEnd)
              }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl border-2 transition-all ${
                mode === 'full'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700/60 hover:border-blue-400'
              }`}
              title="Take the full day off"
            >
              <CalendarOff className="w-4 h-4" />
              Full Day
            </button>
            <button
              onClick={() => {
                setMode('partial')
                if (startHour === workStart && endHour === workEnd) {
                  setEndHour(workStart + Math.floor(hoursPerWorkDay / 2))
                }
              }}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl border-2 transition-all ${
                mode === 'partial'
                  ? 'bg-sky-600 text-white border-sky-600'
                  : 'bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700/60 hover:border-sky-400'
              }`}
              title="Take part of the day off"
            >
              <Clock className="w-4 h-4" />
              Partial Day
            </button>
          </div>

          {/* Time bar visualization */}
          <div>
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">
              Your day ({formatHour(workStart)} – {formatHour(workEnd)})
            </div>
            <div className="flex gap-[2px] rounded-lg overflow-hidden">
              {workHours.map((h) => {
                const isOff = mode === 'full' || (h >= startHour && h < endHour)
                return (
                  <div
                    key={h}
                    className={`flex-1 h-10 flex items-end justify-center rounded-sm transition-colors ${
                      isOff
                        ? mode === 'full' ? 'bg-blue-500' : 'bg-sky-500'
                        : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                    title={`${formatHour(h)} — ${isOff ? 'OFF' : 'Working'}`}
                  >
                    <span className={`text-[9px] font-bold pb-1 ${isOff ? 'text-white/80' : 'text-gray-400 dark:text-gray-500'}`}>
                      {h % 2 === 0 ? `${h > 12 ? h - 12 : h}${h >= 12 ? 'p' : 'a'}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="flex justify-between items-center mt-1.5">
              <span className="text-xs text-gray-400">{formatHour(workStart)}</span>
              <span className={`text-xs font-bold ${mode === 'full' ? 'text-blue-500' : hoursOff > 0 ? 'text-sky-500' : 'text-gray-400'}`}>
                {hoursOff}h off
              </span>
              <span className="text-xs text-gray-400">{formatHour(workEnd)}</span>
            </div>
          </div>

          {/* Time pickers (partial mode) */}
          {mode === 'partial' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                  Off from
                </label>
                <select
                  value={startHour}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setStartHour(v)
                    if (v >= endHour) setEndHour(v + 1)
                  }}
                  className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  {workHours.slice(0, -1).map((h) => (
                    <option key={h} value={h}>{formatHour(h)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                  Off until
                </label>
                <select
                  value={endHour}
                  onChange={(e) => setEndHour(Number(e.target.value))}
                  className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  {workHours.filter((h) => h > startHour).map((h) => (
                    <option key={h} value={h}>{formatHour(h)}</option>
                  ))}
                  <option value={workEnd}>{formatHour(workEnd)}</option>
                </select>
              </div>
            </div>
          )}

          {/* Source + Note */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">
                Use hours from
              </label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
                className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="any">Auto (best available)</option>
                <option value="vacation">Vacation</option>
                <option value="sick">Sick</option>
                <option value="bank">Bank</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="Note (optional, e.g. 'Dentist appointment')"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {existing && (
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
              disabled={mode === 'partial' && hoursOff <= 0}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-gray-400 text-white rounded-xl transition-colors"
              title={existing ? (isPastDay ? 'Save adjusted hours' : 'Update this time off') : 'Add to plan'}
            >
              {isPastDay && existing ? (
                <><Pencil className="w-4 h-4" />Save adjustment</>
              ) : (
                <><CalendarCheck className="w-4 h-4" />{existing ? 'Update' : 'Add to plan'}</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
