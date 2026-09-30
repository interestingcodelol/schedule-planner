import type { AppState } from './types'
import { loadStateFromIdb, loadLegacyStateFromIdb, hasV2MigrationInIdb, preserveStateForRecoveryInIdb, saveStateToIdb, clearIdbState } from './indexedDb'
import { showToast } from './toastBus'

const STORAGE_KEY = 'schedule-planner-state-v2'
const LEGACY_STORAGE_KEYS = ['schedule-planner-state-v1', 'leave-lens-state-v1']
const MIGRATION_KEY = 'schedule-planner-v2-initialized'
const LAST_EXPORT_KEY = 'schedule-planner-last-export'
/** Current schema version. Imported by migrate.ts (the single owner of the
 *  upgrade logic) so the constant lives in one place. */
export const CURRENT_VERSION = 2
const BACKUP_TYPE = 'schedule-planner-backup'

/** The browser may still contain data, so setup must not overwrite it. A retry
 * can recover from transient storage errors without committing a migration. */
export class StorageRecoveryError extends Error {
  constructor(message = 'Saved data could not be safely loaded. Retry before making changes.') {
    super(message)
    this.name = 'StorageRecoveryError'
  }
}

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

function readLocalForHydration(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    throw new StorageRecoveryError('Browser storage is unavailable. Restore storage access, then retry loading your data.')
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
  const current = parseStoredState(readLocal(STORAGE_KEY))
  const savedAt = Math.max(Date.now(), (current?.savedAt ?? 0) + 1)
  const stamped: AppState = { ...state, version: CURRENT_VERSION, savedAt }
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
  try {
    return await loadStateForHydration()
  } catch (error) {
    if (error instanceof StorageRecoveryError) throw error
    throw new StorageRecoveryError('The browser database could not be read. Close other Schedule Planner tabs, then retry loading your data.')
  }
}

async function loadStateForHydration(): Promise<AppState | null> {
  const idbRaw = await loadStateFromIdb()
  const localRaw = readLocalForHydration(STORAGE_KEY)
  // A newer app's schema is not a damaged copy to repair from an older one.
  // Preserve both stores until compatible code can interpret that snapshot.
  if (hasUnsupportedVersion(idbRaw) || hasUnsupportedStoredVersion(localRaw)) {
    throw new StorageRecoveryError('Saved data was created by a newer Schedule Planner version. Update the app before loading it.')
  }
  const localState = parseStoredState(localRaw)
  const idbState = idbRaw && isPlausibleAppState(idbRaw) ? idbRaw : null
  const current = newest([localState, idbState])
  if (current) {
    if (localRaw !== null && !localState) preserveLocalForRecovery(localRaw)
    if (idbRaw !== null && !idbState) {
      await preserveStateForRecoveryInIdb(idbRaw)
      if (readLocalForHydration(STORAGE_KEY) !== localRaw) return loadStateAsync()
    }
    if (current !== localState) writeLocalSnapshot(current)
    const selectedLocalRaw = readLocalForHydration(STORAGE_KEY)
    if (!idbState || current !== idbState &&
      (current.savedAt ?? 0) > (idbState.savedAt ?? 0)) {
      await saveStateToIdb(current)
      if (readLocalForHydration(STORAGE_KEY) !== selectedLocalRaw) return loadStateAsync()
    }
    return current
  }
  // Even an unreadable/unsupported v2 record must not silently restore v1.
  if (localRaw !== null || idbRaw !== null) {
    throw new StorageRecoveryError('Saved data could not be read safely. Your stored copies have been kept for recovery.')
  }
  if (readLocalForHydration(MIGRATION_KEY) !== null || await hasV2MigrationInIdb()) return null

  const legacyIdbRaw = await loadLegacyStateFromIdb()
  const legacyLocalRaw = LEGACY_STORAGE_KEYS.map(readLocalForHydration)
  const legacyIdb = legacyIdbRaw && isPlausibleAppState(legacyIdbRaw) ? legacyIdbRaw : null
  const legacy = newest([
    ...legacyLocalRaw.map(parseStoredState),
    legacyIdb,
  ])
  if (!legacy) {
    if (legacyIdbRaw !== null || legacyLocalRaw.some((raw) => raw !== null)) {
      throw new StorageRecoveryError('Existing saved data could not be read safely. Your original data has been kept for recovery.')
    }
    return null
  }

  // Another tab may have initialized v2 while the legacy IDB read was pending.
  const migratedWhileReading = await hasV2MigrationInIdb()
  if (migratedWhileReading || readLocalForHydration(STORAGE_KEY) !== null ||
      readLocalForHydration(MIGRATION_KEY) !== null ||
      LEGACY_STORAGE_KEYS.some((key, index) => readLocalForHydration(key) !== legacyLocalRaw[index])) return loadStateAsync()
  const promoted = { ...legacy, version: CURRENT_VERSION }
  writeLocalSnapshot(promoted)
  const promotedLocalRaw = readLocalForHydration(STORAGE_KEY)
  await saveStateToIdb(promoted)
  if (readLocalForHydration(STORAGE_KEY) !== promotedLocalRaw) return loadStateAsync()
  return promoted
}

function hasUnsupportedVersion(value: unknown): boolean {
  return !!value && typeof value === 'object' &&
    typeof (value as { version?: unknown }).version === 'number' &&
    (value as { version: number }).version > CURRENT_VERSION
}

function hasUnsupportedStoredVersion(raw: string | null): boolean {
  if (!raw) return false
  try {
    return hasUnsupportedVersion(JSON.parse(raw))
  } catch {
    return false
  }
}

function preserveLocalForRecovery(raw: string): void {
  try {
    const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    localStorage.setItem(`${STORAGE_KEY}-recovery-${Date.now()}-${suffix}`, raw)
  } catch {
    throw new StorageRecoveryError('An unreadable saved copy could not be preserved. Free browser storage, then retry; your original data is unchanged.')
  }
}

/** Validate before arbitration as well as hydration. A shallow shape check can
 * promote a newer broken record over the only usable copy in the other store.
 * The import validator allows fields introduced by additive migrations to be
 * missing, while checking every present record consumed by the app. */
function isPlausibleAppState(value: unknown): value is AppState {
  return validateImportedState(value)
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
      if (!isPlausibleAppState(parsed)) return
      // Storage events are queued; a newer local write (or reset) may already
      // exist by delivery time. Never let that stale event rewind this tab.
      const localRaw = readLocal(STORAGE_KEY)
      const localState = parseStoredState(localRaw)
      if (localState && (parsed.savedAt ?? 0) <= (localState.savedAt ?? 0) &&
          JSON.stringify(parsed) !== JSON.stringify(localState)) return
      if (localRaw === null && readLocal(MIGRATION_KEY) !== null) return
      onUpdate(parsed)
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
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const obj = data as Record<string, unknown>

  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1 || obj.version > CURRENT_VERSION) return false
  // theme, when present, must be exactly 'light' or 'dark'. Older exports may
  // omit it (migration doesn't backfill theme, so require it here as before),
  // but a garbage value must be rejected rather than imported and crashing.
  if (obj.theme !== 'light' && obj.theme !== 'dark') return false
  if (obj.showTour !== undefined && typeof obj.showTour !== 'boolean') return false
  if (obj.savedAt !== undefined && !isNonnegativeFinite(obj.savedAt)) return false
  if (!Array.isArray(obj.plannedVacations)) return false

  // Each planned vacation must be a well-formed object so the rest of the app
  // (projection, catch-up, calendar) doesn't crash on a malformed entry.
  for (const v of obj.plannedVacations) {
    if (typeof v !== 'object' || v === null) return false
    const pv = v as Record<string, unknown>
    if (typeof pv.id !== 'string') return false
    for (const key of ['note', 'customEmoji', 'timeOffStart', 'timeOffEnd']) {
      if (pv[key] !== undefined && typeof pv[key] !== 'string') return false
    }
    if (pv.locked !== undefined && typeof pv.locked !== 'boolean') return false
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
    if (bank.note !== undefined && typeof bank.note !== 'string') return false
    if (bank.appliedToBalance !== undefined && typeof bank.appliedToBalance !== 'boolean') return false
  }

  // History is optional in older snapshots, but malformed rows would crash
  // reconciliation or the history UI after the snapshot had been promoted.
  if (obj.catchUpHistory !== undefined && !Array.isArray(obj.catchUpHistory)) return false
  for (const entry of (obj.catchUpHistory ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') return false
    const history = entry as Record<string, unknown>
    if (typeof history.ranOn !== 'string' || !isValidIsoDate(history.ranOn) ||
        typeof history.syncedTo !== 'string' || !isValidIsoDate(history.syncedTo) ||
        typeof history.summary !== 'string' || !Array.isArray(history.events)) return false
    for (const event of history.events) {
      if (!event || typeof event !== 'object') return false
      const row = event as Record<string, unknown>
      if (typeof row.date !== 'string' || !isValidIsoDate(row.date) ||
          typeof row.type !== 'string' || typeof row.label !== 'string' ||
          !['vacation', 'sick', 'bank'].includes(row.pool as string) ||
          typeof row.delta !== 'number' || !Number.isFinite(row.delta)) return false
    }
  }

  const profile = obj.profile as Record<string, unknown> | undefined
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false
  if (typeof profile.displayName !== 'string') return false
  if (profile.timezone !== undefined && typeof profile.timezone !== 'string') return false
  if (profile.lastExportDate !== undefined && typeof profile.lastExportDate !== 'string') return false
  if (profile.backupRemindersDisabled !== undefined && typeof profile.backupRemindersDisabled !== 'boolean') return false
  if (profile.backupReminderDays !== undefined && !isNonnegativeFinite(profile.backupReminderDays)) return false
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
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false
  if (policy.hideBankHours !== undefined && typeof policy.hideBankHours !== 'boolean') return false
  if (!Array.isArray(policy.accrualTiers) || policy.accrualTiers.length === 0) return false
  // Each accrual tier must have finite minYears/hoursPerPayPeriod and a
  // number|null maxYears, or computeAccrualTier produces NaN balances.
  for (const t of policy.accrualTiers) {
    if (typeof t !== 'object' || t === null) return false
    const tier = t as Record<string, unknown>
    if (tier.label !== undefined && typeof tier.label !== 'string') return false
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
