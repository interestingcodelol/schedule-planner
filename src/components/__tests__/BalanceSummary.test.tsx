import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useAppState } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState, PlannedVacation } from '../../lib/types'
import { BalanceSummary } from '../BalanceSummary'
import { StatusCards } from '../StatusCards'

vi.mock('../../context', () => ({ useAppState: vi.fn() }))

function makeState(): AppState {
  return {
    profile: {
      displayName: 'Fixture User',
      hireDate: '2020-01-01',
      currentVacationHours: 40,
      currentSickHours: 16,
      currentBankHours: 8,
      lastPaydayDate: '2025-06-13',
      lastSyncDate: '2025-06-17',
      timezone: 'Etc/UTC',
    },
    policy: { ...defaultPolicy, holidays: [] },
    plannedVacations: [],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 1,
  }
}

function timeOff(
  id: string,
  hourSource: PlannedVacation['hourSource'],
  hoursPerDay: number,
  date = '2025-06-17',
): PlannedVacation {
  return { id, startDate: date, endDate: date, hourSource, hoursPerDay, locked: false }
}

function setContext(state: AppState) {
  vi.mocked(useAppState).mockReturnValue({
    state,
    setState: vi.fn(),
    importState: vi.fn(),
    updateProfile: vi.fn(),
    updatePolicy: vi.fn(),
    addVacation: vi.fn(),
    removeVacation: vi.fn(),
    updateVacation: vi.fn(),
    addPastAbsence: vi.fn(),
    removePastAbsence: vi.fn(),
    adjustActualHours: vi.fn(),
    addBankHours: vi.fn(),
    removeBankHours: vi.fn(),
    toggleTheme: vi.fn(),
    setShowTour: vi.fn(),
    isDemo: false,
    resetToSetup: vi.fn(),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2025-06-17T09:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BalanceSummary', () => {
  it('shows immediate morning deductions by pool and an auditable balance equation', () => {
    const state = makeState()
    state.plannedVacations = [timeOff('vacation', 'vacation', 8), timeOff('sick', 'sick', 4)]
    setContext(state)
    render(<BalanceSummary />)

    expect(screen.getByLabelText('Available now: 52 hours')).toBeInTheDocument()
    expect(screen.getByLabelText('Vacation available: 32 hours')).toBeInTheDocument()
    expect(screen.getByLabelText('Sick leave available: 12 hours')).toBeInTheDocument()
    expect(screen.getByText('12 hrs used today, already included')).toBeInTheDocument()
    expect(screen.getByText('8 hrs vacation · 4 hrs sick')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Balance details'))
    const table = screen.getByRole('table')
    expect(within(table).getByRole('row', { name: 'Vacation 40 −8 32' })).toBeInTheDocument()
    expect(within(table).getByRole('row', { name: 'Sick 16 −4 12' })).toBeInTheDocument()
    expect(within(table).getByRole('row', { name: 'Total 64 −12 52' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Balance details'))
    expect(screen.getByText('Balance details').closest('details')).not.toHaveAttribute('open')
  })

  it('keeps future plans separate from available now', () => {
    const state = makeState()
    state.plannedVacations = [timeOff('future-trip', 'vacation', 8, '2025-06-18')]
    setContext(state)
    render(<StatusCards />)

    expect(screen.getByLabelText('Available now: 64 hours')).toBeInTheDocument()
    expect(screen.getByText('No time off charged today')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Looking ahead' })).toBeInTheDocument()
    expect(screen.getByText('Forecasts include future plans and accruals')).toBeInTheDocument()
    expect(screen.getByText('Projected Dec 31')).toBeInTheDocument()
  })

  it('explains logged consumption without deducting it again', () => {
    const state = makeState()
    state.profile.currentSickHours = 12
    state.plannedVacations = [
      {
        ...timeOff('logged', 'sick', 4),
        kind: 'logged_past',
        actualHoursUsed: 4,
        debitedFrom: { vacation: 0, sick: 4, bank: 0 },
      },
    ]
    setContext(state)
    render(<BalanceSummary />)

    expect(screen.getByLabelText('Available now: 60 hours')).toBeInTheDocument()
    expect(screen.getByText('4 hrs used today, already included')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Balance details'))
    expect(screen.getByRole('row', { name: 'Sick 12 0 12' })).toBeInTheDocument()
    expect(screen.getByText(/Each absence is counted once/)).toBeInTheDocument()
  })

  it('keeps today visible after a scheduled deduction has been recorded during an ongoing trip', () => {
    const state = makeState()
    state.profile.currentSickHours = 12
    state.plannedVacations = [
      {
        ...timeOff('ongoing', 'sick', 4),
        endDate: '2025-06-18',
        kind: 'planned',
        appliedDeductions: [
          { date: '2025-06-17', hours: 4, drawn: { vacation: 0, sick: 4, bank: 0 } },
        ],
      },
    ]
    setContext(state)
    render(<BalanceSummary />)

    expect(screen.getByLabelText('Available now: 60 hours')).toBeInTheDocument()
    expect(screen.getByText('4 hrs used today, already included')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Balance details'))
    expect(screen.getByRole('row', { name: 'Sick 12 0 12' })).toBeInTheDocument()
    expect(screen.getByText(/Recorded includes time off already processed/)).toBeInTheDocument()
  })

  it('labels older logged Auto entries without inventing a pool or charging twice', () => {
    const state = makeState()
    state.profile.currentVacationHours = 36
    state.plannedVacations = [
      {
        ...timeOff('legacy', 'any', 4),
        kind: 'logged_past',
        actualHoursUsed: 4,
      },
    ]
    setContext(state)
    render(<BalanceSummary />)

    expect(screen.getByLabelText('Available now: 60 hours')).toBeInTheDocument()
    expect(screen.getByText('4 hrs used today, already included')).toBeInTheDocument()
    expect(screen.getByText('4 hrs unspecified pool')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Balance details'))
    expect(screen.getByRole('row', { name: 'Total 60 0 60' })).toBeInTheDocument()
    expect(screen.getByText(/An older logged entry has no pool breakdown/)).toBeInTheDocument()
  })

  it('shows bank usage immediately while keeping bank management available', () => {
    const state = makeState()
    state.plannedVacations = [timeOff('bank', 'bank', 4)]
    setContext(state)
    render(<BalanceSummary />)

    const bank = screen.getByRole('button', { name: /Bank hours: 4 hours/ })
    expect(bank).toBeInTheDocument()
    expect(screen.getByText('4 hrs bank')).toBeInTheDocument()
    fireEvent.click(bank)
    expect(screen.getByPlaceholderText('Hours')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Hours')).not.toBeInTheDocument()
  })

  it('warns about unfunded hours instead of treating all scheduled hours as paid', () => {
    const state = makeState()
    state.profile.currentVacationHours = 2
    state.profile.currentSickHours = 1
    state.profile.currentBankHours = 1
    state.plannedVacations = [timeOff('shortfall', 'any', 8)]
    setContext(state)
    render(<BalanceSummary />)

    expect(screen.getByLabelText('Available now: 0 hours')).toBeInTheDocument()
    expect(screen.getByText('4 hrs used today, already included')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      '4 hrs of time off through today could not be covered',
    )
  })

  it('respects hidden bank UI and the profile-local date', () => {
    vi.setSystemTime(new Date('2025-06-18T02:00:00Z'))
    const state = makeState()
    state.profile.timezone = 'America/Los_Angeles'
    state.profile.currentBankHours = 0
    state.policy.hideBankHours = true
    state.plannedVacations = [timeOff('today', 'sick', 4)]
    setContext(state)
    render(<BalanceSummary />)

    expect(screen.getByText('Today, Jun 17')).toBeInTheDocument()
    expect(screen.getByLabelText('Available now: 52 hours')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Bank hours/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Balance details'))
    expect(screen.queryByRole('row', { name: /^Bank / })).not.toBeInTheDocument()
  })
})
