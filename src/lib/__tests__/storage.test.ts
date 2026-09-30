import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppState } from '../types'
import { defaultPolicy } from '../defaultPolicy'

// In-memory stand-in for the IndexedDB layer so we can drive both stores
// independently and assert the timestamp arbitration in loadStateAsync.
let idbValue: AppState | null = null
let legacyIdbValue: AppState | null = null
let idbMigrated = false
let idbReadError = false
let legacyIdbReadError = false
const idbRecoveryValues: unknown[] = []
vi.mock('../indexedDb', () => ({
  loadStateFromIdb: vi.fn(async () => {
    if (idbReadError) throw new Error('IDB unavailable')
    return idbValue
  }),
  loadLegacyStateFromIdb: vi.fn(async () => {
    if (legacyIdbReadError) throw new Error('Legacy IDB unavailable')
    return legacyIdbValue
  }),
  preserveStateForRecoveryInIdb: vi.fn(async (state: unknown) => { idbRecoveryValues.push(state) }),
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
import { saveState, loadState, loadStateAsync, clearState, subscribeToCrossTabUpdates, CURRENT_VERSION, StorageRecoveryError } from '../storage'
import { hasV2MigrationInIdb, preserveStateForRecoveryInIdb, saveStateToIdb } from '../indexedDb'

const STORAGE_KEY = 'schedule-planner-state-v2'
const LEGACY_KEY = 'schedule-planner-state-v1'

beforeEach(() => {
  localStorage.clear()
  idbValue = null
  legacyIdbValue = null
  idbMigrated = false
  idbReadError = false
  legacyIdbReadError = false
  idbRecoveryValues.length = 0
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

  it('uses increasing timestamps for separate saves in the same millisecond or after a clock rewind', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5000)
    saveState(makeState())
    const first = loadState()!.savedAt!
    saveState(makeState())
    expect(loadState()!.savedAt).toBe(first + 1)
    now.mockReturnValue(4000)
    saveState(makeState())
    expect(loadState()!.savedAt).toBe(first + 2)
    now.mockRestore()
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

  it.each([
    ['missing profile fields', { profile: {} }],
    ['missing policy fields', { policy: {} }],
    ['null vacation entry', { plannedVacations: [null] }],
    ['malformed bank log', { bankHoursLog: {} }],
    ['malformed history', { catchUpHistory: {} }],
  ])('rejects %s before hydration or cross-tab delivery', (_label, malformed) => {
    const broken = { ...makeState(200), ...malformed }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(broken))
    expect(loadState()).toBeNull()
    const received = vi.fn()
    const unsubscribe = subscribeToCrossTabUpdates(received)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(broken) }))
    unsubscribe()
    expect(received).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(broken)
  })

  it('does not let a newer malformed IDB record overwrite a valid local fallback', async () => {
    putLocal(100, 42)
    idbValue = { ...makeState(200), plannedVacations: [null] } as unknown as AppState
    const broken = idbValue
    const result = await loadStateAsync()
    expect(result?.profile.currentVacationHours).toBe(42)
    expect(result?.plannedVacations).toEqual([])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).profile.currentVacationHours).toBe(42)
    expect(idbRecoveryValues).toEqual([broken])
  })

  it('migrates a valid legacy fallback when the newer legacy record has broken nested data', async () => {
    const valid = { ...makeState(100), version: 1 }
    const broken = { ...makeState(200), version: 1, policy: {} } as unknown as AppState
    localStorage.setItem(LEGACY_KEY, JSON.stringify(broken))
    legacyIdbValue = valid
    expect(await loadStateAsync()).toEqual({ ...valid, version: CURRENT_VERSION })
    expect(localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify(broken))
    expect(legacyIdbValue).toEqual(valid)
  })

  it('continues to accept compatible legacy snapshots with additive fields omitted', async () => {
    const legacy = makeState(100)
    legacy.version = 1
    const profile = legacy.profile as Partial<AppState['profile']>
    const policy = legacy.policy as Partial<AppState['policy']>
    delete profile.currentBankHours
    delete profile.lastSyncDate
    delete profile.timezone
    delete policy.carryoverPayoutDate
    delete policy.bankHoursPayoutStart
    delete policy.bankHoursPayoutEnd
    delete policy.sickLeaveAnnualGrant
    delete policy.sickLeaveMaxBalance
    delete policy.sickLeaveCarryoverCap
    delete (legacy as Partial<AppState>).bankHoursLog
    delete (legacy as Partial<AppState>).showTour
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy))
    expect(await loadStateAsync()).toEqual({ ...legacy, version: CURRENT_VERSION })
    expect(localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify(legacy))
  })

  it('keeps exact malformed local bytes in a recovery copy before using valid IDB', async () => {
    const broken = '{broken original bytes'
    localStorage.setItem(STORAGE_KEY, broken)
    putIdb(100, 42)
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(42)
    const recoveryKey = Object.keys(localStorage).find((key) => key.startsWith(`${STORAGE_KEY}-recovery-`))
    expect(recoveryKey).toBeDefined()
    expect(localStorage.getItem(recoveryKey!)).toBe(broken)
  })

  it('leaves malformed local bytes untouched if no recovery copy can be saved', async () => {
    localStorage.setItem(STORAGE_KEY, '{broken')
    putIdb(100, 42)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken')
    setItem.mockRestore()
  })

  it('never repairs over a future-version snapshot even when an older compatible fallback exists', async () => {
    putLocal(100, 42)
    idbValue = { ...makeState(200), version: 3 }
    const future = idbValue
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(idbValue).toBe(future)
    expect(loadState()?.profile.currentVacationHours).toBe(42)
    expect(idbRecoveryValues).toEqual([])
  })

  it('blocks setup for an unreadable sole legacy record without promoting or erasing it', async () => {
    const broken = JSON.stringify({ version: 1, profile: {}, policy: {}, plannedVacations: [] })
    localStorage.setItem(LEGACY_KEY, broken)
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(LEGACY_KEY)).toBe(broken)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('schedule-planner-v2-initialized')).toBeNull()
    expect(idbMigrated).toBe(false)
  })
})

describe('unavailable stores do not count as empty stores', () => {
  it.each(['current', 'legacy'])('defers migration when the %s IndexedDB read fails, then recovers the newest snapshot', async (store) => {
    const localLegacy = { ...makeState(100), version: 1 }
    localLegacy.profile.currentVacationHours = 10
    localStorage.setItem(LEGACY_KEY, JSON.stringify(localLegacy))
    legacyIdbValue = { ...makeState(200), version: 1 }
    legacyIdbValue.profile.currentVacationHours = 20
    idbReadError = store === 'current'
    legacyIdbReadError = store === 'legacy'
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('schedule-planner-v2-initialized')).toBeNull()
    expect(idbMigrated).toBe(false)
    expect(localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify(localLegacy))
    idbReadError = legacyIdbReadError = false
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(20)
  })

  it('does not promote from IDB when localStorage cannot be checked', async () => {
    legacyIdbValue = { ...makeState(200), version: 1 }
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(idbValue).toBeNull()
    expect(idbMigrated).toBe(false)
    getItem.mockRestore()
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

  it('re-arbitrates when another tab saves while an unreadable IDB copy is being preserved', async () => {
    putLocal(100, 10)
    idbValue = { ...makeState(200), policy: {} } as AppState
    vi.mocked(preserveStateForRecoveryInIdb).mockImplementationOnce(async (state) => {
      idbRecoveryValues.push(state)
      putLocal(300, 30)
    })
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(30)
    expect(loadState()?.profile.currentVacationHours).toBe(30)
    expect(idbValue?.profile.currentVacationHours).toBe(30)
  })

  it('re-arbitrates when another tab saves during mirror repair', async () => {
    putLocal(200, 20)
    putIdb(100, 10)
    vi.mocked(saveStateToIdb).mockImplementationOnce(async (state) => {
      idbValue = state
      idbMigrated = true
      putLocal(300, 30)
    })
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(30)
    expect(loadState()?.profile.currentVacationHours).toBe(30)
    expect(idbValue?.profile.currentVacationHours).toBe(30)
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

  it('rechecks local v2 after the final asynchronous migration-marker read', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy(100, 10)))
    vi.mocked(hasV2MigrationInIdb)
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        putLocal(300, 30)
        return false
      })
    expect((await loadStateAsync())?.profile.currentVacationHours).toBe(30)
    expect(loadState()?.profile.currentVacationHours).toBe(30)
    expect(idbValue?.profile.currentVacationHours).toBe(30)
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

  it.each([100, 200])('ignores a differing queued event at timestamp %s after a newer local save', (savedAt) => {
    putLocal(200, 42)
    const received = vi.fn()
    const unsubscribe = subscribeToCrossTabUpdates(received)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(makeState(savedAt)) }))
    unsubscribe()
    expect(received).not.toHaveBeenCalled()
    expect(loadState()?.profile.currentVacationHours).toBe(42)
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
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken')
  })
})
