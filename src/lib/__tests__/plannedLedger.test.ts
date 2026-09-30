import { describe, expect, it } from 'vitest'
import { preparePlannedEdit } from '../plannedLedger'
import { getCurrentBalanceSummary } from '../projection'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'
function booked(): AppState {
 return {profile:{displayName:'Fixture',hireDate:'2020-01-01',currentVacationHours:16,currentSickHours:0,currentBankHours:0,lastPaydayDate:'2026-09-29',lastSyncDate:'2026-09-29',timezone:'UTC'},policy:{...defaultPolicy,holidays:[]},plannedVacations:[{id:'trip',startDate:'2026-09-28',endDate:'2026-10-02',hoursPerDay:4,hourSource:'vacation',locked:false,kind:'planned',appliedDeductions:[{date:'2026-09-28',hours:4,drawn:{vacation:0,sick:0,bank:0}},{date:'2026-09-29',hours:4,drawn:{vacation:4,sick:0,bank:0}}],debitedFrom:{vacation:4,sick:0,bank:0}}],bankHoursLog:[],theme:'dark',showTour:false,version:2}
}
describe('editing partially booked plans',()=>{
 it('does not replay unchanged fields or note-only edits against later accruals',()=>{
  const state=booked();const next=preparePlannedEdit(state,'trip',{note:'new note',hoursPerDay:4,hourSource:'vacation'})
  expect(next).toBe(state)
  const summary=getCurrentBalanceSummary(next,new Date('2026-09-29T12:00:00Z'))
  expect(summary.available.vacation).toBe(16);expect(summary.shortfall).toBe(4)
 })
 it('preserves booked days when extending only the future end of a trip',()=>{
  const state=booked();const next=preparePlannedEdit(state,'trip',{endDate:'2026-10-05'})
  expect(next.plannedVacations[0].appliedDeductions).toEqual(state.plannedVacations[0].appliedDeductions)
  expect(next.profile.currentVacationHours).toBe(16)
 })
 it('refunds only removed booked dates while retaining earlier shortage',()=>{
  const next=preparePlannedEdit(booked(),'trip',{endDate:'2026-09-28'})
  expect(next.profile.currentVacationHours).toBe(20)
  expect(next.plannedVacations[0].appliedDeductions).toHaveLength(1)
  expect(next.plannedVacations[0].appliedDeductions?.[0].drawn.vacation).toBe(0)
 })
})
