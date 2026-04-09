export type AccrualTier = {
  minYears: number
  maxYears: number | null
  hoursPerPayPeriod: number
  label: string
}

export type HolidayRuleFixed = {
  type: 'fixed'
  month: number
  day: number
  name: string
  weekendObservance: 'nearest_weekday' | 'none'
}

export type HolidayRuleNthWeekday = {
  type: 'nth_weekday'
  month: number
  weekday: number // 0=Sun, 1=Mon, ..., 6=Sat
  n: number // 1st, 2nd, 3rd, 4th
  name: string
  weekendObservance: 'nearest_weekday' | 'none'
}

export type HolidayRuleLastWeekday = {
  type: 'last_weekday'
  month: number
  weekday: number
  name: string
  weekendObservance: 'nearest_weekday' | 'none'
}

export type HolidayRule = HolidayRuleFixed | HolidayRuleNthWeekday | HolidayRuleLastWeekday

export type PolicyConfig = {
  accrualTiers: AccrualTier[]
  payPeriodLengthDays: number
  carryoverCapStrategy: 'annual_accrual' | 'fixed_hours' | 'unlimited'
  carryoverFixedCap?: number
  carryoverPayoutDate: { month: number; day: number }
  sickLeaveAnnualGrant: number
  sickLeaveMaxBalance: number
  workDaysPerWeek: number[] // 0=Sun, 1=Mon, ..., 6=Sat
  hoursPerWorkDay: number
  holidays: HolidayRule[]
  bankHoursPayoutStart: { month: number; day: number } // When bank hours get paid out (start)
  bankHoursPayoutEnd: { month: number; day: number } // When bank hours payout period ends
}

export type BankHoursEntry = {
  id: string
  date: string // ISO date string
  hours: number // positive = hours banked, negative = hours used
  note?: string
}

export type UserProfile = {
  displayName: string
  hireDate: string // ISO date string
  currentVacationHours: number
  currentSickHours: number
  currentBankHours: number
  lastPaydayDate: string // ISO date string
}

export type PlannedVacation = {
  id: string
  startDate: string // ISO date string
  endDate: string // ISO date string
  hoursPerDay?: number // Override hours per day (for partial days). Undefined = full day.
  timeOffStart?: string // e.g. "08:00" — when time off begins (display only)
  timeOffEnd?: string // e.g. "12:00" — when time off ends (display only)
  hourSource: 'vacation' | 'sick' | 'bank' | 'any'
  note?: string
  locked: boolean
  customEmoji?: string
}

export type AppState = {
  profile: UserProfile
  policy: PolicyConfig
  plannedVacations: PlannedVacation[]
  bankHoursLog: BankHoursEntry[]
  theme: 'light' | 'dark'
  showTour: boolean
  version: number
}

export type ProjectionEvent = {
  date: string // ISO date string
  type: 'accrual' | 'vacation_deduction' | 'carryover_adjustment' | 'bank_payout'
  delta: number
  runningBalance: number
  label?: string
}

export type ProjectionResult = {
  vacationBalance: number
  sickBalance: number
  bankBalance: number
  totalAvailable: number // vacation + sick + bank combined
  carryoverAdjustment: number
  bankPayout: number // hours paid out during payout period
  events: ProjectionEvent[]
}
