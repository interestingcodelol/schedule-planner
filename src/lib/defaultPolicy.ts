import type { PolicyConfig } from './types'

/**
 * Default policy:
 *   years 1–5 → 10 days/yr, years 6–10 → 15 days/yr, years 11+ → 20 days/yr
 * Customize via Settings → Policy.
 */
export const defaultPolicy: PolicyConfig = {
  accrualTiers: [
    { minYears: 0, maxYears: 1, hoursPerPayPeriod: 3.076, label: 'Year 1' },
    { minYears: 1, maxYears: 5, hoursPerPayPeriod: 3.076, label: 'Years 2–5' },
    { minYears: 5, maxYears: 10, hoursPerPayPeriod: 4.615, label: 'Years 6–10' },
    { minYears: 10, maxYears: null, hoursPerPayPeriod: 6.153, label: 'Years 11+' },
  ],
  payPeriodLengthDays: 14,
  carryoverCapStrategy: 'annual_accrual',
  carryoverPayoutDate: { month: 2, day: 1 },
  sickLeaveAnnualGrant: 40,
  sickLeaveMaxBalance: 80,
  sickLeaveCarryoverCap: 40,
  workDaysPerWeek: [1, 2, 3, 4, 5],
  hoursPerWorkDay: 8,
  holidays: [
    { type: 'fixed', month: 1, day: 1, name: "New Year's Day", weekendObservance: 'nearest_weekday' },
    { type: 'nth_weekday', month: 1, weekday: 1, n: 3, name: 'Martin Luther King Jr. Day', weekendObservance: 'none' },
    { type: 'nth_weekday', month: 2, weekday: 1, n: 3, name: "Presidents' Day", weekendObservance: 'none' },
    { type: 'last_weekday', month: 5, weekday: 1, name: 'Memorial Day', weekendObservance: 'none' },
    { type: 'fixed', month: 6, day: 19, name: 'Juneteenth', weekendObservance: 'nearest_weekday' },
    { type: 'fixed', month: 7, day: 4, name: 'Independence Day', weekendObservance: 'nearest_weekday' },
    { type: 'nth_weekday', month: 9, weekday: 1, n: 1, name: 'Labor Day', weekendObservance: 'none' },
    { type: 'fixed', month: 11, day: 11, name: 'Veterans Day', weekendObservance: 'nearest_weekday' },
    { type: 'nth_weekday', month: 11, weekday: 4, n: 4, name: 'Thanksgiving Day', weekendObservance: 'none' },
    { type: 'nth_weekday', month: 11, weekday: 5, n: 4, name: 'Day after Thanksgiving', weekendObservance: 'none' },
    { type: 'fixed', month: 12, day: 24, name: 'Christmas Eve', weekendObservance: 'nearest_weekday' },
    { type: 'fixed', month: 12, day: 25, name: 'Christmas Day', weekendObservance: 'nearest_weekday' },
  ],
  bankHoursPayoutStart: { month: 12, day: 15 },
  bankHoursPayoutEnd: { month: 2, day: 15 },
}
