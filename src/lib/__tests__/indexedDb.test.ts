import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearIdbState,
  hasV2MigrationInIdb,
  loadLegacyStateFromIdb,
  loadStateFromIdb,
  preserveStateForRecoveryInIdb,
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
      close: vi.fn(),
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

  it('retains separate exact recovery values without overwriting the active or earlier recovery record', async () => {
    const broken = { version: 2, plannedVacations: [null], preserved: 'first' }
    const another = { version: 2, preserved: 'second' }
    records.set('app-state-v2', broken)
    await preserveStateForRecoveryInIdb(broken)
    await preserveStateForRecoveryInIdb(another)
    expect(records.get('app-state-v2')).toEqual(broken)
    expect([...records.entries()].filter(([key]) => key.startsWith('app-state-v2-recovery-')).map(([, value]) => value)).toEqual([broken, another])
  })

  it('rejects unavailable database reads instead of reporting a missing record', async () => {
    const error = new DOMException('Database unavailable', 'UnknownError')
    vi.stubGlobal('indexedDB', { open: () => {
      const req = { error, onerror: null as (() => void) | null }
      queueMicrotask(() => req.onerror?.())
      return req
    } })
    await expect(loadStateFromIdb()).rejects.toBe(error)
    await expect(loadLegacyStateFromIdb()).rejects.toBe(error)
    await expect(hasV2MigrationInIdb()).rejects.toBe(error)
  })

  it('rejects a failed record request instead of reporting a missing record', async () => {
    const error = new DOMException('Read interrupted', 'UnknownError')
    vi.stubGlobal('indexedDB', { open: () => request({
      close: vi.fn(),
      transaction: () => ({ objectStore: () => ({ get: () => {
        const req = { error, onerror: null as (() => void) | null }
        queueMicrotask(() => req.onerror?.())
        return req
      } }) }),
    }) })
    await expect(loadLegacyStateFromIdb()).rejects.toBe(error)
  })
})
