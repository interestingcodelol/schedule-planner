import { useCallback, useEffect, useState } from 'react'
import type { AppState, BankHoursEntry, PlannedVacation } from './lib/types'
import { loadState, loadStateAsync, saveState, clearState } from './lib/storage'
import { SetupWizard } from './components/SetupWizard'
import { Dashboard } from './components/Dashboard'
import { UpdateBanner } from './components/UpdateBanner'
import { AppContext } from './context'

function migrateState(loaded: AppState): AppState {
  return {
    ...loaded,
    profile: {
      ...loaded.profile,
      currentBankHours: loaded.profile.currentBankHours ?? 0,
    },
    bankHoursLog: loaded.bankHoursLog ?? [],
    showTour: loaded.showTour ?? false,
    policy: {
      ...loaded.policy,
      bankHoursPayoutStart: loaded.policy.bankHoursPayoutStart ?? { month: 12, day: 15 },
      bankHoursPayoutEnd: loaded.policy.bankHoursPayoutEnd ?? { month: 2, day: 15 },
    },
    plannedVacations: loaded.plannedVacations.map((v) => ({
      ...v,
      hourSource: v.hourSource ?? ('any' as const),
    })),
  }
}

function getInitialState(): { state: AppState | null; isDemo: boolean } {
  const loaded = loadState()
  if (loaded) {
    return { state: migrateState(loaded), isDemo: loaded.profile.displayName === 'Demo User' }
  }
  return { state: null, isDemo: false }
}

export default function App() {
  const [{ state, isDemo }, setAppData] = useState(getInitialState)

  // Try loading from IndexedDB on mount (may have data even if localStorage was cleared)
  useEffect(() => {
    loadStateAsync().then((idbState) => {
      if (idbState) {
        setAppData((prev) => {
          // Only use IDB state if we don't already have state loaded
          if (prev.state) return prev
          return { state: migrateState(idbState), isDemo: idbState.profile.displayName === 'Demo User' }
        })
      }
    })
  }, [])

  useEffect(() => {
    if (state) {
      saveState(state)
    }
  }, [state])

  useEffect(() => {
    if (state) {
      if (state.theme === 'dark') {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
    }
  }, [state])

  const setState = useCallback((newState: AppState) => {
    setAppData((prev) => ({ ...prev, state: newState }))
  }, [])

  const updateProfile = useCallback(
    (updates: Partial<AppState['profile']>) => {
      setAppData((prev) => {
        if (!prev.state) return prev
        return { ...prev, state: { ...prev.state, profile: { ...prev.state.profile, ...updates } } }
      })
    },
    [],
  )

  const updatePolicy = useCallback(
    (updates: Partial<AppState['policy']>) => {
      setAppData((prev) => {
        if (!prev.state) return prev
        return { ...prev, state: { ...prev.state, policy: { ...prev.state.policy, ...updates } } }
      })
    },
    [],
  )

  const addVacation = useCallback((vacation: PlannedVacation) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      const newVacations = [...prev.state.plannedVacations]
      const overlapping = newVacations.filter(
        (v) => v.startDate <= vacation.endDate && v.endDate >= vacation.startDate,
      )

      if (overlapping.length > 0) {
        const allDates = [
          vacation.startDate,
          vacation.endDate,
          ...overlapping.flatMap((v) => [v.startDate, v.endDate]),
        ]
        const mergedStart = allDates.sort()[0]
        const mergedEnd = allDates.sort()[allDates.length - 1]
        const filtered = newVacations.filter((v) => !overlapping.includes(v))
        filtered.push({ ...vacation, startDate: mergedStart, endDate: mergedEnd })
        return { ...prev, state: { ...prev.state, plannedVacations: filtered } }
      }

      return { ...prev, state: { ...prev.state, plannedVacations: [...newVacations, vacation] } }
    })
  }, [])

  const removeVacation = useCallback((id: string) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      return {
        ...prev,
        state: {
          ...prev.state,
          plannedVacations: prev.state.plannedVacations.filter((v) => v.id !== id),
        },
      }
    })
  }, [])

  const updateVacation = useCallback(
    (id: string, updates: Partial<PlannedVacation>) => {
      setAppData((prev) => {
        if (!prev.state) return prev
        return {
          ...prev,
          state: {
            ...prev.state,
            plannedVacations: prev.state.plannedVacations.map((v) =>
              v.id === id ? { ...v, ...updates } : v,
            ),
          },
        }
      })
    },
    [],
  )

  const addBankHours = useCallback((entry: BankHoursEntry) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentBankHours: prev.state.profile.currentBankHours + entry.hours,
          },
          bankHoursLog: [...prev.state.bankHoursLog, entry],
        },
      }
    })
  }, [])

  const removeBankHours = useCallback((id: string) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      const entry = prev.state.bankHoursLog.find((e) => e.id === id)
      if (!entry) return prev
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentBankHours: prev.state.profile.currentBankHours - entry.hours,
          },
          bankHoursLog: prev.state.bankHoursLog.filter((e) => e.id !== id),
        },
      }
    })
  }, [])

  const toggleTheme = useCallback(() => {
    setAppData((prev) => {
      if (!prev.state) return prev
      return { ...prev, state: { ...prev.state, theme: prev.state.theme === 'dark' ? 'light' : 'dark' } }
    })
  }, [])

  const setShowTour = useCallback((show: boolean) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      return { ...prev, state: { ...prev.state, showTour: show } }
    })
  }, [])

  const resetToSetup = useCallback(() => {
    clearState()
    setAppData({ state: null, isDemo: false })
  }, [])

  const handleSetupComplete = useCallback(
    (newState: AppState, demo: boolean) => {
      setAppData({ state: newState, isDemo: demo })
      saveState(newState)
    },
    [],
  )

  if (!state) {
    return <SetupWizard onComplete={handleSetupComplete} />
  }

  return (
    <AppContext.Provider
      value={{
        state,
        setState,
        updateProfile,
        updatePolicy,
        addVacation,
        removeVacation,
        updateVacation,
        addBankHours,
        removeBankHours,
        toggleTheme,
        setShowTour,
        isDemo,
        resetToSetup,
      }}
    >
      <div className="h-screen flex flex-col overflow-hidden">
        <UpdateBanner />
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      </div>
    </AppContext.Provider>
  )
}
