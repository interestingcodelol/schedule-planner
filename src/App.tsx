import { useCallback, useEffect, useState } from 'react'
import type { AppState, BankHoursEntry, PlannedVacation } from './lib/types'
import { loadState, loadStateAsync, saveState, clearState } from './lib/storage'
import { SetupWizard } from './components/SetupWizard'
import { Dashboard } from './components/Dashboard'
import { UpdateBanner } from './components/UpdateBanner'
import { AppContext } from './context'
import { catchUpState, summarizeCatchUp } from './lib/catchUp'
import { showToast } from './lib/toastBus'
import { getNowInZone } from './lib/timeUtils'

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
  } catch {
    return 'America/New_York'
  }
}

function migrateState(loaded: AppState): AppState {
  const tz = loaded.profile.timezone ?? detectTimezone()
  // Existing users without a lastSyncDate get one anchored to lastPaydayDate
  // so the first catch-up after this feature ships fast-forwards every
  // payday/grant/payout/finished-vacation that happened while the app was
  // closed. New users land here with the value already set by setup.
  const lastSyncDate =
    loaded.profile.lastSyncDate ?? loaded.profile.lastPaydayDate
  return {
    ...loaded,
    profile: {
      ...loaded.profile,
      currentBankHours: loaded.profile.currentBankHours ?? 0,
      timezone: tz,
      lastSyncDate,
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
      kind: v.kind ?? ('planned' as const),
    })),
  }
}

/**
 * Run the catch-up reconciliation and toast a one-line summary if anything
 * changed. Used by both the synchronous localStorage hydration path and the
 * async IndexedDB hydration path so they apply the same fast-forward logic.
 */
function reconcile(state: AppState): AppState {
  const result = catchUpState(state)
  if (result.applied) {
    // Defer the toast so subscribers (which mount with the Dashboard) are
    // listening when it fires.
    setTimeout(() => {
      showToast({
        message: summarizeCatchUp(result.events),
        duration: 6000,
      })
    }, 0)
  }
  return result.state
}

/** Field-level identity check: did any of the user-visible balance fields
 *  change? Used to know when to bump lastSyncDate on a manual edit. */
function balancesChanged(
  prev: AppState['profile'],
  next: AppState['profile'],
): boolean {
  return (
    prev.currentVacationHours !== next.currentVacationHours ||
    prev.currentSickHours !== next.currentSickHours ||
    prev.currentBankHours !== next.currentBankHours ||
    prev.lastPaydayDate !== next.lastPaydayDate ||
    prev.hireDate !== next.hireDate
  )
}

/** Subtract hours from the matching pool. For 'any', drain bank → vacation → sick. */
function applyDebit(
  state: AppState,
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
): { vacation: number; sick: number; bank: number } {
  let vacation = state.profile.currentVacationHours
  let sick = state.profile.currentSickHours
  let bank = state.profile.currentBankHours
  if (source === 'vacation') {
    vacation -= hours
  } else if (source === 'sick') {
    sick -= hours
  } else if (source === 'bank') {
    bank -= hours
  } else {
    let remaining = hours
    const fromBank = Math.min(remaining, Math.max(0, bank))
    bank -= fromBank
    remaining -= fromBank
    if (remaining > 0) {
      const fromVaca = Math.min(remaining, Math.max(0, vacation))
      vacation -= fromVaca
      remaining -= fromVaca
    }
    if (remaining > 0) {
      const fromSick = Math.min(remaining, Math.max(0, sick))
      sick -= fromSick
    }
  }
  return { vacation, sick, bank }
}

/** Refund hours to the matching pool. 'any' credits back to vacation. */
function applyRefund(
  state: AppState,
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
): { vacation: number; sick: number; bank: number } {
  const vacation = state.profile.currentVacationHours
  const sick = state.profile.currentSickHours
  const bank = state.profile.currentBankHours
  if (source === 'sick') return { vacation, sick: sick + hours, bank }
  if (source === 'bank') return { vacation, sick, bank: bank + hours }
  return { vacation: vacation + hours, sick, bank }
}

function getInitialState(): { state: AppState | null; isDemo: boolean } {
  const loaded = loadState()
  if (loaded) {
    const migrated = migrateState(loaded)
    const reconciled = reconcile(migrated)
    return {
      state: reconciled,
      isDemo: loaded.profile.displayName === 'Demo User',
    }
  }
  return { state: null, isDemo: false }
}

export default function App() {
  const [{ state, isDemo }, setAppData] = useState(getInitialState)

  useEffect(() => {
    loadStateAsync().then((idbState) => {
      if (idbState) {
        setAppData((prev) => {
          if (prev.state) return prev
          return {
            state: reconcile(migrateState(idbState)),
            isDemo: idbState.profile.displayName === 'Demo User',
          }
        })
      }
    })
  }, [])

  // Re-run catch-up if the tab stays open across a calendar-day boundary or
  // becomes visible again after being hidden — paydays / Jan 1 grants /
  // payouts can fire while the tab was idle.
  useEffect(() => {
    let lastSyncedDay: string | null = null
    const tick = () => {
      setAppData((prev) => {
        if (!prev.state) return prev
        const tz = prev.state.profile.timezone || 'America/New_York'
        const todayIso = getNowInZone(tz).isoDate
        if (todayIso === lastSyncedDay) return prev
        lastSyncedDay = todayIso
        const result = catchUpState(prev.state)
        if (!result.applied) return prev
        setTimeout(() => {
          showToast({
            message: summarizeCatchUp(result.events),
            duration: 6000,
          })
        }, 0)
        return { ...prev, state: result.state }
      })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const interval = window.setInterval(tick, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(interval)
    }
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

  const importState = useCallback((incoming: AppState) => {
    const migrated = migrateState(incoming)
    const reconciled = reconcile(migrated)
    const isDemoData = reconciled.profile.displayName === 'Demo User'
    setAppData({ state: reconciled, isDemo: isDemoData })
    saveState(reconciled)
  }, [])

  const updateProfile = useCallback(
    (updates: Partial<AppState['profile']>) => {
      setAppData((prev) => {
        if (!prev.state) return prev
        const nextProfile = { ...prev.state.profile, ...updates }
        // A manual balance edit overrides whatever the catch-up engine
        // computed; anchor lastSyncDate to today so subsequent runs don't
        // re-apply paydays/grants the user just typed past. We deliberately
        // skip this for cosmetic edits (display name, timezone) so a
        // timezone change doesn't quietly suppress a pending catch-up.
        if (balancesChanged(prev.state.profile, nextProfile)) {
          const tz = nextProfile.timezone || 'America/New_York'
          nextProfile.lastSyncDate = getNowInZone(tz).isoDate
        }
        return { ...prev, state: { ...prev.state, profile: nextProfile } }
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
      const entry = prev.state.plannedVacations.find((v) => v.id === id)
      if (entry && entry.kind === 'logged_past') {
        const hrs = entry.actualHoursUsed ?? entry.hoursPerDay ?? prev.state.policy.hoursPerWorkDay
        const refunded = applyRefund(prev.state, hrs, entry.hourSource || 'any')
        return {
          ...prev,
          state: {
            ...prev.state,
            profile: {
              ...prev.state.profile,
              currentVacationHours: refunded.vacation,
              currentSickHours: refunded.sick,
              currentBankHours: refunded.bank,
            },
            plannedVacations: prev.state.plannedVacations.filter((v) => v.id !== id),
          },
        }
      }
      return {
        ...prev,
        state: {
          ...prev.state,
          plannedVacations: prev.state.plannedVacations.filter((v) => v.id !== id),
        },
      }
    })
  }, [])

  const addPastAbsence = useCallback((vacation: PlannedVacation) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      const entry: PlannedVacation = { ...vacation, kind: 'logged_past' }
      const hrs = entry.actualHoursUsed ?? entry.hoursPerDay ?? prev.state.policy.hoursPerWorkDay
      const debited = applyDebit(prev.state, hrs, entry.hourSource || 'sick')
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentVacationHours: debited.vacation,
            currentSickHours: debited.sick,
            currentBankHours: debited.bank,
          },
          plannedVacations: [...prev.state.plannedVacations, entry],
        },
      }
    })
  }, [])

  const removePastAbsence = removeVacation

  const adjustActualHours = useCallback((id: string, actualHoursUsed: number) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      const entry = prev.state.plannedVacations.find((v) => v.id === id)
      if (!entry) return prev

      const newEntries = prev.state.plannedVacations.map((v) =>
        v.id === id ? { ...v, actualHoursUsed } : v,
      )

      if (entry.kind !== 'logged_past') {
        return {
          ...prev,
          state: { ...prev.state, plannedVacations: newEntries },
        }
      }

      const oldHrs = entry.actualHoursUsed ?? entry.hoursPerDay ?? prev.state.policy.hoursPerWorkDay
      const delta = actualHoursUsed - oldHrs
      let pools = {
        vacation: prev.state.profile.currentVacationHours,
        sick: prev.state.profile.currentSickHours,
        bank: prev.state.profile.currentBankHours,
      }
      if (delta > 0) {
        pools = applyDebit(prev.state, delta, entry.hourSource || 'sick')
      } else if (delta < 0) {
        pools = applyRefund(prev.state, -delta, entry.hourSource || 'sick')
      }
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentVacationHours: pools.vacation,
            currentSickHours: pools.sick,
            currentBankHours: pools.bank,
          },
          plannedVacations: newEntries,
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
        importState,
        updateProfile,
        updatePolicy,
        addVacation,
        removeVacation,
        updateVacation,
        addPastAbsence,
        removePastAbsence,
        adjustActualHours,
        addBankHours,
        removeBankHours,
        toggleTheme,
        setShowTour,
        isDemo,
        resetToSetup,
      }}
    >
      <div className="min-h-screen lg:h-screen flex flex-col lg:overflow-hidden">
        <UpdateBanner />
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      </div>
    </AppContext.Provider>
  )
}
