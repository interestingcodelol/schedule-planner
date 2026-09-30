import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { useAppState, type AppContextType } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState, PlannedVacation } from '../../lib/types'

let context: AppContextType
vi.mock('../Dashboard', () => ({ Dashboard: () => { context = useAppState(); return null } }))
vi.mock('../UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../../lib/indexedDb', () => ({ loadStateFromIdb: async () => null, loadLegacyStateFromIdb: async () => null, hasV2MigrationInIdb: async () => false, saveStateToIdb: async () => {}, clearIdbState: async () => {} }))

const plan: PlannedVacation = { id: 'pto', startDate: '2026-09-29', endDate: '2026-09-29', hourSource: 'any', locked: false }
function fixture(): AppState {
 return { profile: { displayName:'Fixture', hireDate:'2023-01-01', currentVacationHours:40, currentSickHours:20, currentBankHours:4.75, lastPaydayDate:'2026-09-25', lastSyncDate:'2026-09-29', timezone:'America/New_York' }, policy:{...defaultPolicy}, plannedVacations:[], bankHoursLog:[], theme:'dark',showTour:false,version:1 }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z')); localStorage.clear(); localStorage.setItem('schedule-planner-state-v2', JSON.stringify(fixture())) })
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })
async function mount() { await act(async () => { render(<App />) }) }

describe('independent stale tab preservation', () => {
 it('does not lose newer absence after a delayed older storage event and later profile save', async () => {
   const initial=fixture(); initial.version=2; initial.savedAt=100
   localStorage.setItem('schedule-planner-state-v2', JSON.stringify(initial))
   await mount()
   vi.setSystemTime(new Date('2026-09-29T12:00:01Z'))
   act(() => context.addVacation({...plan,startDate:'2026-10-05',endDate:'2026-10-05',note:'new absence'}))
   const saved=JSON.parse(localStorage.getItem('schedule-planner-state-v2')!)
   const oldIncoming={...initial,savedAt:200,profile:{...initial.profile,displayName:'Other tab'}}
   act(() => window.dispatchEvent(new StorageEvent('storage',{key:'schedule-planner-state-v2',newValue:JSON.stringify(oldIncoming)})))
   act(() => context.updateProfile({displayName:'Final name'}))
   expect(JSON.parse(localStorage.getItem('schedule-planner-state-v2')!).plannedVacations).toEqual(saved.plannedVacations)
 })
})
