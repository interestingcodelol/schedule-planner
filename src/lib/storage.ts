import type { AppState } from './types'
import { loadStateFromIdb, loadLegacyStateFromIdb, hasV2MigrationInIdb, saveStateToIdb, clearIdbState } from './indexedDb'
import { showToast } from './toastBus'

const STORAGE_KEY = 'schedule-planner-state-v2'
const LEGACY_STORAGE_KEYS = ['schedule-planner-state-v1', 'leave-lens-state-v1']
const MIGRATION_KEY = 'schedule-planner-v2-initialized'
const LAST_EXPORT_KEY = 'schedule-planner-last-export'
/** Current schema version. Imported by migrate.ts (the single owner of the
 *  upgrade logic) so the constant lives in one place. */
export const CURRENT_VERSION = 2
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

/** Synchronous hydration reads only the isolated v2 store. Legacy migration
 * must wait for IndexedDB so the freshest v1 snapshot wins before promotion. */
export function loadState(): AppState | null {
  return parseStoredState(readLocal(STORAGE_KEY))
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    warnStorageFailure('unavailable')
    return null
  }
}

function parseStoredState(raw: string | null): AppState | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlausibleAppState(parsed) ? parsed : null
  } catch {
    setTimeout(() => showToast({
      message: 'Saved data was corrupted and could not be loaded.',
      duration: 8000,
    }), 0)
    return null
  }
}

function writeLocalSnapshot(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    // Mark only after the snapshot succeeds. A failed migration must not hide
    // the sole remaining legacy copy.
    localStorage.setItem(MIGRATION_KEY, 'true')
  } catch (err) {
    const isQuota = err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    warnStorageFailure(isQuota ? 'quota' : 'unavailable')
  }
}

function newest(states: (AppState | null)[]): AppState | null {
  return states.reduce<AppState | null>((winner, state) => {
    if (!state) return winner
    const time = typeof state.savedAt === 'number' ? state.savedAt : 0
    const winnerTime = typeof winner?.savedAt === 'number' ? winner.savedAt : 0
    return !winner || time > winnerTime ? state : winner
  }, null)
}

export function saveState(state: AppState): void {
  // The current code owns the v2 ledger semantics, even when setup or import
  // supplied a legacy version number. Never write to either legacy store.
  const stamped: AppState = { ...state, version: CURRENT_VERSION, savedAt: Date.now() }
  writeLocalSnapshot(stamped)
  saveStateToIdb(stamped).catch(() => {})
}

export function clearState(): void {
  try {
    localStorage.setItem(MIGRATION_KEY, 'true')
    localStorage.removeItem(STORAGE_KEY)
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key)
  } catch {
    warnStorageFailure('unavailable')
  }
  // A persistent IDB marker also prevents resurrection if localStorage is
  // evicted or an old open tab writes another v1 snapshot after this reset.
  clearIdbState().catch(() => {})
}

/** V2 stores arbitrate only with each other. V1 data is considered exactly
 * once, only while neither v2 store nor migration/reset marker exists. A stale
 * pre-ledger tab can keep writing v1 without overwriting or re-importing v2. */
export async function loadStateAsync(): Promise<AppState | null> {
  const idbRaw = await loadStateFromIdb()
  const localRaw = readLocal(STORAGE_KEY)
  const localState = parseStoredState(localRaw)
  const idbState = idbRaw && isPlausibleAppState(idbRaw) ? idbRaw : null
  const current = newest([localState, idbState])
  if (current) {
    if (current !== localState) writeLocalSnapshot(current)
    if (!idbState || current !== idbState &&
      (current.savedAt ?? 0) > (idbState.savedAt ?? 0)) {
      await saveStateToIdb(current)
    }
    return current
  }
  // Even an unreadable/unsupported v2 record must not silently restore v1.
  if (localRaw !== null || idbRaw !== null || readLocal(MIGRATION_KEY) !== null ||
      await hasV2MigrationInIdb()) return null

  const legacyIdbRaw = await loadLegacyStateFromIdb()
  const legacyIdb = legacyIdbRaw && isPlausibleAppState(legacyIdbRaw) ? legacyIdbRaw : null
  const legacy = newest([
    ...LEGACY_STORAGE_KEYS.map((key) => parseStoredState(readLocal(key))),
    legacyIdb,
  ])
  if (!legacy) return null

  // Another tab may have initialized v2 while the legacy IDB read was pending.
  if (readLocal(STORAGE_KEY) !== null || readLocal(MIGRATION_KEY) !== null ||
      await hasV2MigrationInIdb()) return loadStateAsync()
  const promoted = { ...legacy, version: CURRENT_VERSION }
  writeLocalSnapshot(promoted)
  await saveStateToIdb(promoted)
  return promoted
}

/** Cheap structural check used both on load and after IDB hydration. Catches
 *  corrupted/truncated state before it reaches the rest of the app. */
function isPlausibleAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  // Daily booked balances are semantically incompatible with old builds.
  // Storage namespaces isolate those builds; reject unknown future schemas.
  if (typeof v.version !== 'number' || !Number.isInteger(v.version) ||
      v.version < 1 || v.version > CURRENT_VERSION) return false
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

/** Wrap v2 data so pre-ledger importers reject it rather than double-debiting
 * active trips. The new importer continues to accept legacy root snapshots. */
export function buildBackupJson(state: AppState): string {
  const appVersion =
    typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown'
  const envelope = {
    _backupType: BACKUP_TYPE,
    _schemaVersion: CURRENT_VERSION,
    state: { ...state, version: CURRENT_VERSION },
    _exportedAt: new Date().toISOString(),
    _appVersion: appVersion,
    _note: 'Restore this backup in Schedule Planner v2 or later. Older builds cannot interpret daily booked balances safely.',
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

  const envelope = parsed as Record<string, unknown>
  let payload = envelope
  if ('state' in envelope) {
    if (envelope._backupType !== BACKUP_TYPE || envelope._schemaVersion !== CURRENT_VERSION ||
        !envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state)) {
      return { ok: false, error: 'This backup uses an unsupported or invalid format. Update Schedule Planner before importing it.' }
    }
    payload = envelope.state as Record<string, unknown>
    if (payload.version !== CURRENT_VERSION) {
      return { ok: false, error: 'The backup schema version does not match its contents.' }
    }
  }
  // Legacy root envelopes carry `_` metadata beside the AppState fields.
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
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

  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1 || obj.version > CURRENT_VERSION) return false
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
    if (pv.endDate < pv.startDate) return false
    for (const key of ['hoursPerDay', 'actualHoursUsed']) {
      if (pv[key] !== undefined && !isNonnegativeFinite(pv[key])) return false
    }
    if (pv.kind !== undefined && pv.kind !== 'planned' && pv.kind !== 'logged_past') return false
    if (pv.debitedFrom !== undefined && !isPoolBreakdown(pv.debitedFrom)) return false
    if (pv.appliedDeductions !== undefined) {
      if (!Array.isArray(pv.appliedDeductions)) return false
      const dates = new Set<string>()
      for (const row of pv.appliedDeductions) {
        if (!row || typeof row !== 'object') return false
        const d = row as Record<string, unknown>
        if (typeof d.date !== 'string' || !isValidIsoDate(d.date) || d.date < pv.startDate || d.date > pv.endDate || dates.has(d.date)) return false
        if (!isNonnegativeFinite(d.hours) || !isPoolBreakdown(d.drawn)) return false
        const drawn = d.drawn as { vacation: number; sick: number; bank: number }
        if (drawn.vacation + drawn.sick + drawn.bank > (d.hours as number) + 0.02) return false
        dates.add(d.date)
      }
    }
    if (
      pv.hourSource !== undefined &&
      !['vacation', 'sick', 'bank', 'any'].includes(pv.hourSource as string)
    ) {
      return false
    }
  }

  // bankHoursLog is optional in older exports, but if present must be an array.
  if (obj.bankHoursLog !== undefined && !Array.isArray(obj.bankHoursLog)) return false
  for (const entry of (obj.bankHoursLog ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') return false
    const bank = entry as Record<string, unknown>
    if (typeof bank.id !== 'string' || typeof bank.date !== 'string' || !isValidIsoDate(bank.date)) return false
    if (typeof bank.hours !== 'number' || !Number.isFinite(bank.hours)) return false
    if (bank.appliedToBalance !== undefined && typeof bank.appliedToBalance !== 'boolean') return false
  }

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
  if (typeof policy.payPeriodLengthDays !== 'number' || !Number.isInteger(policy.payPeriodLengthDays) || policy.payPeriodLengthDays <= 0) return false
  if (typeof policy.hoursPerWorkDay !== 'number' || !Number.isFinite(policy.hoursPerWorkDay) || policy.hoursPerWorkDay <= 0 || policy.hoursPerWorkDay > 24) return false

  for (const key of ['sickLeaveAnnualGrant', 'sickLeaveMaxBalance', 'sickLeaveCarryoverCap', 'carryoverFixedCap']) {
    if (policy[key] !== undefined && !isNonnegativeFinite(policy[key])) return false
  }
  if (!['annual_accrual', 'fixed_hours', 'unlimited'].includes(policy.carryoverCapStrategy as string)) return false
  if (!Array.isArray(policy.holidays)) return false
  for (const rule of policy.holidays) {
    if (!rule || typeof rule !== 'object') return false
    const h = rule as Record<string, unknown>
    if (typeof h.name !== 'string' || !Number.isInteger(h.month) || (h.month as number) < 1 || (h.month as number) > 12) return false
    if (h.weekendObservance !== 'none' && h.weekendObservance !== 'nearest_weekday') return false
    if (h.startYear !== undefined && (!Number.isInteger(h.startYear) || (h.startYear as number) < 1)) return false
    if (h.type === 'fixed') {
      if (!isValidMonthDay(h, false)) return false
    } else if (h.type === 'nth_weekday' || h.type === 'last_weekday') {
      if (!Number.isInteger(h.weekday) || (h.weekday as number) < 0 || (h.weekday as number) > 6) return false
      if (h.type === 'nth_weekday' && (!Number.isInteger(h.n) || (h.n as number) < 1 || (h.n as number) > 5)) return false
    } else return false
  }


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
    Number.isInteger(md.month) && md.month >= 1 && md.month <= 12 &&
    typeof md.day === 'number' &&
    Number.isInteger(md.day) && md.day >= 1 && md.day <= 31
  )
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const date = new Date(`${s}T00:00:00Z`)
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPoolBreakdown(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const pools = value as Record<string, unknown>
  return ['vacation', 'sick', 'bank'].every((key) => isNonnegativeFinite(pools[key]))
}
