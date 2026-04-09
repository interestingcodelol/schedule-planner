import { useMemo } from 'react'
import { format, parseISO, endOfYear, differenceInYears } from 'date-fns'
import { Clock, TrendingUp, Calendar, AlertTriangle, Wallet, Layers, HeartPulse } from 'lucide-react'
import { useAppState } from '../context'
import { projectBalance, getNextPayday, computeAccrualTier } from '../lib/projection'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

function Card({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  glow,
  badge,
}: {
  icon: React.ElementType
  label: string
  value: string
  sub: string
  accent?: string
  glow?: string
  badge?: React.ReactNode
}) {
  return (
    <div
      className={`glass-card rounded-xl px-4 py-3 relative overflow-hidden hover:scale-[1.02] hover:-translate-y-0.5 transition-all duration-200 ${glow || ''}`}
    >
      <div
        className={`absolute top-0 left-0 right-0 h-0.5 ${accent || 'bg-gradient-to-r from-blue-500 to-cyan-500'}`}
      />
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm font-medium">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        {badge}
      </div>
      <div className="text-xl font-bold tabular-nums tracking-tight">{value}</div>
      <div className="text-sm text-gray-400 dark:text-gray-500 mt-0.5 truncate">{sub}</div>
    </div>
  )
}

export function StatusCards() {
  const { state } = useAppState()

  const nextPayday = useMemo(
    () =>
      getNextPayday(
        parseISO(state.profile.lastPaydayDate),
        state.policy.payPeriodLengthDays,
      ),
    [state.profile.lastPaydayDate, state.policy.payPeriodLengthDays],
  )

  const currentTier = useMemo(() => {
    const yos = differenceInYears(new Date(), parseISO(state.profile.hireDate))
    return computeAccrualTier(state.policy, yos)
  }, [state.profile.hireDate, state.policy])

  const annualHours = useMemo(() => {
    const periodsPerYear = Math.round(365 / state.policy.payPeriodLengthDays)
    return currentTier.hoursPerPayPeriod * periodsPerYear
  }, [currentTier, state.policy.payPeriodLengthDays])

  const yearEnd = useMemo(() => endOfYear(new Date()), [])
  const yearEndProjection = useMemo(
    () => projectBalance(state, yearEnd),
    [state, yearEnd],
  )

  const carryoverCap = useMemo(() => {
    if (state.policy.carryoverCapStrategy === 'unlimited') return null
    if (state.policy.carryoverCapStrategy === 'fixed_hours')
      return state.policy.carryoverFixedCap ?? 0
    const periodsPerYear = Math.round(365 / state.policy.payPeriodLengthDays)
    return currentTier.hoursPerPayPeriod * periodsPerYear
  }, [state.policy, currentTier])

  const exceedsCap =
    carryoverCap !== null && yearEndProjection.vacationBalance > carryoverCap

  const totalAvailable =
    state.profile.currentVacationHours +
    state.profile.currentSickHours +
    state.profile.currentBankHours

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
      {/* Total Available — hero card */}
      <Card
        icon={Layers}
        label="Total Available"
        value={`${fmt(totalAvailable)} hrs`}
        sub={`Vac: ${fmt(state.profile.currentVacationHours)} · Sick: ${fmt(state.profile.currentSickHours)} · Bank: ${fmt(state.profile.currentBankHours)}`}
        accent="bg-gradient-to-r from-emerald-500 to-teal-500"
        glow="glow-green"
      />

      {/* Current Vacation Balance */}
      <Card
        icon={Clock}
        label="Vacation"
        value={`${fmt(state.profile.currentVacationHours)} hrs`}
        sub={`Accruing ${fmt(currentTier.hoursPerPayPeriod)} hrs/period`}
        accent="bg-gradient-to-r from-blue-500 to-sky-500"
      />

      {/* Sick Hours */}
      <Card
        icon={HeartPulse}
        label="Sick"
        value={`${fmt(state.profile.currentSickHours)} hrs`}
        sub={`Max: ${fmt(state.policy.sickLeaveMaxBalance)} hrs`}
        accent="bg-gradient-to-r from-rose-500 to-pink-500"
      />

      {/* Bank Hours */}
      <Card
        icon={Wallet}
        label="Bank Hours"
        value={`${fmt(state.profile.currentBankHours)} hrs`}
        sub="Extra hours worked"
        accent="bg-gradient-to-r from-teal-500 to-cyan-500"
      />

      {/* Accrual Rate */}
      <Card
        icon={TrendingUp}
        label="Accrual Rate"
        value={`${fmt(annualHours)} hrs/yr`}
        sub={`${fmt(currentTier.hoursPerPayPeriod)} hrs/period · ${currentTier.label}`}
        accent="bg-gradient-to-r from-cyan-500 to-blue-500"
      />

      {/* Next Payday */}
      <Card
        icon={Calendar}
        label="Next Payday"
        value={format(nextPayday, 'MMM d')}
        sub={`+${fmt(currentTier.hoursPerPayPeriod)} hrs vacation`}
        accent="bg-gradient-to-r from-green-500 to-emerald-500"
      />

      {/* Year-End Projection */}
      <Card
        icon={TrendingUp}
        label="Year-End"
        value={`${fmt(yearEndProjection.vacationBalance)} hrs`}
        sub={
          exceedsCap
            ? `Cap: ${fmt(carryoverCap!)} hrs — ${fmt(yearEndProjection.vacationBalance - carryoverCap!)} at risk`
            : carryoverCap !== null
              ? `Cap: ${fmt(carryoverCap)} hrs`
              : 'No carryover cap'
        }
        accent={
          exceedsCap
            ? 'bg-gradient-to-r from-amber-500 to-orange-500'
            : 'bg-gradient-to-r from-blue-500 to-cyan-500'
        }
        glow={exceedsCap ? 'glow-amber' : undefined}
        badge={
          exceedsCap ? (
            <span className="text-amber-500" title="Exceeds carryover cap">
              <AlertTriangle className="w-4 h-4" />
            </span>
          ) : undefined
        }
      />
    </div>
  )
}
