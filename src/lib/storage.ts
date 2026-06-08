import type { AppState } from './types'
import { loadStateFromIdb, saveStateToIdb, clearIdbState } from './indexedDb'
import { showToast } from './toastBus'

const STORAGE_KEY = 'schedule-planner-state-v1'
const LEGACY_STORAGE_KEY = 'leave-lens-state-v1'
const LAST_EXPORT_KEY = 'schedule-planner-last-export'
/** Current schema version. Imported by migrate.ts (the single owner of the
 *  upgrade logic) so the constant lives in one place. */
export const CURRENT_VERSION = 1
const BACKUP_TYPE = 'schedule-planner-backup'

declare const __BUILD_ID__: string

let lastQuotaWarningAt = 0

function warnStorageFailure(reason: 'quota' | 'unavailable'): void {
  const now = Date.now()
  if (now - lastQuotaWarningAt < 30_000) return
  lastQuotaWarningAt = now
  setTimeout(() => {
    showToast({
      message:
        reason === 'quota'
          ? 'Browser storage full — recent changes may not be saved. Export a backup or free up space.'
          : 'Browser storage unavailable — changes will not persist (private/incognito mode?).',
      duration: 8000,
    })
  }, 0)
}

export function loadState(): AppState | null {
  return parseLocalStorageState(true)
}

/** Read + parse the localStorage snapshot. When `migrateLegacy` is true (the
 *  public `loadState` path) this also promotes a legacy-keyed value to the
 *  current key as a side effect; `loadStateAsync` passes false so its read is
 *  side-effect-free and can be compared against IndexedDB before deciding what
 *  to persist. */
function parseLocalStorageState(migrateLegacy: boolean): AppState | null {
  try {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        raw = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (raw && migrateLegacy) {
          localStorage.setItem(STORAGE_KEY, raw)
          localStorage.removeItem(LEGACY_STORAGE_KEY)
        }
      }
    } catch {
      warnStorageFailure('unavailable')
      return null
    }
    if (!raw) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Corrupted JSON — wipe so subsequent saves work, but warn first.
      setTimeout(() => {
        showToast({
          message: 'Saved data was corrupted and could not be loaded.',
          duration: 8000,
        })
      }, 0)
      return null
    }

    if (!isPlausibleAppState(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveState(state: AppState): void {
  // Stamp a shallow copy (don't mutate the caller's object) so localStorage and
  // IndexedDB receive the SAME timestamped snapshot. `savedAt` is what
  // `loadStateAsync` arbitrates on to decide which store is newer.
  const stamped: AppState = { ...state, savedAt: Date.now() }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped))
  } catch (err) {
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    warnStorageFailure(isQuota ? 'quota' : 'unavailable')
  }
  saveStateToIdb(stamped).catch(() => {})
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY)
  clearIdbState().catch(() => {})
}

/** Load the freshest persisted state, arbitrating between IndexedDB and
 *  localStorage by their `savedAt` timestamp rather than by load order.
 *
 *  Both stores are written by `saveState` with the SAME stamped snapshot, but
 *  they can drift: an IDB write can fail silently, or localStorage can be
 *  evicted, or one store can be written by an older app version. Reading IDB
 *  first and unconditionally promoting it (the old behavior) let a stale IDB
 *  snapshot clobber a newer localStorage value. Instead we compare `savedAt`
 *  (missing = 0, i.e. oldest) and keep the newer side. Stores are only
 *  resynced toward the winner, never away from it. */
export async function loadStateAsync(): Promise<AppState | null> {
  const idbRaw = await loadStateFromIdb()
  const idbState = idbRaw && isPlausibleAppState(idbRaw) ? idbRaw : null
  // Side-effect-free localStorage read so we don't migrate the legacy key
  // before we know whether localStorage even wins.
  const localState = parseLocalStorageState(false)

  // Only one (or neither) store has usable state — no arbitration needed.
  if (!idbState && !localState) return null
  if (!idbState) {
    // localStorage present, IDB empty/invalid: use localStorage (and run the
    // public loadState path once to apply the legacy-key migration). Resync
    // localStorage -> IDB so the two converge.
    saveStateToIdb(localState as AppState).catch(() => {})
    return loadState()
  }
  if (!localState) {
    // IDB present, localStorage evicted/empty: promote IDB into localStorage.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(idbState))
    } catch {
      // localStorage may be full or unavailable — IndexedDB is still usable.
    }
    return idbState
  }

  // Both present: keep whichever was saved more recently.
  const idbTime = typeof idbState.savedAt === 'number' ? idbState.savedAt : 0
  const localTime = typeof localState.savedAt === 'number' ? localState.savedAt : 0

  if (idbTime > localTime) {
    // IDB is strictly newer — promote it into localStorage.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(idbState))
    } catch {
      // localStorage write failed — IDB value is still returned and authoritative.
    }
    return idbState
  }

  // localStorage is newer-or-equal: keep it (never let an older/equal IDB
  // snapshot win). On a strict win, resync localStorage -> IDB so they
  // converge; on a tie, the stores already match so skip the write.
  if (localTime > idbTime) {
    saveStateToIdb(localState).catch(() => {})
  }
  return localState
}

/** Cheap structural check used both on load and after IDB hydration. Catches
 *  corrupted/truncated state before it reaches the rest of the app. */
function isPlausibleAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  // Downgrade-safe: accept any structurally-valid versioned snapshot rather than
  // requiring an exact version match. A stale cached build loading a snapshot
  // written by a NEWER build (higher version) must NOT be rejected — that would
  // wipe the user back to the Setup Wizard. migrateState normalizes the version
  // and backfills any missing fields after load; schema changes here are
  // additive, so a forward-version read is safe.
  if (typeof v.version !== 'number' || v.version < 1) return false
  if (!v.profile || typeof v.profile !== 'object') return false
  if (!v.policy || typeof v.policy !== 'object') return false
  if (!Array.isArray(v.plannedVacations)) return false
  return true
}

const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

/** Subscribe to cross-tab state changes. Fires when another tab writes to the
 *  same storage key — caller refreshes its in-memory state to avoid the "two
 *  tabs blow away each other's saves" race. */
export function subscribeToCrossTabUpdates(
  onUpdate: (state: AppState) => void,
): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return
    try {
      const parsed = JSON.parse(e.newValue)
      if (isPlausibleAppState(parsed)) onUpdate(parsed)
    } catch {
      /* ignore — corrupted incoming write */
    }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function getTabId(): string {
  return TAB_ID
}

/** Build the canonical export filename for "now". */
export function backupFilename(date = new Date()): string {
  return `schedule-planner-backup-${date.toISOString().slice(0, 10)}.json`
}

/** Serialize AppState into the portable backup envelope (pretty-printed).
 *
 *  The envelope keeps every AppState field at the TOP LEVEL so that older
 *  import logic (and `validateImportedState`) still accepts it unchanged. It
 *  layers in `_`-prefixed metadata that import strips/ignores, plus a human
 *  note so a recipient who opens the raw file knows what it is and how to use
 *  it. This is the single source of truth for the export bytes — both the
 *  file download and the clipboard/share paths call it. */
export function buildBackupJson(state: AppState): string {
  const appVersion =
    typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown'
  const envelope = {
    ...state,
    _backupType: BACKUP_TYPE,
    _schemaVersion: state.version,
    _exportedAt: new Date().toISOString(),
    _appVersion: appVersion,
    _note: 'Email this file to yourself to restore your Schedule Planner setup on any device.',
  }
  return JSON.stringify(envelope, null, 2)
}

/** Record that a backup was just produced (download/clipboard/share). Read by
 *  BackupNag as a fallback so the staleness chip clears even when the export
 *  came from a path that doesn't touch the profile. */
export function markExported(date = new Date()): void {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, date.toISOString())
  } catch {
    // Non-fatal — the profile.lastExportDate is the primary signal.
  }
}

/** ISO timestamp of the most recent export, or null if none recorded. */
export function getLastExportTimestamp(): string | null {
  try {
    return localStorage.getItem(LAST_EXPORT_KEY)
  } catch {
    return null
  }
}

export function exportState(state: AppState): void {
  const filename = backupFilename()
  const blob = new Blob([buildBackupJson(state)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  markExported()
}

/** Result of attempting to parse a pasted/uploaded backup. */
export type ParsedBackup =
  | { ok: true; state: AppState }
  | { ok: false; error: string }

/** Robust import entry point used by both the file picker and the paste box.
 *
 *  Accepts: the new envelope (with `_`-prefixed metadata), legacy raw AppState
 *  JSON, or anything in between. Strips metadata fields, validates via
 *  `validateImportedState`, and returns a human-readable error on failure so
 *  the UI can surface it directly. */
export function parseImportedBackup(raw: string): ParsedBackup {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, error: 'Nothing to import — paste or choose a backup file first.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {
      ok: false,
      error: "That isn't valid JSON. Make sure you copied the whole backup file, including the opening { and closing }.",
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "This doesn't look like a Schedule Planner backup — expected a JSON object.",
    }
  }

  // Strip the `_`-prefixed envelope metadata; what remains should be AppState.
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.startsWith('_')) stripped[key] = value
  }

  if (!validateImportedState(stripped)) {
    // Point at the most likely missing/invalid piece so the message is useful.
    const obj = stripped as Record<string, unknown>
    let detail = 'the data is missing required fields or is from an incompatible app'
    if (!obj.profile || typeof obj.profile !== 'object') {
      detail = 'missing the profile section'
    } else if (!Array.isArray(obj.plannedVacations)) {
      detail = 'missing the planned vacations list'
    } else if (!obj.policy || typeof obj.policy !== 'object') {
      detail = 'missing the leave policy'
    } else if (typeof obj.version !== 'number') {
      detail = 'missing a version number'
    }
    return {
      ok: false,
      error: `This doesn't look like a Schedule Planner backup — ${detail}.`,
    }
  }

  return { ok: true, state: stripped }
}

export function validateImportedState(data: unknown): data is AppState {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>

  if (typeof obj.version !== 'number') return false
  // theme, when present, must be exactly 'light' or 'dark'. Older exports may
  // omit it (migration doesn't backfill theme, so require it here as before),
  // but a garbage value must be rejected rather than imported and crashing.
  if (obj.theme !== 'light' && obj.theme !== 'dark') return false
  if (!Array.isArray(obj.plannedVacations)) return false

  // Each planned vacation must be a well-formed object so the rest of the app
  // (projection, catch-up, calendar) doesn't crash on a malformed entry.
  for (const v of obj.plannedVacations) {
    if (typeof v !== 'object' || v === null) return false
    const pv = v as Record<string, unknown>
    if (typeof pv.id !== 'string') return false
    if (typeof pv.startDate !== 'string' || !isValidIsoDate(pv.startDate)) return false
    if (typeof pv.endDate !== 'string' || !isValidIsoDate(pv.endDate)) return false
    if (
      pv.hourSource !== undefined &&
      !['vacation', 'sick', 'bank', 'any'].includes(pv.hourSource as string)
    ) {
      return false
    }
  }

  // bankHoursLog is optional in older exports, but if present must be an array.
  if (obj.bankHoursLog !== undefined && !Array.isArray(obj.bankHoursLog)) return false

  const profile = obj.profile as Record<string, unknown> | undefined
  if (!profile) return false
  if (typeof profile.hireDate !== 'string' || !isValidIsoDate(profile.hireDate)) return false
  if (typeof profile.currentVacationHours !== 'number' || !isFinite(profile.currentVacationHours)) return false
  if (typeof profile.currentSickHours !== 'number' || !isFinite(profile.currentSickHours)) return false
  if (typeof profile.lastPaydayDate !== 'string' || !isValidIsoDate(profile.lastPaydayDate)) return false
  // lastSyncDate is optional in older exports; migration backfills it.
  if (
    profile.lastSyncDate !== undefined &&
    (typeof profile.lastSyncDate !== 'string' || !isValidIsoDate(profile.lastSyncDate))
  ) {
    return false
  }
  // currentBankHours is optional in older exports; migration backfills to 0.
  if (
    profile.currentBankHours !== undefined &&
    (typeof profile.currentBankHours !== 'number' || !isFinite(profile.currentBankHours))
  ) {
    return false
  }

  const policy = obj.policy as Record<string, unknown> | undefined
  if (!policy) return false
  if (!Array.isArray(policy.accrualTiers) || policy.accrualTiers.length === 0) return false
  // Each accrual tier must have finite minYears/hoursPerPayPeriod and a
  // number|null maxYears, or computeAccrualTier produces NaN balances.
  for (const t of policy.accrualTiers) {
    if (typeof t !== 'object' || t === null) return false
    const tier = t as Record<string, unknown>
    if (typeof tier.minYears !== 'number' || !isFinite(tier.minYears)) return false
    if (typeof tier.hoursPerPayPeriod !== 'number' || !isFinite(tier.hoursPerPayPeriod)) return false
    if (
      tier.maxYears !== null &&
      (typeof tier.maxYears !== 'number' || !isFinite(tier.maxYears))
    ) {
      return false
    }
  }
  if (!Array.isArray(policy.workDaysPerWeek) || policy.workDaysPerWeek.length === 0) return false
  // Work days are day-of-week indices 0–6.
  for (const d of policy.workDaysPerWeek) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return false
  }
  if (typeof policy.payPeriodLengthDays !== 'number' || policy.payPeriodLengthDays <= 0) return false
  if (typeof policy.hoursPerWorkDay !== 'number' || policy.hoursPerWorkDay <= 0) return false

  // Month/day anchor objects, when present, must be well-formed {month, day}
  // so projection/catch-up don't crash reading .month/.day.
  if (!isValidMonthDay(policy.carryoverPayoutDate, true)) return false
  if (!isValidMonthDay(policy.bankHoursPayoutStart, true)) return false
  if (!isValidMonthDay(policy.bankHoursPayoutEnd, true)) return false

  return true
}

/** Validate an optional `{ month, day }` anchor. When `optional` is true,
 *  `undefined` passes (migration backfills it); any present value must be an
 *  object with numeric month/day. */
function isValidMonthDay(value: unknown, optional: boolean): boolean {
  if (value === undefined) return optional
  if (typeof value !== 'object' || value === null) return false
  const md = value as Record<string, unknown>
  return (
    typeof md.month === 'number' &&
    isFinite(md.month) &&
    typeof md.day === 'number' &&
    isFinite(md.day)
  )
}

function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s))
}
