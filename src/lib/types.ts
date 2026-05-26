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
  /** First year (inclusive) the rule applies. Used for holidays that didn't
   *  exist forever (e.g., Juneteenth became federal in 2021). */
  startYear?: number
}

export type HolidayRuleNthWeekday = {
  type: 'nth_weekday'
  month: number
  weekday: number // 0=Sun, 1=Mon, ..., 6=Sat
  n: number // 1st, 2nd, 3rd, 4th
  name: string
  weekendObservance: 'nearest_weekday' | 'none'
  startYear?: number
}

export type HolidayRuleLastWeekday = {
  type: 'last_weekday'
  month: number
  weekday: number
  name: string
  weekendObservance: 'nearest_weekday' | 'none'
  startYear?: number
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
  /** Optional cap on how many sick hours carry over into the next calendar year.
   *  When set, the balance is capped to this value on Jan 1 before the annual
   *  grant is applied. */
  sickLeaveCarryoverCap?: number
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
  /** False for future-dated entries that haven't reached their date yet —
   *  catch-up folds them into currentBankHours when their date arrives.
   *  Undefined or true means already credited at create time (the default
   *  for past/today entries and for entries written before this field
   *  existed). */
  appliedToBalance?: boolean
}

export type UserProfile = {
  displayName: string
  hireDate: string // ISO date string
  currentVacationHours: number
  currentSickHours: number
  currentBankHours: number
  lastPaydayDate: string // ISO date string
  /** IANA timezone. Optional for backward compatibility; migrateState
   *  populates it from Intl.DateTimeFormat() when missing. */
  timezone?: string
  /** ISO date the catch-up engine last reconciled the stored balances
   *  through. On every app load, `catchUpState` walks events strictly
   *  after this date up to "today" and applies any paydays, sick grants,
   *  carryover payouts, bank payouts, and finished planned-vacation
   *  deductions that occurred while the tab was closed. Optional for
   *  backward compatibility; migrateState backfills it. */
  lastSyncDate?: string
  /** ISO date the user last downloaded a backup (JSON or iCal). Drives
   *  the auto-backup reminder banner. */
  lastExportDate?: string
  /** When true, the auto-backup reminder banner is suppressed. */
  backupRemindersDisabled?: boolean
  /** How many days between backup reminders. Default 30. */
  backupReminderDays?: number
}

export type PlannedVacation = {
  id: string
  startDate: string
  endDate: string
  /** Hours per day in 15-minute increments. Undefined means a full work day. */
  hoursPerDay?: number
  /** "HH:MM" start time (display only). */
  timeOffStart?: string
  /** "HH:MM" end time (display only). */
  timeOffEnd?: string
  hourSource: 'vacation' | 'sick' | 'bank' | 'any'
  note?: string
  locked: boolean
  customEmoji?: string
  /** 'planned' = scheduled in advance (default).
   *  'logged_past' = retroactively logged absence; decrements the matching
   *  balance pool when created. */
  kind?: 'planned' | 'logged_past'
  /** Actual hours used on a past entry, when different from `hoursPerDay`. */
  actualHoursUsed?: number
  /** When a `logged_past` entry actually debited the stored balances, this
   *  records how many hours were drawn from each pool. Lets a later refund
   *  reverse the deduction EXACTLY (re-crediting each pool by the recorded
   *  amount) instead of guessing the split. Absent on entries that never
   *  debited (e.g. still `planned`) or that predate this field. */
  debitedFrom?: { vacation: number; sick: number; bank: number }
}

/** A condensed catch-up event written to history when reconcile() applies
 *  changes. Kept to one line per pool so 30 ticks worth of catch-ups don't
 *  bloat localStorage. */
export type CatchUpHistoryEntry = {
  /** ISO date the catch-up ran (the day the user opened the app). */
  ranOn: string
  /** ISO date the catch-up reconciled through. Same as ranOn unless the
   *  catch-up window covered multiple days. */
  syncedTo: string
  /** Compact one-line summary, same string the toast shows. */
  summary: string
  /** Per-event detail for the change history. Stored separately from the
   *  summary so we don't duplicate the work. */
  events: Array<{
    date: string
    type: string
    pool: 'vacation' | 'sick' | 'bank'
    delta: number
    label: string
  }>
}

export type AppState = {
  profile: UserProfile
  policy: PolicyConfig
  plannedVacations: PlannedVacation[]
  bankHoursLog: BankHoursEntry[]
  theme: 'light' | 'dark'
  showTour: boolean
  version: number
  /** Rolling history of the last N catch-up runs. Capped to 50 entries
   *  in App.tsx. Optional for backward compatibility. */
  catchUpHistory?: CatchUpHistoryEntry[]
  /** Epoch ms when this snapshot was last persisted by `saveState`. Used to
   *  arbitrate between the localStorage and IndexedDB copies on load so a
   *  stale IDB snapshot can't clobber a newer localStorage write (or vice
   *  versa). Optional: older data/tests without it are treated as timestamp 0
   *  (oldest possible), and the validators ignore it as an extra field. */
  savedAt?: number
}

export type ProjectionEvent = {
  date: string // ISO date string
  type: 'accrual' | 'vacation_deduction' | 'carryover_adjustment' | 'bank_payout' | 'sick_grant'
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
  /** Total hours from planned vacation deductions that could not be covered
   *  by any pool at the moment the deduction would have been taken. */
  shortfall: number
  events: ProjectionEvent[]
}
