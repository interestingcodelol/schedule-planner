import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { parseISO, startOfDay } from 'date-fns'
import { CalendarDays, Palmtree } from 'lucide-react'
import { useAppState } from '../context'
import { projectBalance, countWorkDays } from '../lib/projection'
import { useUpcomingItems } from '../lib/upcomingItems'
import { UpcomingVacationRow } from './UpcomingVacationRow'

type TriggerRenderArgs = {
  open: boolean
  toggle: () => void
  total: number
  hasUnaffordable: boolean
}

type Props = {
  renderTrigger?: (args: TriggerRenderArgs) => ReactNode
  align?: 'left' | 'right'
}

export function UpcomingMenu({ renderTrigger, align = 'left' }: Props = {}) {
  const { state } = useAppState()
  const { sortedVacations, infoEvents } = useUpcomingItems()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left?: number; right?: number }>({
    top: 0,
    left: 0,
  })
  const today = startOfDay(new Date())

  const hasUnaffordable = useMemo(() => {
    return sortedVacations.some((v) => {
      const start = parseISO(v.startDate)
      const end = parseISO(v.endDate)
      if (end < today) return false
      const workDays = countWorkDays(start, end, state.policy)
      const hrsPerDay = v.hoursPerDay ?? state.policy.hoursPerWorkDay
      const hoursNeeded = workDays * hrsPerDay
      const projection = projectBalance(state, start)
      return projection.totalAvailable < hoursNeeded
    })
  }, [sortedVacations, state, today])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      const inTrigger = triggerRef.current?.contains(t) ?? false
      const inPanel = panelRef.current?.contains(t) ?? false
      if (!inTrigger && !inPanel) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const update = () => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      if (align === 'right') {
        setCoords({
          top: rect.bottom + 8,
          right: Math.max(8, window.innerWidth - rect.right),
        })
      } else {
        setCoords({
          top: rect.bottom + 8,
          left: Math.max(8, rect.left),
        })
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, align])

  const total = sortedVacations.length + infoEvents.length
  const toggle = () => setOpen((o) => !o)

  return (
    <div className="relative" ref={triggerRef}>
      {renderTrigger ? (
        renderTrigger({ open, toggle, total, hasUnaffordable })
      ) : (
        <button
          onClick={toggle}
          className={`
            flex items-center gap-2 px-3 py-1.5 rounded-lg
            bg-blue-50 dark:bg-blue-950/30
            border border-blue-200/50 dark:border-blue-800/30
            text-xs hover:bg-blue-100 dark:hover:bg-blue-900/40
            transition-colors relative
            ${hasUnaffordable ? 'border-red-300/60 dark:border-red-700/40' : ''}
          `}
          title={
            hasUnaffordable
              ? 'One or more upcoming entries are not affordable yet — click to view'
              : `View all ${total} upcoming item${total === 1 ? '' : 's'}`
          }
          aria-label="View all upcoming events"
          aria-expanded={open}
        >
          <CalendarDays className="w-3.5 h-3.5 text-blue-500" />
          <span className="text-blue-700 dark:text-blue-300 font-medium hidden sm:inline">
            All upcoming
          </span>
          <span className="text-blue-600 dark:text-blue-400 font-semibold tabular-nums px-1 rounded bg-blue-500/10 dark:bg-blue-400/10">
            {total}
          </span>
          {hasUnaffordable && (
            <span
              className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900"
              aria-hidden
            />
          )}
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[60] rounded-xl shadow-2xl w-[22rem] max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-y-auto scroll-panel animate-slide-up bg-white dark:bg-gray-900 border border-gray-200/80 dark:border-gray-700/60 ring-1 ring-black/5 dark:ring-white/5"
            style={{
              top: `${coords.top}px`,
              ...(coords.left !== undefined ? { left: `${coords.left}px` } : {}),
              ...(coords.right !== undefined ? { right: `${coords.right}px` } : {}),
            }}
            role="menu"
          >
            <div className="px-5 py-3 border-b border-gray-200/80 dark:border-gray-700/60 sticky top-0 bg-white dark:bg-gray-900 z-10">
              <h3 className="text-base font-semibold">Upcoming</h3>
            </div>

            {total === 0 ? (
              <div className="px-5 py-8 text-center">
                <Palmtree className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                <p className="text-sm text-gray-400 dark:text-gray-500">No upcoming events</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
                {sortedVacations.map((vacation) => (
                  <UpcomingVacationRow key={vacation.id} vacation={vacation} />
                ))}
                {infoEvents.map((event) => (
                  <div key={event.key} className="px-5 py-3.5 flex items-start gap-3">
                    <event.icon className={`w-4 h-4 mt-0.5 shrink-0 ${event.accent}`} />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{event.label}</div>
                      <div className="text-sm text-gray-400 dark:text-gray-500">{event.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
