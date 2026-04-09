import { useMemo } from 'react'
import {
  addDays,
  differenceInDays,
  differenceInYears,
  endOfYear,
  isBefore,
  parseISO,
  startOfDay,
  startOfYear,
} from 'date-fns'
import { Lightbulb } from 'lucide-react'
import { useAppState } from '../context'
import { projectBalance, computeAccrualTier, countWorkDays } from '../lib/projection'
import { computeHolidayDates } from '../lib/holidays'

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
    const today = startOfDay(new Date())
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

    const futureVacations = state.plannedVacations.filter(
      (v) => v.kind !== 'logged_past' && !isBefore(parseISO(v.endDate), today),
    )
    const plannedHours = futureVacations.reduce((sum, v) => {
      const start = parseISO(v.startDate)
      const end = parseISO(v.endDate)
      const effectiveStart = start > today ? start : today
      const workDays = countWorkDays(effectiveStart, end, state.policy)
      const perDay = v.hoursPerDay ?? hoursPerDay
      return sum + workDays * perDay
    }, 0)
    const sickDaysBuffer = Math.floor(Math.max(0, total - plannedHours) / hoursPerDay)

    const carryoverCap =
      state.policy.carryoverCapStrategy === 'unlimited'
        ? null
        : state.policy.carryoverCapStrategy === 'fixed_hours'
          ? (state.policy.carryoverFixedCap ?? 0)
          : annualAccrual

    const pool: Array<Insight | null> = []

    if (carryoverCap !== null) {
      const surplus = yearEndProj.vacationBalance - carryoverCap
      if (surplus > 0) {
        pool.push({
          text: `Projected to exceed the ${Math.round(carryoverCap)}h carryover cap by ${fmt(surplus)} hrs — excess is paid out on the first February pay date`,
          type: 'warning',
        })
      }
    }

    if (sickDaysBuffer < 1 && futureVacations.length > 0) {
      pool.push({
        text: `Your planned time off accounts for nearly all of your available hours`,
        type: 'warning',
      })
    }

    // Tier transition coming up within 6 months
    pool.push((() => {
      const tiers = state.policy.accrualTiers
      const idx = tiers.findIndex(
        (t) => yos >= t.minYears && (t.maxYears === null || yos < t.maxYears),
      )
      if (idx < 0 || idx >= tiers.length - 1) return null
      const nextTier = tiers[idx + 1]
      const yearsToNext = nextTier.minYears - yos
      if (yearsToNext <= 0 || yearsToNext > 0.5) return null
      const daysToNext = Math.max(1, Math.ceil(yearsToNext * 365.25))
      return {
        text: `Accrual rate increases from ${fmt(tier.hoursPerPayPeriod)} to ${fmt(nextTier.hoursPerPayPeriod)} hrs/period in ${daysToNext} day${daysToNext !== 1 ? 's' : ''} (work anniversary)`,
        type: 'positive',
      }
    })())

    if (carryoverCap !== null) {
      const surplus = yearEndProj.vacationBalance - carryoverCap
      if (surplus > -20 && surplus <= 0) {
        pool.push({
          text: `Projected year-end vacation is ${fmt(yearEndProj.vacationBalance)} hrs, under the ${Math.round(carryoverCap)}h carryover cap`,
          type: 'positive',
        })
      }
    }

    if (state.profile.currentBankHours > 0) {
      const payoutMonth = state.policy.bankHoursPayoutStart.month
      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      pool.push({
        text: `${fmt(state.profile.currentBankHours)} bank hrs in your account — payout window opens in ${monthNames[payoutMonth]}`,
        type: 'info',
      })
    }

    pool.push((() => {
      const yStart = startOfYear(today)
      const yEnd = endOfYear(today)
      const totalDays = Math.max(1, differenceInDays(yEnd, yStart))
      const daysIn = differenceInDays(today, yStart)
      const yearPct = Math.round((daysIn / totalDays) * 100)
      const periodsSoFar = Math.max(
        0,
        Math.floor(differenceInDays(today, yStart) / state.policy.payPeriodLengthDays),
      )
      const ytdAccrual = periodsSoFar * tier.hoursPerPayPeriod
      if (yearPct < 5 || ytdAccrual < 1) return null
      return {
        text: `${yearPct}% through the year — you've accrued ~${fmt(ytdAccrual)} vacation hrs so far`,
        type: 'info',
      }
    })())

    pool.push((() => {
      const lookahead = addDays(today, 90)
      const all = [
        ...computeHolidayDates(state.policy, today.getFullYear()),
        ...computeHolidayDates(state.policy, today.getFullYear() + 1),
      ]
      const upcoming = all.filter((d) => d > today && d <= lookahead).length
      if (upcoming === 0) return null
      return {
        text: `${upcoming} paid holiday${upcoming !== 1 ? 's' : ''} on the calendar in the next 90 days`,
        type: 'positive',
      }
    })())

    const monthlyAccrual = (tier.hoursPerPayPeriod * 30) / state.policy.payPeriodLengthDays
    pool.push({
      text: `You earn ~${fmt(monthlyAccrual)} hrs/month — that's about ${fmt(monthlyAccrual / hoursPerDay)} days of time off per month`,
      type: 'info',
    })

    return pool.filter((x): x is Insight => x !== null).slice(0, 4)
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
    <div className="glass-card rounded-xl px-4 py-3 flex items-start gap-3">
      <Lightbulb className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
      <div className="flex flex-wrap gap-x-6 gap-y-1.5">
        {insights.map((insight, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotMap[insight.type]}`} />
            <span className={`text-sm ${colorMap[insight.type]}`}>{insight.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
