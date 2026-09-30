import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'

let inaccessible = false
let recoveryValues: unknown[]=[]
let archiveFails=false
let idbCurrent: AppState | null = null
let idbLegacy: AppState | null = null
let idbMarker = false
vi.mock('../indexedDb', () => ({
  loadStateFromIdb: async () => inaccessible ? Promise.reject(new Error('Unavailable')) : idbCurrent,
  loadLegacyStateFromIdb: async () => inaccessible ? Promise.reject(new Error('Unavailable')) : idbLegacy,
  hasV2MigrationInIdb: async () => inaccessible ? Promise.reject(new Error('Unavailable')) : idbMarker,
  preserveStateForRecoveryInIdb:async(value:unknown)=>{if(archiveFails) throw new Error('QuotaExceeded'); recoveryValues.push(value)},
  saveStateToIdb: async (state: AppState) => { if (!inaccessible) { idbCurrent=state; idbMarker=true } },
  clearIdbState: async () => { if (!inaccessible) { idbCurrent=null; idbLegacy=null; idbMarker=true } },
}))
import { loadStateAsync, StorageRecoveryError } from '../storage'
const key='schedule-planner-state-v2'
function fixture(savedAt:number, note:string): AppState {
  return { version:1,savedAt,theme:'dark',showTour:false,
    profile:{displayName:'Fixture',hireDate:'2023-01-01',currentVacationHours:40,currentSickHours:8,currentBankHours:5,lastPaydayDate:'2026-09-25',lastSyncDate:'2026-09-30',timezone:'UTC'},
    policy:{...defaultPolicy}, bankHoursLog:[],
    plannedVacations:[{id:note,startDate:'2026-10-01',endDate:'2026-10-01',note,hourSource:'vacation',locked:false}],
  }
}
beforeEach(()=>{localStorage.clear();inaccessible=false;idbCurrent=null;idbLegacy=null;idbMarker=false;recoveryValues=[];archiveFails=false})
describe('independent preservation review',()=>{
  it('must reconsider a newer legacy IDB snapshot after an initial read failure',async()=>{
    localStorage.setItem('schedule-planner-state-v1',JSON.stringify(fixture(100,'old absence')))
    idbLegacy=fixture(200,'new absence')
    inaccessible=true
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(key)).toBeNull()
    inaccessible=false
    const recovered=await loadStateAsync()
    expect(recovered?.plannedVacations[0].note).toBe('new absence')
  })
  it('does not overwrite an existing v2 IDB copy when read failures masked it',async()=>{
    localStorage.setItem('schedule-planner-state-v1',JSON.stringify(fixture(100,'old absence')))
    idbCurrent={...fixture(200,'new absence'),version:2};idbMarker=true
    inaccessible=true
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(key)).toBeNull()
    inaccessible=false
    expect((await loadStateAsync())?.plannedVacations[0].note).toBe('new absence')
  })
  it('does not overwrite an unreadable newer IDB record while loading a valid local fallback',async()=>{
    const good={...fixture(100,'valid older absence'),version:2}
    localStorage.setItem(key,JSON.stringify(good))
    const damaged={...fixture(200,'recoverable newer absence'),version:99}
    idbCurrent=damaged
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(idbCurrent).toEqual(damaged)
  })
  it('does not overwrite malformed local raw data while loading a valid IDB fallback',async()=>{
    const partial='{"version":2,"plannedVacations":[{"note":"recoverable absence"}],"profile":'
    localStorage.setItem(key,partial)
    idbCurrent={...fixture(100,'valid older absence'),version:2}
    await loadStateAsync()
    const archived=Object.keys(localStorage).filter(k=>k.startsWith(key+'-recovery-'))
    expect(archived.some(k=>localStorage.getItem(k)===partial)).toBe(true)
  })

  it('preserves malformed IDB original before repair and refuses destructive repair if archive fails',async()=>{
    const good={...fixture(100,'valid older absence'),version:2}
    localStorage.setItem(key,JSON.stringify(good))
    const damaged={...fixture(200,'recoverable newer absence'),version:2,policy:{}} as AppState
    idbCurrent=damaged;archiveFails=true
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(idbCurrent).toEqual(damaged)
    archiveFails=false
    await loadStateAsync()
    expect(recoveryValues).toContainEqual(damaged)
    expect(idbCurrent).toEqual(good)
  })
  it('does not erase malformed local data when quota prevents keeping its recovery copy',async()=>{
    const partial='{"version":2,"plannedVacations":[{"note":"recoverable absence"}],"profile":'
    localStorage.setItem(key,partial)
    idbCurrent={...fixture(100,'valid older absence'),version:2}
    const setItem=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError')})
    await expect(loadStateAsync()).rejects.toBeInstanceOf(StorageRecoveryError)
    expect(localStorage.getItem(key)).toBe(partial)
    setItem.mockRestore()
  })

})
