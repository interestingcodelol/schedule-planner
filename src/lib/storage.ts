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

/** Async load: tries IndexedDB first (survives cache clears), then localStorage */
export async function loadStateAsync(): Promise<AppState | null> {
  // Try IndexedDB first
  const idbState = await loadStateFromIdb()
  if (idbState && idbState.version === CURRENT_VERSION && idbState.profile && idbState.policy) {
    // Ensure localStorage is also up to date
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(idbState))
    } catch {}
    return idbState
  }
  // Fall back to localStorage
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

  const profile = obj.profile as Record<string, unknown> | undefined
  if (!profile) return false
  if (typeof profile.hireDate !== 'string') return false
  if (typeof profile.currentVacationHours !== 'number') return false
  if (typeof profile.lastPaydayDate !== 'string') return false

  const policy = obj.policy as Record<string, unknown> | undefined
  if (!policy) return false
  if (!Array.isArray(policy.accrualTiers)) return false
  if (!Array.isArray(policy.workDaysPerWeek)) return false

  return true
}
