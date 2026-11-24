import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupWizard } from '../SetupWizard'
import { buildBackupJson } from '../../lib/storage'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState } from '../../lib/types'

const saved = (): AppState => ({
  version: 2,
  theme: 'dark',
  showTour: false,
  profile: {
    displayName: 'Backed up user',
    hireDate: '2022-04-01',
    currentVacationHours: 51.5,
    currentSickHours: 24,
    currentBankHours: 3,
    lastPaydayDate: '2026-11-20',
    lastSyncDate: '2026-11-24',
    timezone: 'America/Chicago',
  },
  policy: { ...defaultPolicy },
  plannedVacations: [
    { id: 'trip', startDate: '2027-01-11', endDate: '2027-01-15', hourSource: 'vacation', locked: false },
  ],
  bankHoursLog: [],
})

afterEach(cleanup)

describe('restoring a backup from the welcome screen', () => {
  it('restores a backup file without setting up or loading demo data first', async () => {
    const onRestore = vi.fn()
    const onComplete = vi.fn()
    render(<SetupWizard onComplete={onComplete} onRestore={onRestore} />)

    await userEvent.click(screen.getByRole('button', { name: /restore from a backup/i }))
    const file = new File([buildBackupJson(saved())], 'schedule-planner-backup-2026-11-24.json', {
      type: 'application/json',
    })
    await userEvent.upload(screen.getByLabelText('Backup file'), file)

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    const restored = onRestore.mock.calls[0][0] as AppState
    expect(restored.profile.displayName).toBe('Backed up user')
    expect(restored.profile.currentVacationHours).toBe(51.5)
    expect(restored.plannedVacations).toHaveLength(1)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('accepts pasted backup text', async () => {
    const onRestore = vi.fn()
    render(<SetupWizard onComplete={vi.fn()} onRestore={onRestore} />)
    await userEvent.click(screen.getByRole('button', { name: /restore from a backup/i }))
    fireEvent.change(screen.getByLabelText('Backup text'), { target: { value: buildBackupJson(saved()) } })
    await userEvent.click(screen.getByRole('button', { name: /restore pasted backup/i }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('explains what is wrong with a file that is not a backup', async () => {
    const onRestore = vi.fn()
    render(<SetupWizard onComplete={vi.fn()} onRestore={onRestore} />)
    await userEvent.click(screen.getByRole('button', { name: /restore from a backup/i }))
    await userEvent.upload(
      screen.getByLabelText('Backup file'),
      new File(['{"hello": "world"}'], 'notes.json', { type: 'application/json' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/doesn't look like a Schedule Planner backup/i)
    expect(onRestore).not.toHaveBeenCalled()
    // Back returns to the welcome choices.
    await userEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByRole('button', { name: /set up with my info/i })).toBeInTheDocument()
  })
})
