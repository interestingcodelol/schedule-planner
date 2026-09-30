import { describe, expect, it } from 'vitest'
import { validateImportedState, buildBackupJson, parseImportedBackup, CURRENT_VERSION } from '../storage'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'
function fixture(): AppState {
  return { profile: { displayName:'Fixture', hireDate:'2023-01-01', currentVacationHours:40, currentSickHours:20, currentBankHours:4, lastPaydayDate:'2026-09-25' }, policy:{...defaultPolicy}, plannedVacations:[{id:'p',startDate:'2026-09-28',endDate:'2026-09-30',hourSource:'any',locked:false}], bankHoursLog:[],theme:'dark',showTour:false,version:1 }
}
describe('backup validation protects balance calculations', () => {
 it('accepts legacy backups and valid daily ledger rows', () => {
  const state=fixture(); expect(validateImportedState(state)).toBe(true)
  state.plannedVacations[0].appliedDeductions=[{date:'2026-09-28',hours:8,drawn:{vacation:4,sick:0,bank:4}}]
  expect(validateImportedState(state)).toBe(true)
 })
 it.each(['2026-02-30','2026-09-28T12:00:00Z','2026-13-01'])('rejects invalid civil date %s',date=>{
  const state=fixture();state.plannedVacations[0].startDate=date;expect(validateImportedState(state)).toBe(false)
 })
 it('rejects reversed ranges and invalid hours',()=>{
  const state=fixture();state.plannedVacations[0].endDate='2026-09-27';expect(validateImportedState(state)).toBe(false)
  state.plannedVacations[0].endDate='2026-09-30';state.plannedVacations[0].hoursPerDay=-1;expect(validateImportedState(state)).toBe(false)
 })
 it('rejects duplicate or out-of-range ledger rows and over-refunding breakdowns',()=>{
  const state=fixture();const row={date:'2026-09-28',hours:8,drawn:{vacation:4,sick:0,bank:4}}
  state.plannedVacations[0].appliedDeductions=[row,{...row}];expect(validateImportedState(state)).toBe(false)
  state.plannedVacations[0].appliedDeductions=[{...row,date:'2026-10-01'}];expect(validateImportedState(state)).toBe(false)
  state.plannedVacations[0].appliedDeductions=[{...row,hours:1}];expect(validateImportedState(state)).toBe(false)
 })
 it('validates bank log dates and values but permits negative adjustments',()=>{
  const state=fixture();state.bankHoursLog=[{id:'b',date:'2026-09-29',hours:-2}];expect(validateImportedState(state)).toBe(true)
  state.bankHoursLog[0].hours=NaN;expect(validateImportedState(state)).toBe(false)
 })
 it('rejects malformed policy anchors and holiday rules',()=>{
  const state=fixture();state.policy.bankHoursPayoutStart={month:0,day:15};expect(validateImportedState(state)).toBe(false)
  state.policy.bankHoursPayoutStart={month:12,day:15};state.policy.holidays=[{type:'last_weekday',month:5,weekday:8,name:'bad',weekendObservance:'none'}];expect(validateImportedState(state)).toBe(false)
 })
})


describe('versioned backup compatibility', () => {
 it('wraps v2 exports so old root-only importers cannot debit active ledgers twice', () => {
  const state = fixture()
  state.plannedVacations[0].appliedDeductions = [{ date:'2026-09-28', hours:8, drawn:{vacation:4,sick:0,bank:4} }]
  const raw = buildBackupJson(state)
  const envelope = JSON.parse(raw)
  expect(envelope._schemaVersion).toBe(CURRENT_VERSION)
  expect(envelope.profile).toBeUndefined()
  expect(envelope.plannedVacations).toBeUndefined()
  expect(validateImportedState(envelope)).toBe(false)
  const restored = parseImportedBackup(raw)
  expect(restored.ok).toBe(true)
  if (restored.ok) {
   expect(restored.state).toEqual({...state,version:CURRENT_VERSION})
   expect(restored.state.plannedVacations[0].appliedDeductions).toEqual(state.plannedVacations[0].appliedDeductions)
  }
 })
 it('still accepts legacy raw and root-enveloped backups', () => {
  const state=fixture()
  expect(parseImportedBackup(JSON.stringify(state))).toEqual({ok:true,state})
  expect(parseImportedBackup(JSON.stringify({...state,_schemaVersion:1,_backupType:'schedule-planner-backup'}))).toEqual({ok:true,state})
 })
 it('rejects future, malformed and inconsistent wrapper schemas', () => {
  for (const payload of [
   {_backupType:'schedule-planner-backup',_schemaVersion:3,state:{...fixture(),version:3}},
   {_backupType:'schedule-planner-backup',_schemaVersion:2,state:fixture()},
   {_backupType:'unrelated',_schemaVersion:2,state:{...fixture(),version:2}},
   {...fixture(),version:3},
  ]) expect(parseImportedBackup(JSON.stringify(payload)).ok).toBe(false)
 })
})
