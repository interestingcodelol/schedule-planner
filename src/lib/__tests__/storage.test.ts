import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppState } from '../types'
import { defaultPolicy } from '../defaultPolicy'

// In-memory stand-in for the IndexedDB layer so we can drive both stores
// independently and assert the timestamp arbitration in loadStateAsync.
let idbValue: AppState | null = null
vi.mock('../indexedDb', () => ({
  loadStateFromIdb: vi.fn(async () => idbValue),
  saveStateToIdb: vi.fn(async (state: AppState) => {
    idbValue = state
  }),
  clearIdbState: vi.fn(async () => {
    idbValue = null
  }),
}))

// Imported after the mock is registered.
import { saveState, loadState, loadStateAsync } from '../storage'

const STORAGE_KEY = 'schedule-planner-state-v1'

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
    version: 1,
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
