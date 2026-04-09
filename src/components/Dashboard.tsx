import { useMemo, useState } from 'react'
import { Settings, HelpCircle, CalendarClock } from 'lucide-react'
import { format, parseISO, isBefore, startOfDay, differenceInDays } from 'date-fns'
import { useAppState } from '../context'
import { StatusCards } from './StatusCards'
import { Insights } from './Insights'
import { CalendarView } from './CalendarView'
import { VacationPlanner } from './VacationPlanner'
import { SettingsModal } from './SettingsModal'
import { ThemeToggle } from './ThemeToggle'
import { GuidedTour } from './GuidedTour'
import { BankHoursWidget } from './BankHoursWidget'
import { ChatAssistant } from './ChatAssistant'
import { UpcomingEvents } from './UpcomingEvents'

export function Dashboard() {
  const { state, setShowTour, isDemo, resetToSetup } = useAppState()
  const [showSettings, setShowSettings] = useState(false)
  const today = startOfDay(new Date())

  const nextTimeOff = useMemo(() => {
    const upcoming = state.plannedVacations
      .filter((v) => !isBefore(parseISO(v.endDate), today))
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
    return upcoming[0] || null
  }, [state.plannedVacations, today])

  const daysUntilNext = nextTimeOff
    ? differenceInDays(parseISO(nextTimeOff.startDate), today)
    : null

  return (
    <div className="h-full flex flex-col overflow-hidden px-4 sm:px-6 py-4">
      {/* Header */}
      <header className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-bold tracking-tight">
              <span className="gradient-text">Schedule Planner</span>
            </h1>
            {state.profile.displayName && state.profile.displayName !== 'User' && !isDemo && (
              <span className="text-sm text-gray-400 dark:text-gray-500 font-medium">
                {state.profile.displayName}
              </span>
            )}
            {isDemo && (
              <button
                onClick={resetToSetup}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-400 transition-colors font-medium"
                title="You're viewing demo data — click to set up with your info"
              >
                Demo Mode
              </button>
            )}
          </div>
          {/* Upcoming time off badge */}
          {nextTimeOff && daysUntilNext !== null && daysUntilNext >= 0 && (
            <div
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200/50 dark:border-blue-800/30 text-xs"
              title={`Next time off: ${format(parseISO(nextTimeOff.startDate), 'MMM d')}${nextTimeOff.startDate !== nextTimeOff.endDate ? ` – ${format(parseISO(nextTimeOff.endDate), 'MMM d')}` : ''}${nextTimeOff.note ? ` (${nextTimeOff.note})` : ''}`}
            >
              <CalendarClock className="w-3.5 h-3.5 text-blue-500" />
              <span className="text-blue-700 dark:text-blue-300 font-medium">
                {daysUntilNext === 0
                  ? 'Time off today!'
                  : daysUntilNext === 1
                    ? 'Time off tomorrow'
                    : `${daysUntilNext}d until time off`}
              </span>
              {nextTimeOff.note && (
                <span className="text-blue-500 dark:text-blue-400 truncate max-w-[120px]">
                  — {nextTimeOff.note}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1" data-tour="settings">
          <button
            onClick={() => setShowTour(true)}
            className="p-2 rounded-xl text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label="Show guided tour"
            title="Show guided tour"
          >
            <HelpCircle className="w-[18px] h-[18px]" />
          </button>
          <ThemeToggle />
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-xl text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label="Open settings"
            title="Settings"
          >
            <Settings className="w-[18px] h-[18px]" />
          </button>
        </div>
      </header>

      {/* Status cards */}
      <div className="mb-3 shrink-0" data-tour="status-cards">
        <StatusCards />
      </div>

      {/* Insights */}
      <div className="mb-3 shrink-0">
        <Insights />
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 min-h-0 flex flex-col" data-tour="calendar">
          <CalendarView />
        </div>
        <div className="lg:col-span-4 min-h-0 flex flex-col gap-4">
          <div data-tour="planner" className="shrink-0">
            <VacationPlanner />
          </div>
          <div data-tour="bank-hours" className="shrink-0">
            <BankHoursWidget />
          </div>
          <div className="flex-1 min-h-0">
            <UpcomingEvents />
          </div>
        </div>
      </div>

      <ChatAssistant />
      <GuidedTour />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
