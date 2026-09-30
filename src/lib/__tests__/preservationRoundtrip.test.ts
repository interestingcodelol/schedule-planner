import { describe, expect, it } from 'vitest'
import { buildBackupJson, parseImportedBackup, validateImportedState } from '../storage'
import { migrateState } from '../migrate'
import { defaultPolicy } from '../defaultPolicy'
import type { AppState } from '../types'
function richLegacy():AppState {
 return {version:1,savedAt:100,theme:'light',showTour:true,
  profile:{displayName:'Fixture customization',hireDate:'2020-02-29',currentVacationHours:-2.25,currentSickHours:19.75,currentBankHours:2.5,lastPaydayDate:'2026-09-25',lastSyncDate:'2026-09-30',timezone:'Pacific/Apia',lastExportDate:'2026-09-01',backupRemindersDisabled:true,backupReminderDays:90},
  policy:{...defaultPolicy,hoursPerWorkDay:7.5,workDaysPerWeek:[0,2,4,6],holidays:[],accrualTiers:[{minYears:0,maxYears:null,hoursPerPayPeriod:4.25,label:'Custom'}],carryoverCapStrategy:'fixed_hours',carryoverFixedCap:0,sickLeaveAnnualGrant:0,sickLeaveMaxBalance:100,sickLeaveCarryoverCap:0,hideBankHours:true},
  plannedVacations:[
   {id:'logged',startDate:'2026-09-01',endDate:'2026-09-01',kind:'logged_past',hourSource:'bank',actualHoursUsed:2.25,debitedFrom:{vacation:0,sick:0,bank:2.25},locked:true,note:'History 🌻',customEmoji:'🌻',timeOffStart:'14:00',timeOffEnd:'16:15'},
   {id:'future',startDate:'2026-10-01',endDate:'2026-10-02',kind:'planned',hourSource:'any',hoursPerDay:1.25,actualHoursUsed:2.5,locked:false,note:'Future'}
  ],
  bankHoursLog:[{id:'negative',date:'2026-09-25',hours:-1.25,note:'Adjustment',appliedToBalance:true},{id:'pending',date:'2026-10-01',hours:2.5,note:'Pending bank',appliedToBalance:false}],
  catchUpHistory:[{ranOn:'2026-09-25',syncedTo:'2026-09-25',summary:'Fixture',events:[{date:'2026-09-25',type:'accrual',pool:'vacation',delta:4.25,label:'Custom'}]}]
 }
}
describe('independent rich record conservation',()=>{
 it('migration and backup roundtrip retain every supported non-default value',()=>{
  const original=richLegacy(); expect(validateImportedState(original)).toBe(true)
  const migrated=migrateState(original)
  expect(migrated).toEqual({...original,version:2})
  const restored=parseImportedBackup(buildBackupJson(migrated))
  expect(restored).toEqual({ok:true,state:migrated})
  expect(migrateState(migrated)).toEqual(migrated)
 })
 it('accepts legacy omissions already created by historical builds without mutating original',()=>{
  const full=richLegacy()
  const profile: Record<string, unknown>={...full.profile}
  const policy: Record<string, unknown>={...full.policy}
  const planned: Record<string, unknown>={...full.plannedVacations[1]}
  for (const key of ['timezone','lastSyncDate','currentBankHours']) delete profile[key]
  for (const key of ['carryoverPayoutDate','bankHoursPayoutStart','bankHoursPayoutEnd','sickLeaveAnnualGrant','sickLeaveMaxBalance','sickLeaveCarryoverCap']) delete policy[key]
  delete planned.kind; delete planned.hourSource
  const old={...full,profile,policy,bankHoursLog:undefined,catchUpHistory:undefined,plannedVacations:[full.plannedVacations[0],planned]} as unknown as AppState
  const copy=JSON.stringify(old)
  const parsed=parseImportedBackup(copy)
  expect(parsed.ok).toBe(true)
  const migrated=migrateState(old)
  expect(JSON.stringify(old)).toBe(copy)
  expect(migrated.profile.currentVacationHours).toBe(-2.25)
  expect(migrated.plannedVacations[0]).toEqual(old.plannedVacations[0])
  expect(migrated.plannedVacations[1].hourSource).toBe('any')
 })
})
