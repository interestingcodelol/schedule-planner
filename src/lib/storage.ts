import type { AppState } from './types'
import { loadStateFromIdb, saveStateToIdb, clearIdbState } from './indexedDb'
import { showToast } from './toastBus'

const STORAGE_KEY = 'schedule-planner-state-v1'
const LEGACY_STORAGE_KEY = 'leave-lens-state-v1'
const CURRENT_VERSION = 1

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
  try {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        raw = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (raw) {
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    warnStorageFailure(isQuota ? 'quota' : 'unavailable')
  }
  saveStateToIdb(state).catch(() => {})
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY)
  clearIdbState().catch(() => {})
}

/** Tries IndexedDB first, then falls back to localStorage. */
export async function loadStateAsync(): Promise<AppState | null> {
  const idbState = await loadStateFromIdb()
  if (idbState && isPlausibleAppState(idbState)) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(idbState))
    } catch {
      // localStorage may be full or unavailable — IndexedDB is still authoritative.
    }
    return idbState
  }
  return loadState()
}

/** Cheap structural check used both on load and after IDB hydration. Catches
 *  corrupted/truncated state before it reaches the rest of the app. */
function isPlausibleAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.version !== CURRENT_VERSION) return false
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

export function exportState(state: AppState): void {
  const dateStr = new Date().toISOString().slice(0, 10)
  const filename = `schedule-planner-backup-${dateStr}.json`
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function validateImportedState(data: unknown): data is AppState {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>

  if (typeof obj.version !== 'number') return false
  if (typeof obj.theme !== 'string') return false
  if (!Array.isArray(obj.plannedVacations)) return false

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
  if (!Array.isArray(policy.workDaysPerWeek) || policy.workDaysPerWeek.length === 0) return false
  if (typeof policy.payPeriodLengthDays !== 'number' || policy.payPeriodLengthDays <= 0) return false
  if (typeof policy.hoursPerWorkDay !== 'number' || policy.hoursPerWorkDay <= 0) return false

  return true
}

function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s))
}
