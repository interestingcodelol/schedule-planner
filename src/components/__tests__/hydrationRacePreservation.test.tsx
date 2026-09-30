import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { useAppState, type AppContextType } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import type { AppState } from '../../lib/types'
let context: AppContextType
let resolveMirror: (()=>void)|undefined
let calls=0
vi.mock('../Dashboard',()=>({Dashboard:()=>{context=useAppState();return null}}))
vi.mock('../UpdateBanner',()=>({UpdateBanner:()=>null}))
vi.mock('../../lib/indexedDb',()=>({
 loadStateFromIdb:async()=>fixture(100), loadLegacyStateFromIdb:async()=>null,hasV2MigrationInIdb:async()=>false,
 saveStateToIdb:async()=>{ if (++calls===1) await new Promise<void>(r=>{resolveMirror=r}) },clearIdbState:async()=>{},preserveStateForRecoveryInIdb:async()=>{}
}))
function fixture(savedAt:number):AppState {return {version:2,savedAt,theme:'dark',showTour:false,profile:{displayName:'Fixture',hireDate:'2023-01-01',currentVacationHours:40,currentSickHours:20,currentBankHours:4.75,lastPaydayDate:'2026-09-25',lastSyncDate:'2026-09-30',timezone:'UTC'},policy:{...defaultPolicy},plannedVacations:[],bankHoursLog:[]}}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));localStorage.clear();calls=0;resolveMirror=undefined})
afterEach(()=>{cleanup();vi.useRealTimers();localStorage.clear()})
describe('hydrate vs other tab',()=>{
 it('preserves another tab save while an older mirror write is pending',async()=>{
  const local=fixture(200)
  localStorage.setItem('schedule-planner-state-v2',JSON.stringify(local))
  await act(async()=>{render(<App/>)});
  expect(resolveMirror).toBeDefined()
  const newTab=fixture(300);newTab.plannedVacations=[{id:'other',kind:'planned',startDate:'2026-10-01',endDate:'2026-10-01',hourSource:'vacation',locked:false,note:'new other-tab absence'}]
  localStorage.setItem('schedule-planner-state-v2',JSON.stringify(newTab))
  act(()=>window.dispatchEvent(new StorageEvent('storage',{key:'schedule-planner-state-v2',newValue:JSON.stringify(newTab)})))
  await act(async()=>{resolveMirror!()})
  expect(context.state.plannedVacations).toEqual(newTab.plannedVacations)
  expect(JSON.parse(localStorage.getItem('schedule-planner-state-v2')!).plannedVacations).toEqual(newTab.plannedVacations)
 })
})
