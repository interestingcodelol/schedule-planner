import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { parseISO } from 'date-fns'
import { AppContext, type AppContextType } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState } from '../../lib/types'
import { CalendarDay } from '../CalendarDay'
import { CalendarView } from '../CalendarView'
import { DayPopover } from '../DayPopover'
import { VacationPlanner } from '../VacationPlanner'
import { useUpcomingItems } from '../../lib/upcomingItems'

function fixture(): AppState {
  return {
    profile: { displayName: 'Test', hireDate: '2023-01-01', currentVacationHours: 40,
      currentSickHours: 20, currentBankHours: 4.75, lastPaydayDate: '2026-09-25',
      lastSyncDate: '2026-09-29', timezone: 'America/Los_Angeles' },
    policy: { ...defaultPolicy }, plannedVacations: [], bankHoursLog: [],
    theme: 'dark', showTour: false, version: 1,
  }
}
function mount(ui: React.ReactNode, state: AppState) {
  const noop = vi.fn()
  const value: AppContextType = {
    state, setState: noop, importState: noop, updateProfile: noop, updatePolicy: noop,
    addVacation: noop, removeVacation: noop, updateVacation: noop, addPastAbsence: noop,
    removePastAbsence: noop, adjustActualHours: noop, addBankHours: noop, removeBankHours: noop,
    toggleTheme: noop, setShowTour: noop, isDemo: true, resetToSetup: noop,
  }
  return render(<AppContext.Provider value={value}>{ui}</AppContext.Provider>)
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T02:00:00Z')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('consistent calendar-local balance UX', () => {
  it('keeps profile-local today visible and plannable after 4pm and across host midnight', () => {
    const onDayClick = vi.fn()
    mount(<CalendarDay date={parseISO('2026-09-29')} currentMonth={parseISO('2026-09-01')} onDayClick={onDayClick} />, fixture())
    const cell = screen.getByRole('button', { name: 'September 29, 2026, today' })
    expect(cell.getAttribute('title')).not.toContain('past absence')
    expect(cell.getAttribute('title')).toContain('Balance: 64.75 hrs')
    fireEvent.click(cell)
    expect(onDayClick).toHaveBeenCalledOnce()
  })
  it('flags a selected-pool shortage even when other pools have hours', () => {
    const state = fixture()
    state.profile.currentVacationHours = 2
    state.plannedVacations = [{ id: 'today', startDate: '2026-09-29', endDate: '2026-09-29', hourSource: 'vacation', locked: false }]
    mount(<CalendarDay date={parseISO('2026-09-29')} currentMonth={parseISO('2026-09-01')} onDayClick={vi.fn()} />, state)
    expect(screen.getByRole('button', { name: /insufficient hours/ }).getAttribute('title')).toContain('6 hrs of planned time off cannot be covered')
  })
  it('counts recorded multi-day actuals once in the monthly heading', () => {
    const state = fixture()
    state.plannedVacations = [{ id: 'past', startDate: '2026-09-21', endDate: '2026-09-22', hourSource: 'vacation', locked: false, kind: 'logged_past', actualHoursUsed: 10 }]
    mount(<CalendarView />, state)
    expect(screen.getByRole('button', { name: /September 2026 10h off across 2 partial days/ })).toBeInTheDocument()
  })
  it('previews the original bank allocation when editing today instead of deducting twice', () => {
    const state = fixture()
    const existing = { id: 'today', startDate: '2026-09-29', endDate: '2026-09-29', hourSource: 'any' as const, locked: false }
    state.plannedVacations = [existing]
    mount(<DayPopover date={parseISO('2026-09-29')} existing={existing} hoursPerWorkDay={8} onSave={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />, state)
    expect(screen.getByText('4.75h')).toBeInTheDocument()
    expect(screen.getByText('3.25h')).toBeInTheDocument()
  })
  it('labels planner fields and uses profile-local today for their date limits', () => {
    mount(<VacationPlanner />, fixture())
    expect(screen.getByLabelText('Start')).toHaveAttribute('min', '2026-09-29')
    expect(screen.getByLabelText('End')).toHaveAttribute('min', '2026-09-29')
    expect(screen.getByLabelText('Use hours from')).toBeInTheDocument()
    expect(screen.getByLabelText('Hrs/day')).toBeInTheDocument()
  })
  it('upcoming holidays use observed dates, last-weekday rules and start years', () => {
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'))
    const state = fixture()
    state.policy.holidays = [
      { name: 'Memorial Day', type: 'last_weekday', month: 5, weekday: 1, weekendObservance: 'none' },
      { name: 'Independence Day', type: 'fixed', month: 7, day: 4, weekendObservance: 'nearest_weekday' },
      { name: 'Not yet', type: 'fixed', month: 5, day: 6, weekendObservance: 'none', startYear: 2027 },
    ]
    function Holidays() { const { infoEvents } = useUpcomingItems(); return <>{infoEvents.map(e => <p key={e.key}>{e.label}: {e.detail}</p>)}</> }
    mount(<Holidays />, state)
    expect(screen.getByText(/Memorial Day: Mon, May 25/)).toBeInTheDocument()
    expect(screen.getByText(/Independence Day: Fri, Jul 3/)).toBeInTheDocument()
    expect(screen.queryByText(/Not yet/)).not.toBeInTheDocument()
  })
  it('rejects sub-quarter-hour input instead of accidentally saving a full day', () => {
    mount(<VacationPlanner />, fixture())
    fireEvent.change(screen.getByLabelText('Start'), {target:{value:'2026-09-30'}})
    fireEvent.change(screen.getByLabelText('End'), {target:{value:'2026-09-30'}})
    fireEvent.change(screen.getByLabelText('Hrs/day'), {target:{value:'0.1'}})
    expect(screen.getByText('Hours per day must be between 0.25 and 8')).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:'Add to calendar'})).not.toBeInTheDocument()
  })
  it('previews payday accrual before PTO and bank payout after PTO', () => {
    const state=fixture()
    state.profile.currentVacationHours=0;state.profile.currentBankHours=2;state.profile.currentSickHours=0
    state.profile.lastPaydayDate='2026-09-29';state.policy.payPeriodLengthDays=1
    state.policy.bankHoursPayoutStart={month:9,day:30}
    mount(<DayPopover date={parseISO('2026-09-30')} hoursPerWorkDay={8} onSave={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />,state)
    expect(screen.getByText('2h')).toBeInTheDocument()
    expect(screen.getByText('3.08h')).toBeInTheDocument()
    expect(screen.getByText(/2.92h short/)).toBeInTheDocument()
  })

})
