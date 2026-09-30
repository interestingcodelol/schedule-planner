import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearIdbState,
  hasV2MigrationInIdb,
  loadLegacyStateFromIdb,
  loadStateFromIdb,
  saveStateToIdb,
} from '../indexedDb'
import type { AppState } from '../types'

const records = new Map<string, unknown>()
function request<T>(result: T) {
  const req = { result, onsuccess: null as (() => void) | null, onerror: null }
  queueMicrotask(() => req.onsuccess?.())
  return req
}

// Record-level IndexedDB stand-in: exercise the real wrapper's key/marker
// routing without depending on a browser's disk-backed database in jsdom.
beforeEach(() => {
  records.clear()
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => request({
      objectStoreNames: { contains: () => true },
      transaction: () => {
        const tx = {
          oncomplete: null as (() => void) | null,
          onerror: null,
          objectStore: () => ({
            get: (key: string) => request(records.get(key)),
            put: (value: unknown, key: string) => records.set(key, value),
            delete: (key: string) => records.delete(key),
          }),
        }
        queueMicrotask(() => tx.oncomplete?.())
        return tx
      },
    })),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('IndexedDB schema isolation', () => {
  it('reads and writes v2 independently of the old app-state record', async () => {
    const old = { version: 1 } as AppState
    const current = { version: 2 } as AppState
    records.set('app-state', old)
    expect(await loadStateFromIdb()).toBeNull()
    expect(await loadLegacyStateFromIdb()).toEqual(old)
    expect(await hasV2MigrationInIdb()).toBe(false)
    await saveStateToIdb(current)
    expect(await loadStateFromIdb()).toEqual(current)
    expect(await loadLegacyStateFromIdb()).toEqual(old)
    expect(await hasV2MigrationInIdb()).toBe(true)
    // No database version upgrade that could be blocked by an old open tab.
    expect(indexedDB.open).toHaveBeenCalledWith('schedule-planner', 1)
  })

  it('reset clears both snapshots and retains a migration marker', async () => {
    records.set('app-state', { version: 1 })
    records.set('app-state-v2', { version: 2 })
    await clearIdbState()
    expect(await loadStateFromIdb()).toBeNull()
    expect(await loadLegacyStateFromIdb()).toBeNull()
    expect(await hasV2MigrationInIdb()).toBe(true)
    records.set('app-state', { version: 1 }) // stale tab writes after reset
    expect(await hasV2MigrationInIdb()).toBe(true)
  })
})
