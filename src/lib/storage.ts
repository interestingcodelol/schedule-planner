import type { AppState } from './types'
import { loadStateFromIdb, saveStateToIdb, clearIdbState } from './indexedDb'

const STORAGE_KEY = 'schedule-planner-state-v1'
const LEGACY_STORAGE_KEY = 'leave-lens-state-v1'
const CURRENT_VERSION = 1

export function loadState(): AppState | null {
  try {
    let raw = localStorage.getItem(STORAGE_KEY)
    // Migrate from legacy key if new key not found
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY)
      if (raw) {
        // Migrate: write to new key and remove old
        localStorage.setItem(STORAGE_KEY, raw)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      }
    }
    if (!raw) return null

    const parsed = JSON.parse(raw) as AppState

    if (parsed.version !== CURRENT_VERSION) {
      // Schema version mismatch — caller should prompt user to reset
      return null
    }

    // Basic validation
    if (!parsed.profile || !parsed.policy || !Array.isArray(parsed.plannedVacations)) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage may be full or unavailable — silently fail
  }
  // Also persist to IndexedDB (fire and forget)
  saveStateToIdb(state).catch(() => {})
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY)
  clearIdbState().catch(() => {})
}

/** Tries IndexedDB first, then falls back to localStorage. */
export async function loadStateAsync(): Promise<AppState | null> {
  const idbState = await loadStateFromIdb()
  if (idbState && idbState.version === CURRENT_VERSION && idbState.profile && idbState.policy) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(idbState))
    } catch {
      // localStorage may be full or unavailable — IndexedDB is still authoritative.
    }
    return idbState
  }
  return loadState()
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
