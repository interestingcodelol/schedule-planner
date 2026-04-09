import { useMemo, useState } from 'react'
import { Settings, HelpCircle, CalendarClock, ChevronDown } from 'lucide-react'
import { parseISO, isBefore, startOfDay, differenceInDays } from 'date-fns'
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
import { UpcomingMenu } from './UpcomingMenu'
import { BalanceForecast } from './BalanceForecast'
import { InlineToast } from './Toast'

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
    <div className="h-full flex flex-col lg:overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-6 py-3 shrink-0">
        <div className="glass-card rounded-xl flex items-stretch min-w-0">
          <div className="flex items-center gap-3 px-4 py-2 shrink-0">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight">
              <span className="gradient-text">Schedule Planner</span>
            </h1>
            {isDemo && (
              <button
                onClick={resetToSetup}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 font-bold transition-colors"
                title="You're viewing demo data — click to set up with your info"
              >
                Demo
              </button>
            )}
          </div>

          <div className="w-px bg-gray-200/60 dark:bg-gray-700/60 shrink-0" aria-hidden />

          <UpcomingMenu
            renderTrigger={({ toggle, total, hasUnaffordable, open }) => (
              <button
                onClick={toggle}
                aria-expanded={open}
                aria-label="View upcoming events"
                title={`View all ${total} upcoming item${total === 1 ? '' : 's'}`}
                className={`group flex items-center gap-3 pl-3 pr-3 py-2 rounded-r-xl hover:bg-blue-50/60 dark:hover:bg-blue-950/30 transition-colors min-w-0 ${
                  hasUnaffordable ? 'bg-red-50/40 dark:bg-red-950/15' : ''
                }`}
              >
                {nextTimeOff && daysUntilNext !== null && daysUntilNext >= 0 ? (
                  <>
                    <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-500/10 dark:bg-blue-400/10 shrink-0">
                      <CalendarClock className="w-3.5 h-3.5 text-blue-500" />
                    </div>
                    <div className="flex flex-col items-start min-w-0 leading-tight">
                      <span className="text-[10px] font-bold tracking-wider uppercase text-gray-400 dark:text-gray-500">
                        Next time off
                      </span>
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 truncate max-w-[180px] sm:max-w-[260px]">
                        {daysUntilNext === 0
                          ? 'Today!'
                          : daysUntilNext === 1
                            ? 'Tomorrow'
                            : `in ${daysUntilNext} days`}
                        {nextTimeOff.note && (
                          <span className="text-gray-400 dark:text-gray-500 font-normal">
                            {' · '}
                            {nextTimeOff.note}
                          </span>
                        )}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gray-500/10 shrink-0">
                      <CalendarClock className="w-3.5 h-3.5 text-gray-400" />
                    </div>
                    <div className="flex flex-col items-start leading-tight">
                      <span className="text-[10px] font-bold tracking-wider uppercase text-gray-400 dark:text-gray-500">
                        Next time off
                      </span>
                      <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">
                        Nothing planned
                      </span>
                    </div>
                  </>
                )}

                <span className="h-8 w-px bg-gray-200/60 dark:bg-gray-700/60 mx-1 shrink-0" aria-hidden />

                <div className="flex items-center gap-1.5 shrink-0 relative">
                  <span className="text-[10px] font-bold tracking-wider uppercase text-gray-400 dark:text-gray-500 hidden sm:inline">
                    All
                  </span>
                  <span className="text-sm font-bold tabular-nums text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded bg-blue-500/10 dark:bg-blue-400/10">
                    {total}
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
                  />
                  {hasUnaffordable && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900"
                      aria-hidden
                    />
                  )}
                </div>
              </button>
            )}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0" data-tour="settings">
          <InlineToast />
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

      <div className="flex-1 min-h-0 flex flex-col lg:overflow-hidden px-4 sm:px-6 pb-4 gap-3">
        <div className="shrink-0" data-tour="status-cards">
          <StatusCards />
        </div>

        <div className="shrink-0">
          <Insights />
        </div>

        <div className="flex-1 min-h-[480px] lg:min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 pb-24 lg:pb-0">
          <div className="lg:col-span-8 min-h-[520px] lg:min-h-0 flex flex-col" data-tour="calendar">
            <CalendarView />
          </div>
          <div className="lg:col-span-4 lg:min-h-0 flex flex-col gap-4 lg:overflow-y-auto scroll-panel pb-24 lg:pr-1">
            <div data-tour="planner" className="shrink-0">
              <VacationPlanner />
            </div>
            <div data-tour="bank-hours" className="shrink-0">
              <BankHoursWidget />
            </div>
            <div className="shrink-0">
              <BalanceForecast />
            </div>
          </div>
        </div>
      </div>

      <ChatAssistant />
      <GuidedTour />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
