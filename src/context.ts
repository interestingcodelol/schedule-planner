import { createContext, useContext } from 'react'
import type { AppState, BankHoursEntry, PlannedVacation } from './lib/types'

export type AppContextType = {
  state: AppState
  setState: (state: AppState) => void
  updateProfile: (updates: Partial<AppState['profile']>) => void
  updatePolicy: (updates: Partial<AppState['policy']>) => void
  addVacation: (vacation: PlannedVacation) => void
  removeVacation: (id: string) => void
  updateVacation: (id: string, updates: Partial<PlannedVacation>) => void
  /** Log a retroactive past absence and immediately debit the matching pool. */
  addPastAbsence: (vacation: PlannedVacation) => void
  /** Remove a past absence; refunds the matching pool for logged-past entries. */
  removePastAbsence: (id: string) => void
  /** Update the actual hours used on a past entry, applying the delta to the
   *  matching pool when the entry is a logged-past absence. */
  adjustActualHours: (id: string, actualHoursUsed: number) => void
  addBankHours: (entry: BankHoursEntry) => void
  removeBankHours: (id: string) => void
  toggleTheme: () => void
  setShowTour: (show: boolean) => void
  isDemo: boolean
  resetToSetup: () => void
}

export const AppContext = createContext<AppContextType | null>(null)

export function useAppState() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppState must be used within AppProvider')
  return ctx
}
