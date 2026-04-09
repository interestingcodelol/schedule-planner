import { useMemo } from 'react'
import { endOfYear, differenceInYears, parseISO } from 'date-fns'
import { Lightbulb } from 'lucide-react'
import { useAppState } from '../context'
import { projectBalance, computeAccrualTier, countWorkDays } from '../lib/projection'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

type Insight = {
  text: string
  type: 'positive' | 'warning' | 'info'
}

export function Insights() {
  const { state } = useAppState()

  const insights = useMemo(() => {
    const results: Insight[] = []
    const today = new Date()
    const yearEnd = endOfYear(today)
    const hireDate = parseISO(state.profile.hireDate)
    const yos = differenceInYears(today, hireDate)
    const tier = computeAccrualTier(state.policy, yos)
    const periodsPerYear = Math.round(365 / state.policy.payPeriodLengthDays)
    const annualAccrual = tier.hoursPerPayPeriod * periodsPerYear
    const hoursPerDay = state.policy.hoursPerWorkDay

    const total =
      state.profile.currentVacationHours +
      state.profile.currentSickHours +
      state.profile.currentBankHours

    const yearEndProj = projectBalance(state, yearEnd)

    // How many sick days can they take and still afford planned vacations?
    const plannedHours = state.plannedVacations.reduce((sum, v) => {
      const start = parseISO(v.startDate)
      const end = parseISO(v.endDate)
      if (end < today) return sum
      const effectiveStart = start > today ? start : today
      const workDays = countWorkDays(effectiveStart, end, state.policy)
      return sum + workDays * hoursPerDay
    }, 0)

    const bufferHours = total - plannedHours
    const sickDaysBuffer = Math.floor(Math.max(0, bufferHours) / hoursPerDay)

    if (sickDaysBuffer >= 2) {
      results.push({
        text: `You can take up to ${sickDaysBuffer} sick days and still cover all your planned time off`,
        type: 'positive',
      })
    } else if (sickDaysBuffer < 1 && state.plannedVacations.length > 0) {
      results.push({
        text: `Your planned time off uses nearly all your hours — a sick day could put you short`,
        type: 'warning',
      })
    }

    // Year-end usage check
    const carryoverCap =
      state.policy.carryoverCapStrategy === 'unlimited'
        ? null
        : state.policy.carryoverCapStrategy === 'fixed_hours'
          ? (state.policy.carryoverFixedCap ?? 0)
          : annualAccrual

    if (carryoverCap !== null) {
      const surplus = yearEndProj.vacationBalance - carryoverCap
      if (surplus > 0) {
        const daysToUse = Math.ceil(surplus / hoursPerDay)
        results.push({
          text: `You'll exceed your carryover cap by ${fmt(surplus)} hrs — plan ${daysToUse} more day${daysToUse !== 1 ? 's' : ''} off before year-end to avoid losing hours`,
          type: 'warning',
        })
      } else if (surplus > -20 && surplus <= 0) {
        results.push({
          text: `You're on track — projected year-end balance is ${fmt(yearEndProj.vacationBalance)} hrs (cap: ${fmt(carryoverCap)} hrs)`,
          type: 'positive',
        })
      }
    }

    // Accrual rate insight
    const monthlyAccrual = (tier.hoursPerPayPeriod * 30) / state.policy.payPeriodLengthDays
    results.push({
      text: `You earn ~${fmt(monthlyAccrual)} hrs/month — that's about ${fmt(monthlyAccrual / hoursPerDay)} days of time off per month`,
      type: 'info',
    })

    // Bank hours payout warning
    if (state.profile.currentBankHours > 0) {
      const payoutMonth = state.policy.bankHoursPayoutStart.month
      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      results.push({
        text: `You have ${fmt(state.profile.currentBankHours)} bank hrs — use them before the ${monthNames[payoutMonth]} payout window or they get paid out`,
        type: 'info',
      })
    }

    return results.slice(0, 3) // Show max 3
  }, [state])

  if (insights.length === 0) return null

  const colorMap = {
    positive: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-amber-600 dark:text-amber-400',
    info: 'text-gray-500 dark:text-gray-400',
  }

  const dotMap = {
    positive: 'bg-emerald-500',
    warning: 'bg-amber-500',
    info: 'bg-gray-400 dark:bg-gray-500',
  }

  return (
    <div className="glass-card rounded-xl px-4 py-2.5 flex items-start gap-3">
      <Lightbulb className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {insights.map((insight, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotMap[insight.type]}`} />
            <span className={`text-xs ${colorMap[insight.type]}`}>{insight.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
