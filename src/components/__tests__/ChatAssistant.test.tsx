import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppState } from '../../context'
import { processChat } from '../../lib/chatParser'
import { defaultPolicy } from '../../lib/defaultPolicy'
import { ChatAssistant } from '../ChatAssistant'

vi.mock('../../context', () => ({ useAppState: vi.fn() }))
vi.mock('../../lib/chatParser', () => ({ processChat: vi.fn() }))

const addVacation = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(useAppState).mockReturnValue({
    state: {
      profile: {
        displayName: 'Fixture',
        hireDate: '2020-01-01',
        currentVacationHours: 40,
        currentSickHours: 16,
        currentBankHours: 0,
        lastPaydayDate: '2026-04-17',
        timezone: 'Etc/UTC',
      },
      policy: defaultPolicy,
      plannedVacations: [],
      bankHoursLog: [],
      theme: 'dark',
      showTour: false,
      version: 1,
    },
    addVacation,
    setState: vi.fn(),
    importState: vi.fn(),
    updateProfile: vi.fn(),
    updatePolicy: vi.fn(),
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
  vi.mocked(processChat).mockReturnValue({
    text: 'Ready to add this time off.',
    action: { type: 'plan_vacation', startDate: '2026-04-23', endDate: '2026-04-24' },
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function send(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
}

function finishResponse() {
  act(() => vi.advanceTimersByTime(500))
}

describe('ChatAssistant interrupted and repeated flows', () => {
  it('clearing a conversation cancels the pending reply and allows a new request', () => {
    render(<ChatAssistant onClose={vi.fn()} />)
    send('plan tomorrow')
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
    finishResponse()
    expect(processChat).not.toHaveBeenCalled()
    expect(screen.getByText('Fresh start! What would you like to plan?')).toBeInTheDocument()
    expect(screen.queryByText('Ready to add this time off.')).not.toBeInTheDocument()
    send("What's my balance?")
    finishResponse()
    expect(processChat).toHaveBeenCalledTimes(1)
  })

  it('closing/unmounting cancels delayed work', () => {
    const { unmount } = render(<ChatAssistant onClose={vi.fn()} />)
    send('plan tomorrow')
    unmount()
    finishResponse()
    expect(processChat).not.toHaveBeenCalled()
  })

  it('adds an offered plan only once even on repeated clicks before a rerender', () => {
    render(<ChatAssistant onClose={vi.fn()} />)
    send('plan tomorrow')
    finishResponse()
    const add = screen.getByRole('button', { name: 'Add to calendar' })
    act(() => {
      fireEvent.click(add)
      fireEvent.click(add)
    })
    expect(addVacation).toHaveBeenCalledTimes(1)
    expect(screen.getByText('✓ Added to calendar')).toBeInTheDocument()
  })

  it('keeps new balance and today questions independent of the previous date range', () => {
    render(<ChatAssistant onClose={vi.fn()} />)
    send('plan tomorrow')
    finishResponse()
    send('How many hours do I have?')
    finishResponse()
    expect(vi.mocked(processChat).mock.calls[1][0]).toBe('How many hours do I have?')
    send('How about today?')
    finishResponse()
    expect(vi.mocked(processChat).mock.calls[2][0]).toBe('How about today?')
  })
})
