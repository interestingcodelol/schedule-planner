import { useMemo } from 'react'
import { format, parseISO, endOfYear, differenceInYears } from 'date-fns'
import { Clock, TrendingUp, Calendar, AlertTriangle, Wallet, Layers, HeartPulse } from 'lucide-react'
import { useAppState } from '../context'
import {
  projectBalance,
  getNextPayday,
  computeAccrualTier,
  getEffectiveCurrentBalances,
} from '../lib/projection'

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
  className,
}: {
  icon: React.ElementType
  label: string
  value: string
  sub: React.ReactNode
  accent?: string
  glow?: string
  badge?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`glass-card rounded-xl px-3 py-2.5 sm:px-4 sm:py-3 relative overflow-hidden min-h-[5.5rem] flex flex-col ${glow || ''} ${className || ''}`}
      aria-label={`${label}: ${value}`}
    >
      <div
        className={`absolute top-0 left-0 right-0 h-0.5 ${accent || 'bg-gradient-to-r from-blue-500 to-cyan-500'}`}
      />
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400 text-xs sm:text-sm font-medium">
          <Icon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        {badge}
      </div>
      <div className="text-lg sm:text-xl font-bold tabular-nums tracking-tight">{value}</div>
      <div className="text-xs sm:text-[13px] text-gray-400 dark:text-gray-500 mt-0.5 leading-snug break-words whitespace-normal">
        {sub}
      </div>
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

  const effective = useMemo(() => getEffectiveCurrentBalances(state), [state])

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-3 sm:gap-4">
      <Card
        icon={Layers}
        label="Total Available"
        value={`${fmt(effective.total)} hrs`}
        sub={`Vac: ${fmt(effective.vacation)} · Sick: ${fmt(effective.sick)} · Bank: ${fmt(effective.bank)}`}
        accent="bg-gradient-to-r from-emerald-500 to-teal-500"
        glow="glow-green"
        className="col-span-2 sm:col-span-3 md:col-span-2 xl:col-span-1"
      />

      <Card
        icon={Clock}
        label="Vacation"
        value={`${fmt(effective.vacation)} hrs`}
        sub={`Accruing ${fmt(currentTier.hoursPerPayPeriod)} hrs/period`}
        accent="bg-gradient-to-r from-blue-500 to-sky-500"
      />

      <Card
        icon={HeartPulse}
        label="Sick"
        value={`${fmt(effective.sick)} hrs`}
        sub={`Max: ${fmt(state.policy.sickLeaveMaxBalance)} hrs`}
        accent="bg-gradient-to-r from-rose-500 to-pink-500"
      />

      <Card
        icon={Wallet}
        label="Bank Hours"
        value={`${fmt(effective.bank)} hrs`}
        sub="Extra hours worked"
        accent="bg-gradient-to-r from-teal-500 to-cyan-500"
      />

      <Card
        icon={TrendingUp}
        label="Accrual Rate"
        value={`${Math.round(annualHours)} hrs/yr`}
        sub={`${fmt(currentTier.hoursPerPayPeriod)} hrs/period · ${currentTier.label}`}
        accent="bg-gradient-to-r from-cyan-500 to-blue-500"
      />

      <Card
        icon={Calendar}
        label="Next Payday"
        value={format(nextPayday, 'MMM d')}
        sub={`+${fmt(currentTier.hoursPerPayPeriod)} hrs vacation`}
        accent="bg-gradient-to-r from-green-500 to-emerald-500"
      />

      <Card
        icon={TrendingUp}
        label="Year-End"
        value={`${fmt(yearEndProjection.totalAvailable)} hrs`}
        sub={
          exceedsCap
            ? `Vac ${fmt(yearEndProjection.vacationBalance)} · cap ${Math.round(carryoverCap!)} · ${fmt(yearEndProjection.vacationBalance - carryoverCap!)}h will be paid out`
            : `Vac ${fmt(yearEndProjection.vacationBalance)} · Sick ${fmt(yearEndProjection.sickBalance)} · Bank ${fmt(yearEndProjection.bankBalance)}`
        }
        accent={
          exceedsCap
            ? 'bg-gradient-to-r from-amber-500 to-orange-500'
            : 'bg-gradient-to-r from-blue-500 to-cyan-500'
        }
        glow={exceedsCap ? 'glow-amber' : undefined}
        badge={
          exceedsCap ? (
            <span className="text-amber-500" title={`Vacation exceeds ${fmt(carryoverCap!)} hr carryover cap — ${fmt(yearEndProjection.vacationBalance - carryoverCap!)} hrs will be paid out on the first pay date in February (if not used during January)`}>
              <AlertTriangle className="w-4 h-4" />
            </span>
          ) : undefined
        }
      />
    </div>
  )
}
