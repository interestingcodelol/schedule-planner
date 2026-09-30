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
    let blocked = false
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('Browser database is blocked by another tab.'))
    }
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

/** Keep an unreadable snapshot before repairing its active record. A failed
 * recovery copy rejects so callers leave the original record untouched. */
export async function preserveStateForRecoveryInIdb(state: unknown): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
      tx.objectStore(STORE_NAME).put(state, `app-state-v2-recovery-${Date.now()}-${suffix}`)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Recovery copy could not be saved.'))
      tx.onabort = () => reject(tx.error ?? new Error('Recovery copy was interrupted.'))
    })
  } finally {
    db.close()
  }
}

async function readRecord<T>(key: string): Promise<T | null> {
  const db = await openDb()
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error ?? new Error('Browser database read failed.'))
      tx.onerror = () => reject(tx.error ?? new Error('Browser database read failed.'))
      tx.onabort = () => reject(tx.error ?? new Error('Browser database read was interrupted.'))
    })
  } finally {
    db.close()
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
      tx.onabort = () => resolve()
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
      tx.onabort = () => resolve()
    })
  } catch {
    // Silently fail
  }
}
