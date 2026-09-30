import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { useAppState, type AppContextType } from '../../context'
import { defaultPolicy } from '../../lib/defaultPolicy'
import { getEffectiveCurrentBalances } from '../../lib/projection'
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

describe('App balance lifecycle', () => {
 it('adds, edits and removes today immediately without mutating recorded hours', async () => {
   await mount()
   act(() => context.addVacation(plan))
   expect(getEffectiveCurrentBalances(context.state)).toEqual({vacation:36.75,sick:20,bank:0,total:56.75})
   expect(context.state.profile.currentBankHours).toBe(4.75)
   act(() => context.updateVacation(plan.id,{hoursPerDay:2.25}))
   expect(getEffectiveCurrentBalances(context.state)).toEqual({vacation:40,sick:20,bank:2.5,total:62.5})
   act(() => context.removeVacation(plan.id))
   expect(getEffectiveCurrentBalances(context.state).total).toBe(64.75)
 })
 it('reload and next-day reconciliation never charge the same entry twice; deleting refunds exact pools', async () => {
   await mount()
   act(() => context.addVacation(plan))
   cleanup(); await mount()
   expect(getEffectiveCurrentBalances(context.state).total).toBe(56.75)
   cleanup(); vi.setSystemTime(new Date('2026-09-30T12:00:00Z')); await mount()
   expect(getEffectiveCurrentBalances(context.state).total).toBe(56.75)
   expect(context.state.plannedVacations[0].kind).toBe('logged_past')
   act(() => context.removeVacation(plan.id))
   expect(getEffectiveCurrentBalances(context.state)).toEqual({vacation:40,sick:20,bank:4.75,total:64.75})
 })
 it('adjusts a logged Auto absence then removes it with a symmetric refund', async () => {
   await mount()
   act(() => context.addPastAbsence({...plan,startDate:'2026-09-28',endDate:'2026-09-28'}))
   act(() => context.adjustActualHours(plan.id,2))
   expect(context.state.profile.currentBankHours).toBe(2.75)
   expect(context.state.profile.currentVacationHours).toBe(40)
   act(() => context.removePastAbsence(plan.id))
   expect(getEffectiveCurrentBalances(context.state).total).toBe(64.75)
 })
 it('keeps future bank additions out of now and removing them does not debit now', async () => {
   await mount()
   act(() => context.addBankHours({id:'future-bank',date:'2026-10-01',hours:2,note:'fixture'}))
   expect(context.state.profile.currentBankHours).toBe(4.75)
   act(() => context.removeBankHours('future-bank'))
   expect(context.state.profile.currentBankHours).toBe(4.75)
 })
 it('editing a partially recorded trip unwinds only its recorded draws', async () => {
   await mount()
   act(() => context.addVacation({...plan,endDate:'2026-10-01'}))
   cleanup(); await mount() // today's row is recorded; later days remain planned
   expect(context.state.plannedVacations[0].appliedDeductions).toHaveLength(1)
   act(() => context.updateVacation(plan.id,{hoursPerDay:2}))
   expect(getEffectiveCurrentBalances(context.state)).toEqual({vacation:40,sick:20,bank:2.75,total:62.75})
   cleanup(); await mount()
   expect(getEffectiveCurrentBalances(context.state).total).toBe(62.75)
   act(() => context.removeVacation(plan.id))
   expect(getEffectiveCurrentBalances(context.state).total).toBe(64.75)
 })
 it('logging an actual absence supersedes a recorded planned day without double debit', async () => {
   await mount()
   act(() => context.addVacation({...plan,endDate:'2026-10-01'}))
   cleanup(); await mount()
   act(() => context.addPastAbsence({...plan,id:'actual',hoursPerDay:2,hourSource:'sick'}))
   expect(getEffectiveCurrentBalances(context.state)).toEqual({vacation:40,sick:18,bank:4.75,total:62.75})
   cleanup(); await mount()
   expect(getEffectiveCurrentBalances(context.state).total).toBe(62.75)
   act(() => context.removePastAbsence('actual'))
   // Removing the override restores the scheduled day, once.
   expect(getEffectiveCurrentBalances(context.state).total).toBe(56.75)
 })
 it('merging a recorded trip refunds it before deriving the merged plan', async () => {
   await mount()
   act(() => context.addVacation({...plan,endDate:'2026-10-01'}))
   cleanup(); await mount()
   act(() => context.addVacation({...plan,id:'overlap',endDate:'2026-10-02',hoursPerDay:2}))
   expect(context.state.plannedVacations).toHaveLength(1)
   expect(getEffectiveCurrentBalances(context.state).total).toBe(62.75)
   cleanup(); await mount()
   expect(getEffectiveCurrentBalances(context.state).total).toBe(62.75)
 })

 it('Undo of a partially booked plan re-applies the time off once', async () => {
   await mount()
   act(() => context.addVacation({...plan,endDate:'2026-10-01'}))
   cleanup(); await mount()
   const deleted = context.state.plannedVacations[0]
   act(() => context.removeVacation(plan.id))
   expect(getEffectiveCurrentBalances(context.state).total).toBe(64.75)
   act(() => context.addVacation(deleted))
   expect(getEffectiveCurrentBalances(context.state).total).toBe(56.75)
   cleanup(); await mount()
   expect(getEffectiveCurrentBalances(context.state).total).toBe(56.75)
 })
 it('syncs policy-only changes from another tab without echo-saving', async () => {
   await mount()
   const incoming = {...context.state,savedAt:Date.now()+1,policy:{...context.state.policy,hoursPerWorkDay:7.5}}
   // A real storage event arrives after the other tab has written the key.
   localStorage.setItem('schedule-planner-state-v2',JSON.stringify(incoming))
   act(() => window.dispatchEvent(new StorageEvent('storage',{key:'schedule-planner-state-v2',newValue:JSON.stringify(incoming)})))
   expect(context.state.policy.hoursPerWorkDay).toBe(7.5)
   expect(JSON.parse(localStorage.getItem('schedule-planner-state-v2')!).savedAt).toBe(incoming.savedAt)
 })

 it('Undo of a finalized shortage restores its actual draw without creating debt', async () => {
   const state = fixture(); state.profile.currentVacationHours = 3
   localStorage.setItem('schedule-planner-state-v2',JSON.stringify(state))
   await mount()
   act(() => context.addVacation({...plan,hourSource:'vacation'}))
   cleanup(); vi.setSystemTime(new Date('2026-09-30T12:00:00Z')); await mount()
   const deleted=context.state.plannedVacations[0]
   expect(deleted.debitedFrom?.vacation).toBe(3)
   act(() => context.removePastAbsence(deleted.id))
   expect(context.state.profile.currentVacationHours).toBe(3)
   act(() => context.addPastAbsence(deleted))
   expect(context.state.profile.currentVacationHours).toBe(0)
 })

 it('keeps active historical shortages unchanged across actual Save and Undo', async () => {
   const state=fixture();state.profile.currentVacationHours=16;state.profile.currentBankHours=0
   state.plannedVacations=[{...plan,startDate:'2026-09-28',endDate:'2026-10-02',hoursPerDay:4,hourSource:'vacation',appliedDeductions:[{date:'2026-09-28',hours:4,drawn:{vacation:0,sick:0,bank:0}},{date:'2026-09-29',hours:4,drawn:{vacation:4,sick:0,bank:0}}],debitedFrom:{vacation:4,sick:0,bank:0}}]
   localStorage.setItem('schedule-planner-state-v2',JSON.stringify(state));await mount()
   act(()=>context.adjustActualHours(plan.id,20))
   expect(context.state.profile.currentVacationHours).toBe(16)
   const deleted=context.state.plannedVacations[0]
   act(()=>context.removeVacation(plan.id));expect(context.state.profile.currentVacationHours).toBe(20)
   act(()=>context.addVacation(deleted));expect(context.state.profile.currentVacationHours).toBe(16)
   expect(context.state.plannedVacations[0].appliedDeductions).toEqual(deleted.appliedDeductions)
 })

})
