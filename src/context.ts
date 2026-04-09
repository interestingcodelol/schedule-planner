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
  addBankHours: (entry: BankHoursEntry) => void
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
