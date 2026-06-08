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
import {
  projectBalance,
  computeAccrualTier,
  countWorkDays,
  getCarryoverOutlook,
  getSickOutlook,
} from '../lib/projection'
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

    const yearEndProj = projectBalance(state, yearEnd)

    const futureVacations = state.plannedVacations.filter(
      (v) => v.kind !== 'logged_past' && !isBefore(parseISO(v.endDate), today),
    )

    // Buffer = hours left over AFTER all planned time off is funded, derived
    // from the projection so this agrees with StatusCards / VacationPlanner
    // (which use projectBalance). The projection already honors hourSource and
    // actualHoursUsed when deducting, and surfaces any uncovered hours as
    // `shortfall`. Guard against absent projection fields so we never crash.
    const projectedRemaining = Number.isFinite(yearEndProj?.totalAvailable)
      ? yearEndProj.totalAvailable
      : 0
    const projectedShortfall = Number.isFinite(yearEndProj?.shortfall)
      ? yearEndProj.shortfall
      : 0
    const sickDaysBuffer = Math.floor(Math.max(0, projectedRemaining) / hoursPerDay)

    // Tier-aware carry-over picture for the next payout (correct cap + exact
    // payout even across a service anniversary), shared with StatusCards/forecast.
    const carryover = getCarryoverOutlook(state)
    const sickOutlook = getSickOutlook(state)

    const pool: Array<Insight | null> = []

    if (carryover.cap !== null && carryover.projectedPayout > 0) {
      pool.push({
        text: `Projected to exceed the ${Math.round(carryover.cap)}h carry-over cap by **${fmt(carryover.projectedPayout)} hrs** — excess is paid out on the first February pay date`,
        type: 'warning',
      })
    }

    if (sickOutlook.projectedForfeit > 0) {
      pool.push({
        text: `Projected to forfeit **${fmt(sickOutlook.projectedForfeit)} hrs** of sick leave on Jan 1 — over the ${Math.round(sickOutlook.carryoverCap ?? 0)}h carry-over limit; sick time isn't paid out`,
        type: 'warning',
      })
    }

    if ((sickDaysBuffer < 1 || projectedShortfall > 0) && futureVacations.length > 0) {
      pool.push({
        text:
          projectedShortfall > 0
            ? `Your planned time off exceeds your projected hours by **${fmt(projectedShortfall)} hrs** — you'll be short`
            : `Your planned time off accounts for **nearly all** of your available hours`,
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
        text: `Accrual rate increases to **${fmt(nextTier.hoursPerPayPeriod)} hrs/period** in ${daysToNext} day${daysToNext !== 1 ? 's' : ''} (work anniversary)`,
        type: 'positive',
      }
    })())

    if (carryover.cap !== null) {
      const surplus = yearEndProj.vacationBalance - carryover.cap
      if (surplus > -20 && surplus <= 0) {
        pool.push({
          text: `Projected year-end vacation is **${fmt(yearEndProj.vacationBalance)} hrs**, under the ${Math.round(carryover.cap)}h carry-over cap`,
          type: 'positive',
        })
      }
    }

    if (state.profile.currentBankHours > 0 && !state.policy.hideBankHours) {
      const payoutMonth = state.policy.bankHoursPayoutStart.month
      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      pool.push({
        text: `**${fmt(state.profile.currentBankHours)} bank hrs** in your account — payout window opens in ${monthNames[payoutMonth]}`,
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
        text: `${yearPct}% through the year — you've accrued **~${fmt(ytdAccrual)} vacation hrs** so far`,
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
        text: `**${upcoming} paid holiday${upcoming !== 1 ? 's' : ''}** on the calendar in the next 90 days`,
        type: 'positive',
      }
    })())

    const monthlyAccrual = (tier.hoursPerPayPeriod * 30) / state.policy.payPeriodLengthDays
    pool.push({
      text: `You earn **~${fmt(monthlyAccrual)} hrs/month** — that's about ${fmt(monthlyAccrual / hoursPerDay)} days of time off per month`,
      type: 'info',
    })

    // PTO + holidays as a ratio of total time off in the year. Holidays are
    // "free" days off; PTO scheduled by the user costs hours. Ratio gives a
    // sense of how much of their year-end time-off mix comes from each.
    pool.push((() => {
      const yearStart = startOfYear(today)
      const yearEnd2 = endOfYear(today)
      const holidayCount = computeHolidayDates(state.policy, today.getFullYear())
        .filter((d) => d >= yearStart && d <= yearEnd2 && state.policy.workDaysPerWeek.includes(d.getDay()))
        .length
      const plannedDays = state.plannedVacations
        .filter((v) => v.kind !== 'logged_past')
        .filter((v) => parseISO(v.startDate) >= yearStart && parseISO(v.endDate) <= yearEnd2)
        .reduce((sum, v) => {
          const s = parseISO(v.startDate)
          const e = parseISO(v.endDate)
          return sum + countWorkDays(s, e, state.policy)
        }, 0)
      const totalOff = holidayCount + plannedDays
      if (totalOff < 1) return null
      const holidayPct = Math.round((holidayCount / totalOff) * 100)
      const ptoPct = 100 - holidayPct
      return {
        text: `**${holidayPct}%** of your year-off days come from holidays · **${ptoPct}%** from your own PTO (${holidayCount} holidays + ${plannedDays} planned)`,
        type: 'info',
      }
    })())

    // YTD utilization: how much of your annual PTO accrual you've already
    // committed to (used + scheduled-future). Pairs with the YTD-accrual
    // tip already in the pool — accrued vs spent gives both halves.
    pool.push((() => {
      const yearStart = startOfYear(today)
      const yearEnd2 = endOfYear(today)
      const totalDays = Math.max(1, differenceInDays(yearEnd2, yearStart))
      const yearPct = Math.round((differenceInDays(today, yearStart) / totalDays) * 100)
      const usedAndScheduledHrs = state.plannedVacations
        .filter((v) => parseISO(v.startDate) >= yearStart && parseISO(v.endDate) <= yearEnd2)
        .reduce((sum, v) => {
          const s = parseISO(v.startDate)
          const e = parseISO(v.endDate)
          const wd = countWorkDays(s, e, state.policy)
          const perDay = v.actualHoursUsed ?? v.hoursPerDay ?? hoursPerDay
          return sum + wd * perDay
        }, 0)
      if (annualAccrual < 1) return null
      const utilPct = Math.round((usedAndScheduledHrs / annualAccrual) * 100)
      if (utilPct < 1) return null
      return {
        text: `You've used **${utilPct}%** of your annual PTO (${fmt(usedAndScheduledHrs)} of ${fmt(annualAccrual)} hrs) — year is ${yearPct}% done`,
        type: 'info',
      }
    })())

    return pool.filter((x): x is Insight => x !== null).slice(0, 4)
  }, [state])

  if (insights.length === 0) return null

  // Three on-brand semantic colors only: informational tips use the app's
  // blue/cyan brand hue (not washed-out gray), positive milestones stay
  // emerald, and warnings stay amber. Keeps the row colorful but restrained.
  const colorMap = {
    positive: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-amber-600 dark:text-amber-400',
    info: 'text-sky-700 dark:text-sky-300',
  }

  const dotMap = {
    positive: 'bg-emerald-500',
    warning: 'bg-amber-500',
    info: 'bg-sky-500',
  }

  return (
    <div className="glass-card rounded-xl px-3 py-2 sm:px-4 sm:py-3 flex items-center gap-2 sm:gap-3">
      <Lightbulb className="w-4 h-4 text-amber-500 shrink-0" />
      {/* Responsive, scrollbar-free at every width:
       *  - Mobile/tablet: wraps into a tidy multi-line block (no horizontal
       *    scroll, so no scrollbar) — text wraps so nothing overflows.
       *  - lg+: a single row; if the tips don't all fit they scroll
       *    horizontally with the scrollbar hidden (never grows to two rows). */}
      <div className="flex flex-wrap lg:flex-nowrap items-start lg:items-center gap-x-4 sm:gap-x-6 gap-y-1.5 lg:overflow-x-auto no-scrollbar flex-1 min-w-0">
        {insights.map((insight, i) => (
          <div
            key={i}
            className="flex items-start lg:items-center gap-1.5 shrink-0 whitespace-normal lg:whitespace-nowrap"
          >
            <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 mt-1 lg:mt-0 rounded-full shrink-0 ${dotMap[insight.type]}`} />
            {/* Base text is a calm muted gray; only the key value(s) wrapped in
             *  **…** get the semantic accent color, so each tip highlights what
             *  matters without flooding the row with color. */}
            <span className="text-xs sm:text-sm leading-snug text-gray-500 dark:text-gray-400">
              {insight.text.split('**').map((seg, j) =>
                j % 2 === 1 ? (
                  <span key={j} className={`font-semibold ${colorMap[insight.type]}`}>
                    {seg}
                  </span>
                ) : (
                  seg
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
