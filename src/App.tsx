import { useCallback, useEffect, useRef, useState } from 'react'
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
import { migrateState } from './lib/migrate'
import { applyDebit, applyRefund, applyBreakdownRefund } from './lib/balances'

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
  // The last snapshot we've already persisted. Seeded with the initial state so
  // the mount-time save effect does NOT re-stamp savedAt with a fresh timestamp
  // on every app open (which would defeat loadStateAsync's savedAt arbitration
  // and let a stale store win). Cross-tab updates also point this at the
  // incoming snapshot to suppress an echo-save loop between tabs.
  const lastPersistedRef = useRef<AppState | null>(state)

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
        // Always commit the reconciled state (appendCatchUpHistory returns
        // result.state even when !applied). catch-up can flip an elapsed
        // vacation to logged_past and advance lastSyncDate while emitting NO
        // balance event (e.g. all pools empty); discarding result.state here
        // would diverge from the cold-load path and re-process the vacation
        // forever. Only the toast is gated on a balance-changing event.
        if (result.applied) {
          setTimeout(() => {
            showToast({
              message: summarizeCatchUp(result.events),
              duration: 6000,
            })
          }, 0)
        }
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
      // Run the incoming snapshot through the same migration every other
      // ingestion path uses, so a payload missing a nested field migrateState
      // would backfill (timezone, payout anchors, per-vacation kind, …) can't
      // land raw and crash projection/catch-up. (No reconcile here — the
      // writing tab already reconciled before saving.)
      const migrated = migrateState(incoming)
      setAppData((prev) => {
        if (!prev.state) {
          lastPersistedRef.current = migrated
          return { state: migrated, isDemo: migrated.profile.displayName === 'Demo User' }
        }
        // Only react when the change actually came from elsewhere — guard on a
        // structural diff so an identical echo neither toasts nor triggers a
        // save.
        const same =
          JSON.stringify(prev.state.profile) === JSON.stringify(migrated.profile) &&
          JSON.stringify(prev.state.plannedVacations) ===
            JSON.stringify(migrated.plannedVacations) &&
          JSON.stringify(prev.state.bankHoursLog) === JSON.stringify(migrated.bankHoursLog)
        if (same) return prev
        // Point lastPersistedRef at the incoming snapshot so the save effect
        // does NOT write it straight back (which would re-stamp savedAt and
        // start a localStorage→IDB ping-pong between the two tabs).
        lastPersistedRef.current = migrated
        setTimeout(() => {
          showToast({
            message: 'Updated from another tab',
            duration: 5000,
          })
        }, 0)
        return { ...prev, state: migrated }
      })
    })
  }, [])

  useEffect(() => {
    // Only persist when the in-memory state actually changed since the last
    // save. Skipping the no-op mount-time save keeps savedAt meaning "when the
    // user last changed data", which loadStateAsync relies on to pick the newer
    // of the localStorage / IndexedDB snapshots. (Cold-load catch-up results
    // are idempotent, so deferring their persistence to the first real edit is
    // safe.)
    if (state && state !== lastPersistedRef.current) {
      lastPersistedRef.current = state
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
          const zonedToday = getNowInZone(tz).isoDate
          // Never let a manual edit move lastSyncDate BACKWARD (a rewound clock
          // or a TZ shift could make "today" earlier). Moving it back would let
          // catch-up re-apply already-booked paydays/payouts — e.g. re-zeroing
          // freshly-banked hours after a bank payout already fired this cycle.
          const prevSync = prev.state.profile.lastSyncDate
          nextProfile.lastSyncDate =
            prevSync && prevSync > zonedToday ? prevSync : zonedToday
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
