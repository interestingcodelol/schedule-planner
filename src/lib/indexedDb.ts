import type { AppState } from './types'

const DB_NAME = 'schedule-planner'
const STORE_NAME = 'state'
// Separate records prevent pre-ledger builds from reading or overwriting v2.
// Keep the database version unchanged so an older open tab cannot block us.
const STATE_KEY = 'app-state-v2'
const LEGACY_STATE_KEY = 'app-state'
const MIGRATION_KEY = 'schema-v2-initialized'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadStateFromIdb(): Promise<AppState | null> {
  return readRecord<AppState>(STATE_KEY)
}

export async function loadLegacyStateFromIdb(): Promise<AppState | null> {
  return readRecord<AppState>(LEGACY_STATE_KEY)
}

export async function hasV2MigrationInIdb(): Promise<boolean> {
  return (await readRecord<boolean>(MIGRATION_KEY)) === true
}

async function readRecord<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function saveStateToIdb(state: AppState): Promise<void> {
  try {
    const db = await openDb()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put(state, STATE_KEY)
      store.put(true, MIGRATION_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Silently fail — localStorage is the fallback
  }
}

export async function clearIdbState(): Promise<void> {
  try {
    const db = await openDb()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.delete(STATE_KEY)
      store.delete(LEGACY_STATE_KEY)
      store.put(true, MIGRATION_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Silently fail
  }
}
