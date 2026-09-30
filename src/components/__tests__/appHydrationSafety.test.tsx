import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { useAppState } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState } from '../../lib/types'

const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/storage', () => ({
  CURRENT_VERSION: 2,
  loadStateAsync: storage.load,
  saveState: storage.save,
  clearState: vi.fn(),
  subscribeToCrossTabUpdates: storage.subscribe,
}))
vi.mock('../Dashboard', () => ({
  Dashboard: () => (
    <div>
      Restored dashboard<span>{useAppState().state.profile.displayName}</span>
    </div>
  ),
}))
vi.mock('../UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../SetupWizard', () => ({ SetupWizard: () => <div>New planner setup</div> }))
const fixture = (): AppState => ({
  version: 2,
  theme: 'dark',
  showTour: false,
  profile: {
    displayName: 'Saved fixture',
    hireDate: '2023-01-01',
    currentVacationHours: 40,
    currentSickHours: 20,
    currentBankHours: 0,
    lastPaydayDate: '2026-09-25',
    lastSyncDate: '2026-09-30',
    timezone: 'UTC',
  },
  policy: { ...defaultPolicy },
  plannedVacations: [],
  bankHoursLog: [],
})
beforeEach(() => {
  storage.load.mockReset()
  storage.save.mockReset()
  storage.subscribe.mockReset().mockReturnValue(() => {})
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T15:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe('safe startup', () => {
  it('never exposes setup or saves while persistent reads are pending', async () => {
    let complete!: (state: AppState) => void
    storage.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    render(<App />)
    expect(screen.getByText('Loading your saved planner')).toBeInTheDocument()
    expect(screen.queryByText('New planner setup')).not.toBeInTheDocument()
    expect(storage.save).not.toHaveBeenCalled()
    await act(async () => complete(fixture()))
    expect(screen.getByText('Restored dashboard')).toBeInTheDocument()
  })
  it('holds failed reads without saving and retries recovery before setup', async () => {
    storage.load
      .mockRejectedValueOnce(new Error('Storage unavailable'))
      .mockResolvedValueOnce(fixture())
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByText('Your saved planner needs attention')).toBeInTheDocument()
    expect(screen.queryByText('New planner setup')).not.toBeInTheDocument()
    expect(storage.save).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
    expect(screen.getByText('Restored dashboard')).toBeInTheDocument()
  })
  it('offers setup only after successful empty reads', async () => {
    storage.load.mockResolvedValue(null)
    await act(async () => {
      render(<App />)
    })
    expect(screen.getByText('New planner setup')).toBeInTheDocument()
    expect(storage.save).not.toHaveBeenCalled()
  })
  it('keeps a newer cross-tab save received while hydration is pending', async () => {
    let complete!: (state: AppState) => void
    storage.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    render(<App />)
    const incoming = {
      ...fixture(),
      savedAt: 200,
      profile: { ...fixture().profile, displayName: 'Newer tab data' },
    }
    act(() => storage.subscribe.mock.calls[0][0](incoming))
    await act(async () => complete({ ...fixture(), savedAt: 100 }))
    expect(screen.getByText('Newer tab data')).toBeInTheDocument()
    expect(storage.save).not.toHaveBeenCalled()
  })
})
