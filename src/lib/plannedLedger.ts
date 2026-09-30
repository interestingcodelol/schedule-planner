import type { AppState, PlannedVacation } from './types'
import { parseISO } from 'date-fns'
import { getScheduledDeductions } from './projection'

const r2 = (n: number) => Math.round(n * 100) / 100

/** Undo only the recorded part of a still-planned entry before replacing it.
 * Completed/logged absences keep their existing refund path. Future days have
 * never touched the recorded balance and must not be credited here. */
export function unbookPlannedEntry(state: AppState, id: string): AppState {
  const entry = state.plannedVacations.find((v) => v.id === id)
  if (!entry || entry.kind === 'logged_past' || !entry.appliedDeductions?.length) return state
  const refunded = entry.appliedDeductions.reduce((sum, row) => ({
    vacation: sum.vacation + row.drawn.vacation,
    sick: sum.sick + row.drawn.sick,
    bank: sum.bank + row.drawn.bank,
  }), { vacation: 0, sick: 0, bank: 0 })
  return {
    ...state,
    profile: {
      ...state.profile,
      currentVacationHours: r2(state.profile.currentVacationHours + refunded.vacation),
      currentSickHours: r2(state.profile.currentSickHours + refunded.sick),
      currentBankHours: r2(state.profile.currentBankHours + refunded.bank),
    },
    plannedVacations: state.plannedVacations.map((v) => v.id === id
      ? { ...v, appliedDeductions: undefined, debitedFrom: undefined }
      : v),
  }
}

/** A separately logged absence supersedes the matching planned day. Reverse
 * that day's recorded draw first; the shared deduction stream then skips it. */
export function unbookPlannedDates(state: AppState, start: string, end: string): AppState {
  const refunded = { vacation: 0, sick: 0, bank: 0 }
  let changed = false
  const plannedVacations = state.plannedVacations.map((entry) => {
    if (entry.kind === 'logged_past' || !entry.appliedDeductions?.length) return entry
    const removed = entry.appliedDeductions.filter((row) => row.date >= start && row.date <= end)
    if (!removed.length) return entry
    changed = true
    for (const row of removed) {
      refunded.vacation += row.drawn.vacation
      refunded.sick += row.drawn.sick
      refunded.bank += row.drawn.bank
    }
    const kept = entry.appliedDeductions.filter((row) => row.date < start || row.date > end)
    const debitedFrom = kept.reduce((sum, row) => ({
      vacation: sum.vacation + row.drawn.vacation,
      sick: sum.sick + row.drawn.sick,
      bank: sum.bank + row.drawn.bank,
    }), { vacation: 0, sick: 0, bank: 0 })
    return { ...entry, appliedDeductions: kept, debitedFrom }
  })
  if (!changed) return state
  return {
    ...state,
    profile: {
      ...state.profile,
      currentVacationHours: r2(state.profile.currentVacationHours + refunded.vacation),
      currentSickHours: r2(state.profile.currentSickHours + refunded.sick),
      currentBankHours: r2(state.profile.currentBankHours + refunded.bank),
    },
    plannedVacations,
  }
}

/** Preserve unchanged booked days when editing an ongoing plan. In particular,
 * a note-only edit or extending a trip must not replay earlier shortages using
 * hours earned after that day. Only changed/removed days are reversed. */
export function preparePlannedEdit(state: AppState, id: string, updates: Partial<PlannedVacation>): AppState {
  const entry = state.plannedVacations.find((v) => v.id === id)
  if (!entry || entry.kind === 'logged_past' || !entry.appliedDeductions?.length) return state
  const keys = ['startDate', 'endDate', 'hoursPerDay', 'hourSource', 'actualHoursUsed'] as const
  if (!keys.some((key) => key in updates && updates[key] !== entry[key])) return state
  const next = { ...entry, ...updates, appliedDeductions: undefined }
  const desired = getScheduledDeductions({
    ...state, plannedVacations: [...state.plannedVacations.filter((v) => v.id !== id), next],
  }, parseISO(next.endDate)).filter((d) => d.vacation.id === id)
  const kept = entry.appliedDeductions.filter((row) =>
    next.hourSource === entry.hourSource && desired.some((d) =>
      d.date.getFullYear() === Number(row.date.slice(0,4)) &&
      d.date.getMonth() + 1 === Number(row.date.slice(5,7)) &&
      d.date.getDate() === Number(row.date.slice(8,10)) && Math.abs(d.hours-row.hours) < 0.000001),
  )
  const removed = entry.appliedDeductions.filter((row) => !kept.includes(row))
  if (!removed.length) return state
  const sum = (rows: typeof kept) => rows.reduce((total, row) => ({
    vacation: r2(total.vacation + row.drawn.vacation),
    sick: r2(total.sick + row.drawn.sick),
    bank: r2(total.bank + row.drawn.bank),
  }), {vacation:0,sick:0,bank:0})
  const refunded = sum(removed)
  return {
    ...state,
    profile: {...state.profile,
      currentVacationHours:r2(state.profile.currentVacationHours+refunded.vacation),
      currentSickHours:r2(state.profile.currentSickHours+refunded.sick),
      currentBankHours:r2(state.profile.currentBankHours+refunded.bank)},
    plannedVacations: state.plannedVacations.map((v) => v.id === id
      ? {...v,appliedDeductions:kept,debitedFrom:sum(kept)} : v),
  }
}
