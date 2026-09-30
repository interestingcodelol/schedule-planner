import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppState } from '../types'
import { defaultPolicy } from '../defaultPolicy'

// In-memory stand-in for the IndexedDB layer so we can drive both stores
// independently and assert the timestamp arbitration in loadStateAsync.
let idbValue: AppState | null = null
let legacyIdbValue: AppState | null = null
let idbMigrated = false
vi.mock('../indexedDb', () => ({
  loadStateFromIdb: vi.fn(async () => idbValue),
  loadLegacyStateFromIdb: vi.fn(async () => legacyIdbValue),
  hasV2MigrationInIdb: vi.fn(async () => idbMigrated),
  saveStateToIdb: vi.fn(async (state: AppState) => {
    idbValue = state
    idbMigrated = true
  }),
  clearIdbState: vi.fn(async () => {
    idbValue = null
    legacyIdbValue = null
    idbMigrated = true
  }),
}))

// Imported after the mock is registered.
import { saveState, loadState, loadStateAsync, clearState, subscribeToCrossTabUpdates, CURRENT_VERSION } from '../storage'

const STORAGE_KEY = 'schedule-planner-state-v2'
const LEGACY_KEY = 'schedule-planner-state-v1'

beforeEach(() => {
  localStorage.clear()
  idbValue = null
  legacyIdbValue = null
  idbMigrated = false
})

function makeState(savedAt?: number): AppState {
  return {
    profile: {
      displayName: 'Test User',
      hireDate: '2023-01-01',
      currentVacationHours: 40,
      currentSickHours: 20,
      currentBankHours: 0,
      lastPaydayDate: '2025-12-12',
      lastSyncDate: '2025-12-12',
      timezone: 'America/New_York',
    },
    policy: { ...defaultPolicy },
    plannedVacations: [],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: CURRENT_VERSION,
    ...(savedAt !== undefined ? { savedAt } : {}),
  }
}

/** Write a state into localStorage directly with a chosen savedAt, bypassing
 *  saveState so each store can be stamped independently for the race tests. */
function putLocal(savedAt: number, marker: number): void {
  const s = makeState(savedAt)
  s.profile.currentVacationHours = marker
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

function putIdb(savedAt: number, marker: number): void {
  const s = makeState(savedAt)
  s.profile.currentVacationHours = marker
  idbValue = s
}

describe('storage savedAt stamping', () => {
  beforeEach(() => {
    localStorage.clear()
    idbValue = null
    vi.restoreAllMocks()
  })

  it('saveState stamps a savedAt on both stores without mutating the caller', () => {
    const original = makeState()
    expect(original.savedAt).toBeUndefined()

    const before = Date.now()
    saveState(original)
    const after = Date.now()

    // Caller's object is untouched (stamped a shallow copy).
    expect(original.savedAt).toBeUndefined()

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as AppState
    expect(persisted.savedAt).toBeGreaterThanOrEqual(before)
    expect(persisted.savedAt!).toBeLessThanOrEqual(after)
    // Same stamped object written to IDB.
    expect(idbValue?.savedAt).toBe(persisted.savedAt)
  })

  it('loadState ignores an extra savedAt field (still valid)', () => {
    putLocal(123, 7)
    const loaded = loadState()
    expect(loaded?.savedAt).toBe(123)
    expect(loaded?.profile.currentVacationHours).toBe(7)
  })
})

describe('schema safety', () => {
  beforeEach(() => {
    localStorage.clear()
    idbValue = null
  })

  it('rejects an unknown future schema without deleting the snapshot', () => {
    const s = makeState(123)
    // Simulate a future schema version written by a newer deployed build.
    ;(s as unknown as { version: number }).version = 3
    s.profile.currentVacationHours = 55
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    const loaded = loadState()
    expect(loaded).toBeNull()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).profile.currentVacationHours).toBe(55)
  })

  it('a structurally-broken snapshot is still rejected', () => {
    // version present but no policy / plannedVacations → not a usable AppState.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profile: {} }))
    expect(loadState()).toBeNull()
  })
})

describe('loadStateAsync arbitration', () => {
  beforeEach(() => {
    localStorage.clear()
    idbValue = null
  })

  it('fresh user (both empty) returns null', async () => {
    expect(await loadStateAsync()).toBeNull()
  })

  it('only IndexedDB present promotes IDB into localStorage', async () => {
    putIdb(500, 11)
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(11)
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as AppState
    expect(local.profile.currentVacationHours).toBe(11)
  })

  it('only localStorage present uses localStorage', async () => {
    putLocal(500, 22)
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(22)
  })

  it('newer localStorage is NOT clobbered by stale IDB (the bug)', async () => {
    putIdb(1000, 1) // stale
    putLocal(2000, 2) // newer
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(2)
    // localStorage must remain the newer value.
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as AppState
    expect(local.profile.currentVacationHours).toBe(2)
    // And IDB is resynced toward the winner.
    expect(idbValue?.profile.currentVacationHours).toBe(2)
  })

  it('newer IDB is promoted over older localStorage', async () => {
    putIdb(3000, 9) // newer
    putLocal(1000, 8) // older
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(9)
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as AppState
    expect(local.profile.currentVacationHours).toBe(9)
  })

  it('equal timestamps keep localStorage (no clobber)', async () => {
    putIdb(5000, 100)
    putLocal(5000, 200)
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(200)
  })

  it('missing savedAt is treated as oldest', async () => {
    putIdb(1, 33) // has a tiny timestamp -> newer than missing
    const noStamp = makeState() // savedAt undefined
    noStamp.profile.currentVacationHours = 44
    localStorage.setItem(STORAGE_KEY, JSON.stringify(noStamp))
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(33)
  })
})


describe('v2 migration and stale-tab isolation', () => {
  function legacy(savedAt: number, hours: number): AppState {
    const state = makeState(savedAt)
    state.version = 1
    state.profile.currentVacationHours = hours
    return state
  }

  it('defers synchronous legacy loading until both stores can be compared', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy(100, 10)))
    legacyIdbValue = legacy(200, 20)
    expect(loadState()).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    const loaded = await loadStateAsync()
    expect(loaded?.profile.currentVacationHours).toBe(20)
    expect(loaded?.version).toBe(2)
    expect(loaded?.savedAt).toBe(200)
    expect(idbValue).toEqual(loaded)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(loaded)
  })

  it('promotes the newest legacy local snapshot rather than stale legacy IDB', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy(300, 30)))
    localStorage.setItem('leave-lens-state-v1', JSON.stringify(legacy(50, 5)))
    legacyIdbValue = legacy(200, 20)
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(30)
    expect(idbValue?.version).toBe(2)
  })

  it('ignores newer v1 writes after either v2 store is established', async () => {
    putLocal(100, 10)
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy(900, 90)))
    legacyIdbValue = legacy(1000, 100)
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(10)
    localStorage.removeItem(STORAGE_KEY)
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(10)
  })

  it('never sends v2 writes to the legacy keys', () => {
    const old = JSON.stringify(legacy(100, 10))
    localStorage.setItem(LEGACY_KEY, old)
    legacyIdbValue = legacy(100, 10)
    saveState(makeState())
    expect(localStorage.getItem(LEGACY_KEY)).toBe(old)
    expect(legacyIdbValue.profile.currentVacationHours).toBe(10)
    expect(idbValue?.version).toBe(2)
  })

  it('only syncs storage events from v2 tabs', () => {
    const received = vi.fn()
    const unsubscribe = subscribeToCrossTabUpdates(received)
    window.dispatchEvent(new StorageEvent('storage', { key: LEGACY_KEY, newValue: JSON.stringify(legacy(100, 10)) }))
    expect(received).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(makeState()) }))
    expect(received).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('reset prevents resurrecting legacy data written by an old tab afterward', async () => {
    saveState(makeState())
    clearState()
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy(9999, 99)))
    legacyIdbValue = legacy(9999, 99)
    expect(await loadStateAsync()).toBeNull()
    // The independent IDB marker still protects a cleared/evicted local store.
    localStorage.clear()
    legacyIdbValue = legacy(9999, 99)
    expect(await loadStateAsync()).toBeNull()
  })

  it('does not fall back to legacy when the v2 record is corrupt', async () => {
    localStorage.setItem(STORAGE_KEY, '{broken')
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy(9999, 99)))
    expect(await loadStateAsync()).toBeNull()
  })
})
