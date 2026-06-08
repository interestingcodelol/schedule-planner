import type { AppState } from './types'
import { defaultPolicy } from './defaultPolicy'
import { CURRENT_VERSION } from './storage'

/**
 * State migration / merge contract — how customizations survive a deploy.
 *
 *  - **Logic fixes ship in code.** Bug fixes in the projection/catch-up engines,
 *    components, etc. reach every user on the next load because the stored data
 *    is config only, never code.
 *  - **Stored customizations are preserved.** `migrateState` spreads the loaded
 *    profile/policy FIRST and only fills in genuinely-missing keys. It never
 *    overwrites a value the user already has, and never rewrites customizable
 *    arrays (`accrualTiers`, `holidays`, `workDaysPerWeek`).
 *  - **New scalar policy fields reach existing users** via a `?? defaultPolicy.X`
 *    backfill below — add one line per new scalar field. Keep it idempotent: the
 *    backfilled value must itself be a valid stored value so re-running migration
 *    is a no-op (e.g. don't use `undefined` to mean a real configured state).
 *  - **Schema-breaking change:** bump `CURRENT_VERSION` (in storage.ts) and add a
 *    version-keyed upgrade step here. Load is downgrade-safe (storage's
 *    `isPlausibleAppState` accepts any structurally-valid version), so a stale
 *    cached build can't wipe newer data.
 */

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
  } catch {
    return 'America/New_York'
  }
}

export function migrateState(loaded: AppState): AppState {
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
    // rejected by a strict load-time check.
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
      // Older backups predate these anchors; backfill so projection and
      // catch-up don't crash on `.month`/`.day`.
      carryoverPayoutDate: loaded.policy.carryoverPayoutDate ?? defaultPolicy.carryoverPayoutDate,
      bankHoursPayoutStart: loaded.policy.bankHoursPayoutStart ?? defaultPolicy.bankHoursPayoutStart,
      bankHoursPayoutEnd: loaded.policy.bankHoursPayoutEnd ?? defaultPolicy.bankHoursPayoutEnd,
      // Additive sick-leave scalars: backfill from defaults so the projection
      // (grant / carry-over forfeiture / max balance) works for users whose
      // saved policy predates these fields. Present values are kept as-is.
      sickLeaveAnnualGrant: loaded.policy.sickLeaveAnnualGrant ?? defaultPolicy.sickLeaveAnnualGrant,
      sickLeaveMaxBalance: loaded.policy.sickLeaveMaxBalance ?? defaultPolicy.sickLeaveMaxBalance,
      sickLeaveCarryoverCap: loaded.policy.sickLeaveCarryoverCap ?? defaultPolicy.sickLeaveCarryoverCap,
    },
    plannedVacations: loaded.plannedVacations.map((v) => {
      const hourSource = v.hourSource ?? ('any' as const)
      const kind = v.kind ?? ('planned' as const)
      // Backfill debitedFrom on legacy logged_past entries created before the
      // field existed, so a later delete/edit refunds the exact pool(s) instead
      // of dumping everything into vacation (see removeVacation). For an
      // explicit source the split is exact; an 'any'-source legacy entry can't
      // be reconstructed, so it's left undefined (the source-based fallback
      // still applies).
      let debitedFrom = v.debitedFrom
      if (kind === 'logged_past' && !debitedFrom && hourSource !== 'any') {
        const total = v.actualHoursUsed ?? v.hoursPerDay ?? loaded.policy.hoursPerWorkDay
        debitedFrom = {
          vacation: hourSource === 'vacation' ? total : 0,
          sick: hourSource === 'sick' ? total : 0,
          bank: hourSource === 'bank' ? total : 0,
        }
      }
      return { ...v, hourSource, kind, debitedFrom }
    }),
  }
}
