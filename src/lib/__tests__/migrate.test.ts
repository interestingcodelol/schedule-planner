import { describe, it, expect } from 'vitest'
import { migrateState } from '../migrate'
import { defaultPolicy } from '../defaultPolicy'
import { CURRENT_VERSION } from '../storage'
import type { AppState } from '../types'

function legacyState(overrides: Partial<AppState> = {}): AppState {
  return {
    profile: {
      displayName: 'Legacy User',
      hireDate: '2023-01-01',
      currentVacationHours: 10,
      currentSickHours: 5,
      currentBankHours: 0,
      lastPaydayDate: '2025-06-13',
    },
    policy: { ...defaultPolicy },
    plannedVacations: [],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 1,
    ...overrides,
  }
}

describe('migrateState — preserve customizations, backfill new fields', () => {
  it('backfills a missing sick carry-over cap from the default', () => {
    const loaded = legacyState({
      policy: { ...defaultPolicy, sickLeaveCarryoverCap: undefined },
    })
    const migrated = migrateState(loaded)
    expect(migrated.policy.sickLeaveCarryoverCap).toBe(
      defaultPolicy.sickLeaveCarryoverCap,
    )
  })

  it('keeps a present sick carry-over cap and is idempotent', () => {
    const loaded = legacyState({
      policy: { ...defaultPolicy, sickLeaveCarryoverCap: 24 },
    })
    const once = migrateState(loaded)
    const twice = migrateState(once)
    expect(once.policy.sickLeaveCarryoverCap).toBe(24)
    expect(twice.policy.sickLeaveCarryoverCap).toBe(24)
  })

  it('never overwrites customized tiers or holidays', () => {
    const customTiers = [
      { minYears: 0, maxYears: null, hoursPerPayPeriod: 5, label: 'Custom' },
    ]
    const loaded = legacyState({
      policy: { ...defaultPolicy, accrualTiers: customTiers, holidays: [] },
    })
    const migrated = migrateState(loaded)
    expect(migrated.policy.accrualTiers).toEqual(customTiers)
    expect(migrated.policy.holidays).toEqual([])
  })

  it('normalizes the schema version to current', () => {
    const loaded = legacyState({ version: 99 })
    expect(migrateState(loaded).version).toBe(CURRENT_VERSION)
  })

  it('backfills missing scalar profile/policy fields without touching present ones', () => {
    const loaded = legacyState({
      profile: {
        displayName: 'No Bank',
        hireDate: '2023-01-01',
        currentVacationHours: 10,
        currentSickHours: 5,
        // currentBankHours intentionally omitted (legacy)
        lastPaydayDate: '2025-06-13',
      } as AppState['profile'],
    })
    const migrated = migrateState(loaded)
    expect(migrated.profile.currentBankHours).toBe(0)
    expect(migrated.profile.currentVacationHours).toBe(10) // untouched
  })
})
