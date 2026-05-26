import { useCallback, useEffect, useState } from 'react'
import type { AppState, BankHoursEntry, PlannedVacation } from './lib/types'
import {
  loadState,
  loadStateAsync,
  saveState,
  clearState,
  subscribeToCrossTabUpdates,
} from './lib/storage'
import { SetupWizard } from './components/SetupWizard'
import { Dashboard } from './components/Dashboard'
import { UpdateBanner } from './components/UpdateBanner'
import { AppContext } from './context'
import { catchUpState, summarizeCatchUp } from './lib/catchUp'
import { showToast } from './lib/toastBus'
import { getNowInZone } from './lib/timeUtils'

/** Must match CURRENT_VERSION in lib/storage.ts. Hardcoded here (rather than
 *  imported) to avoid widening storage's public surface; isPlausibleAppState
 *  rejects any other value at load time. */
const CURRENT_VERSION = 1

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
    // Force the current schema version so an imported backup carrying a
    // different version number doesn't get persisted and then permanently
    // rejected by the strict load-time check (which would kick the user back
    // to the Setup Wizard). Mirrors CURRENT_VERSION in storage.ts.
    version: CURRENT_VERSION,
    profile: {
      ...loaded.profile,
      currentBankHours: loaded.profile.currentBankHours ?? 0,
      timezone: tz,
      lastSyncDate,
    },
    bankHoursLog: loaded.bankHoursLog ?? [],
    catchUpHistory: loaded.catchUpHistory ?? [],
    showTour: loaded.showTour ?? false,
    policy: {
      ...loaded.policy,
      // Older backups predate carryoverPayoutDate; backfill so projection and
      // catch-up don't crash on `.month`/`.day`. Default = first Feb pay date.
      carryoverPayoutDate: loaded.policy.carryoverPayoutDate ?? { month: 2, day: 1 },
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

const CATCH_UP_HISTORY_LIMIT = 50

function appendCatchUpHistory(state: AppState, result: ReturnType<typeof catchUpState>): AppState {
  if (!result.applied) return result.state
  const tz = state.profile.timezone || 'America/New_York'
  const entry = {
    ranOn: getNowInZone(tz).isoDate,
    syncedTo: result.syncedTo,
    summary: summarizeCatchUp(result.events),
    events: result.events.map((e) => ({
      date: e.date,
      type: e.type,
      pool: e.pool,
      delta: e.delta,
      label: e.label,
    })),
  }
  const prev = result.state.catchUpHistory ?? []
  const next = [entry, ...prev].slice(0, CATCH_UP_HISTORY_LIMIT)
  return { ...result.state, catchUpHistory: next }
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
  return appendCatchUpHistory(state, result)
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

/** Per-pool breakdown of how many hours a debit actually drew from each pool.
 *  Stored on the entry as `debitedFrom` so a later refund credits the exact
 *  same pools instead of guessing. */
type PoolBreakdown = { vacation: number; sick: number; bank: number }

/** Result of a debit: the new pool balances PLUS the per-pool amounts that
 *  were actually deducted. Callers persist `drawn` into the entry's
 *  `debitedFrom` so the refund side is symmetric with the debit side. */
type DebitResult = {
  balances: PoolBreakdown
  drawn: PoolBreakdown
}

/** Subtract hours from the matching pool. For 'any', drain bank → vacation → sick.
 *  Returns both the new balances and the per-pool breakdown actually deducted. */
function applyDebit(
  state: AppState,
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
): DebitResult {
  let vacation = state.profile.currentVacationHours
  let sick = state.profile.currentSickHours
  let bank = state.profile.currentBankHours
  const drawn: PoolBreakdown = { vacation: 0, sick: 0, bank: 0 }
  if (source === 'vacation') {
    vacation -= hours
    drawn.vacation = hours
  } else if (source === 'sick') {
    sick -= hours
    drawn.sick = hours
  } else if (source === 'bank') {
    bank -= hours
    drawn.bank = hours
  } else {
    let remaining = hours
    const fromBank = Math.min(remaining, Math.max(0, bank))
    bank -= fromBank
    remaining -= fromBank
    drawn.bank = fromBank
    if (remaining > 0) {
      const fromVaca = Math.min(remaining, Math.max(0, vacation))
      vacation -= fromVaca
      remaining -= fromVaca
      drawn.vacation = fromVaca
    }
    if (remaining > 0) {
      const fromSick = Math.min(remaining, Math.max(0, sick))
      sick -= fromSick
      drawn.sick = fromSick
    }
  }
  return { balances: { vacation, sick, bank }, drawn }
}

/** Refund hours to the matching pool. 'any' credits back to vacation. Used as
 *  the fallback for older entries that have no recorded `debitedFrom`. */
function applyRefund(
  state: AppState,
  hours: number,
  source: 'vacation' | 'sick' | 'bank' | 'any',
): PoolBreakdown {
  const vacation = state.profile.currentVacationHours
  const sick = state.profile.currentSickHours
  const bank = state.profile.currentBankHours
  if (source === 'sick') return { vacation, sick: sick + hours, bank }
  if (source === 'bank') return { vacation, sick, bank: bank + hours }
  return { vacation: vacation + hours, sick, bank }
}

/** Refund an entry's exact recorded per-pool breakdown back to those pools.
 *  Used when `debitedFrom` is present so a bank-only debit refunds to bank,
 *  not vacation. */
function applyBreakdownRefund(
  state: AppState,
  breakdown: PoolBreakdown,
): PoolBreakdown {
  return {
    vacation: state.profile.currentVacationHours + breakdown.vacation,
    sick: state.profile.currentSickHours + breakdown.sick,
    bank: state.profile.currentBankHours + breakdown.bank,
  }
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
  // payouts can fire while the tab was idle. Tick is suspended while the tab
  // is hidden so we don't burn 1440 catch-ups/day in a background tab.
  useEffect(() => {
    let lastSyncedDay: string | null = null
    let interval: number | null = null
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
        return { ...prev, state: appendCatchUpHistory(prev.state, result) }
      })
    }
    const startInterval = () => {
      if (interval !== null) return
      interval = window.setInterval(tick, 60_000)
    }
    const stopInterval = () => {
      if (interval === null) return
      window.clearInterval(interval)
      interval = null
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick()
        startInterval()
      } else {
        stopInterval()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    if (document.visibilityState === 'visible') startInterval()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stopInterval()
    }
  }, [])

  // Cross-tab sync: when another tab writes to the same key, pull the latest
  // state in so we don't blow away their changes on our next save.
  useEffect(() => {
    return subscribeToCrossTabUpdates((incoming) => {
      setAppData((prev) => {
        if (!prev.state) {
          return { state: incoming, isDemo: incoming.profile.displayName === 'Demo User' }
        }
        // Only toast when the change actually came from elsewhere — guard
        // on a structural diff so saving back a no-op doesn't spam users.
        const same =
          JSON.stringify(prev.state.profile) === JSON.stringify(incoming.profile) &&
          JSON.stringify(prev.state.plannedVacations) ===
            JSON.stringify(incoming.plannedVacations) &&
          JSON.stringify(prev.state.bankHoursLog) === JSON.stringify(incoming.bankHoursLog)
        if (!same) {
          setTimeout(() => {
            showToast({
              message: 'Updated from another tab',
              duration: 5000,
            })
          }, 0)
        }
        return { ...prev, state: incoming }
      })
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
      // Only auto-merge PLANNED entries with other overlapping PLANNED entries.
      // Never merge a logged_past entry (it already mutated balances) and never
      // merge across kind — doing so corrupts balances. logged_past incoming
      // entries don't come through addVacation, but guard anyway.
      const incomingKind = vacation.kind ?? 'planned'
      const overlapping =
        incomingKind === 'planned'
          ? newVacations.filter(
              (v) =>
                (v.kind ?? 'planned') === 'planned' &&
                v.startDate <= vacation.endDate &&
                v.endDate >= vacation.startDate,
            )
          : []

      if (overlapping.length > 0) {
        const allDates = [
          vacation.startDate,
          vacation.endDate,
          ...overlapping.flatMap((v) => [v.startDate, v.endDate]),
        ].sort()
        const mergedStart = allDates[0]
        const mergedEnd = allDates[allDates.length - 1]

        // Preserve data across the merge instead of discarding the overlapped
        // entries' fields. Notes are concatenated (distinct, joined with " · "),
        // hoursPerDay takes the MIN (most conservative), and most other fields
        // prefer the incoming entry but fall back to any overlapped value.
        const merged = [...overlapping, vacation]
        const notes = Array.from(
          new Set(
            merged
              .map((v) => v.note?.trim())
              .filter((n): n is string => !!n),
          ),
        )
        const mergedNote = notes.length > 0 ? notes.join(' · ') : undefined

        const hoursPerDayValues = merged
          .map((v) => v.hoursPerDay)
          .filter((h): h is number => typeof h === 'number')
        const mergedHoursPerDay =
          hoursPerDayValues.length > 0 ? Math.min(...hoursPerDayValues) : undefined

        // Keep a consistent hourSource: prefer the incoming entry's. If the
        // overlapped entries used a different source, note it rather than
        // silently dropping it.
        const distinctSources = Array.from(new Set(merged.map((v) => v.hourSource)))
        const sourceNote =
          distinctSources.length > 1
            ? `sources merged: ${distinctSources.join(', ')}`
            : undefined
        const finalNote =
          sourceNote && mergedNote
            ? `${mergedNote} · ${sourceNote}`
            : sourceNote ?? mergedNote

        const firstOverlap = overlapping[0]
        const mergedEntry: PlannedVacation = {
          ...firstOverlap,
          ...vacation,
          startDate: mergedStart,
          endDate: mergedEnd,
          kind: 'planned',
          note: finalNote,
          hoursPerDay: mergedHoursPerDay,
          // Prefer incoming display/time fields, but keep an overlapped value
          // when the incoming entry doesn't supply one.
          timeOffStart: vacation.timeOffStart ?? firstOverlap.timeOffStart,
          timeOffEnd: vacation.timeOffEnd ?? firstOverlap.timeOffEnd,
          customEmoji: vacation.customEmoji ?? firstOverlap.customEmoji,
        }

        const filtered = newVacations.filter((v) => !overlapping.includes(v))
        filtered.push(mergedEntry)
        setTimeout(() => {
          showToast({
            message:
              overlapping.length === 1
                ? `Merged with overlapping entry → ${mergedStart} to ${mergedEnd}`
                : `Merged with ${overlapping.length} overlapping entries → ${mergedStart} to ${mergedEnd}`,
            duration: 6000,
          })
        }, 0)
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
        // Prefer the recorded per-pool breakdown so we credit back exactly the
        // pools that were debited (bank → bank, not bank → vacation). Older
        // entries lack debitedFrom, so fall back to the source-based refund.
        const refunded = entry.debitedFrom
          ? applyBreakdownRefund(prev.state, entry.debitedFrom)
          : applyRefund(
              prev.state,
              entry.actualHoursUsed ?? entry.hoursPerDay ?? prev.state.policy.hoursPerWorkDay,
              entry.hourSource || 'any',
            )
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
      const hrs = vacation.actualHoursUsed ?? vacation.hoursPerDay ?? prev.state.policy.hoursPerWorkDay
      const debited = applyDebit(prev.state, hrs, vacation.hourSource || 'sick')
      // Record exactly which pools were drawn so a later delete/edit refunds
      // the same buckets instead of dumping everything back into vacation.
      const entry: PlannedVacation = {
        ...vacation,
        kind: 'logged_past',
        debitedFrom: debited.drawn,
      }
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentVacationHours: debited.balances.vacation,
            currentSickHours: debited.balances.sick,
            currentBankHours: debited.balances.bank,
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

      if (entry.kind !== 'logged_past') {
        const newEntries = prev.state.plannedVacations.map((v) =>
          v.id === id ? { ...v, actualHoursUsed } : v,
        )
        return {
          ...prev,
          state: { ...prev.state, plannedVacations: newEntries },
        }
      }

      // Fully unwind the original debit, then re-debit at the new hours. This
      // keeps `debitedFrom` exactly consistent with the new total (regardless
      // of whether hours went up or down) so a later delete refunds correctly.
      // Older entries with no debitedFrom fall back to the source-based refund.
      const refunded = entry.debitedFrom
        ? applyBreakdownRefund(prev.state, entry.debitedFrom)
        : applyRefund(
            prev.state,
            entry.actualHoursUsed ?? entry.hoursPerDay ?? prev.state.policy.hoursPerWorkDay,
            entry.hourSource || 'sick',
          )
      const refundedState: AppState = {
        ...prev.state,
        profile: {
          ...prev.state.profile,
          currentVacationHours: refunded.vacation,
          currentSickHours: refunded.sick,
          currentBankHours: refunded.bank,
        },
      }
      const debited = applyDebit(refundedState, actualHoursUsed, entry.hourSource || 'sick')
      const newEntries = prev.state.plannedVacations.map((v) =>
        v.id === id ? { ...v, actualHoursUsed, debitedFrom: debited.drawn } : v,
      )
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentVacationHours: debited.balances.vacation,
            currentSickHours: debited.balances.sick,
            currentBankHours: debited.balances.bank,
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
      const tz = prev.state.profile.timezone || 'America/New_York'
      const todayIso = getNowInZone(tz).isoDate
      const isFuture = entry.date > todayIso
      const stamped: BankHoursEntry = { ...entry, appliedToBalance: !isFuture }
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentBankHours: isFuture
              ? prev.state.profile.currentBankHours
              : prev.state.profile.currentBankHours + entry.hours,
          },
          bankHoursLog: [...prev.state.bankHoursLog, stamped],
        },
      }
    })
  }, [])

  const removeBankHours = useCallback((id: string) => {
    setAppData((prev) => {
      if (!prev.state) return prev
      const entry = prev.state.bankHoursLog.find((e) => e.id === id)
      if (!entry) return prev
      // Only roll back the balance if the entry was actually credited.
      // Future-dated entries that never reached their date weren't applied,
      // so removing them shouldn't affect the running total.
      const wasApplied = entry.appliedToBalance !== false
      return {
        ...prev,
        state: {
          ...prev.state,
          profile: {
            ...prev.state.profile,
            currentBankHours: wasApplied
              ? prev.state.profile.currentBankHours - entry.hours
              : prev.state.profile.currentBankHours,
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
