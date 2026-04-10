import {
  format,
  addDays,
  addWeeks,
  nextMonday,
  nextFriday,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  isValid,
  parseISO,
  startOfDay,
  endOfYear,
  getDay,
  differenceInYears,
  differenceInDays,
  isBefore,
  subDays,
} from 'date-fns'
import type { AppState } from './types'
import {
  projectBalance,
  countWorkDays,
  earliestAffordableDate,
  computeAccrualTier,
} from './projection'

export type ChatResponse = {
  text: string
  action?: {
    type: 'plan_vacation'
    startDate: string
    endDate: string
    note?: string
  }
}

const MONTH_MAP: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
}

const ORDINAL_MAP: Record<string, number> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1,
}

const DAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

function findMonthInText(text: string): number | null {
  for (const [name, idx] of Object.entries(MONTH_MAP)) {
    if (text.includes(name)) return idx
  }
  return null
}

// Get the Nth week (Mon-Fri) of a given month
function getNthWeekOfMonth(month: number, n: number, year: number): { start: Date; end: Date } {
  const monthStart = startOfMonth(new Date(year, month, 1))
  const monthEnd = endOfMonth(monthStart)

  if (n === -1) {
    // "last week" — find the last Monday in the month
    let d = monthEnd
    while (getDay(d) !== 1) d = subDays(d, 1)
    const fri = addDays(d, 4)
    return { start: d, end: isBefore(fri, monthEnd) ? fri : monthEnd }
  }

  // Find the first Monday of the month
  let firstMon = monthStart
  while (getDay(firstMon) !== 1) firstMon = addDays(firstMon, 1)

  const weekStart = addWeeks(firstMon, n - 1)
  const weekEnd = addDays(weekStart, 4) // Friday
  return {
    start: weekStart,
    end: isBefore(weekEnd, monthEnd) ? weekEnd : monthEnd,
  }
}

function tryParseDate(text: string): Date | null {
  const today = startOfDay(new Date())
  const thisYear = today.getFullYear()
  const cleaned = text.replace(/(st|nd|rd|th)\b/gi, '').trim()

  // "4/10" or "04/10"
  const slashShort = cleaned.match(/^(\d{1,2})[/-](\d{1,2})$/)
  if (slashShort) {
    const m = parseInt(slashShort[1]) - 1
    const d = parseInt(slashShort[2])
    if (m >= 0 && m <= 11 && d >= 1 && d <= 31) {
      const date = new Date(thisYear, m, d)
      if (isValid(date)) return date < today ? new Date(thisYear + 1, m, d) : date
    }
  }

  // "4/10/2026"
  const slashFull = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (slashFull) {
    const d = new Date(parseInt(slashFull[3]), parseInt(slashFull[1]) - 1, parseInt(slashFull[2]))
    if (isValid(d)) return d
  }

  // "July 14" / "Jul 14"
  const monthDay = cleaned.match(/^(\w+)\s+(\d{1,2})$/i)
  if (monthDay) {
    const m = MONTH_MAP[monthDay[1].toLowerCase()]
    if (m !== undefined) {
      const d = new Date(thisYear, m, parseInt(monthDay[2]))
      if (isValid(d)) return d < today ? new Date(thisYear + 1, m, parseInt(monthDay[2])) : d
    }
  }

  // "14 July"
  const dayMonth = cleaned.match(/^(\d{1,2})\s+(\w+)$/i)
  if (dayMonth) {
    const m = MONTH_MAP[dayMonth[2].toLowerCase()]
    if (m !== undefined) {
      const d = new Date(thisYear, m, parseInt(dayMonth[1]))
      if (isValid(d)) return d < today ? new Date(thisYear + 1, m, parseInt(dayMonth[1])) : d
    }
  }

  // ISO
  const iso = parseISO(cleaned)
  if (isValid(iso)) return iso

  return null
}

function extractDateRange(input: string): { start: Date; end: Date } | null {
  const today = startOfDay(new Date())
  const lower = input.toLowerCase().trim()
  const thisYear = today.getFullYear()

  // --- Relative phrases ---

  // "tomorrow"
  if (/\btomorrow\b/.test(lower)) return { start: addDays(today, 1), end: addDays(today, 1) }

  // "today"
  if (/\btoday\b/.test(lower) && lower.length < 20) return { start: today, end: today }

  // "next week"
  if (/\bnext\s+week\b/.test(lower) && !findMonthInText(lower)) {
    const mon = nextMonday(today)
    return { start: mon, end: nextFriday(mon) }
  }

  // "this week"
  if (/\bthis\s+week\b/.test(lower)) {
    const mon = startOfWeek(today, { weekStartsOn: 1 })
    return { start: isBefore(mon, today) ? today : mon, end: addDays(mon, 4) }
  }

  // "in N weeks" / "N weeks from now"
  const nWeeks = lower.match(/\b(\d+)\s+weeks?\s+(from\s+now|out|away)\b/)
  if (nWeeks) {
    const w = parseInt(nWeeks[1])
    const mon = startOfWeek(addWeeks(today, w), { weekStartsOn: 1 })
    return { start: mon, end: addDays(mon, 4) }
  }

  // --- Nth week of month ---
  // "second week of December", "the 2nd week in July", "last week of October"
  const nthWeekMonth = lower.match(
    /(?:the\s+)?(\w+)\s+week\s+(?:of|in)\s+(\w+)/i,
  )
  if (nthWeekMonth) {
    const ord = ORDINAL_MAP[nthWeekMonth[1].toLowerCase()]
    const month = MONTH_MAP[nthWeekMonth[2].toLowerCase()]
    if (ord !== undefined && month !== undefined) {
      const year = new Date(thisYear, month, 1) < today ? thisYear + 1 : thisYear
      const { start, end } = getNthWeekOfMonth(month, ord, year)
      return { start, end }
    }
  }

  // "week of December" / "a week in July" (defaults to first full week)
  const weekInMonth = lower.match(/(?:a\s+)?week\s+(?:of|in|during)\s+(\w+)/i)
  if (weekInMonth && !nthWeekMonth) {
    const month = MONTH_MAP[weekInMonth[1].toLowerCase()]
    if (month !== undefined) {
      const year = new Date(thisYear, month, 1) < today ? thisYear + 1 : thisYear
      const { start, end } = getNthWeekOfMonth(month, 1, year)
      return { start, end }
    }
  }

  // "in December during the second week" / "in July the third week"
  const inMonthDuringWeek = lower.match(
    /(?:in|during)\s+(\w+)\s+(?:during\s+)?(?:the\s+)?(\w+)\s+week/i,
  )
  if (inMonthDuringWeek) {
    const month = MONTH_MAP[inMonthDuringWeek[1].toLowerCase()]
    const ord = ORDINAL_MAP[inMonthDuringWeek[2].toLowerCase()]
    if (month !== undefined && ord !== undefined) {
      const year = new Date(thisYear, month, 1) < today ? thisYear + 1 : thisYear
      const { start, end } = getNthWeekOfMonth(month, ord, year)
      return { start, end }
    }
  }

  // "in December" / "during December" / "off in December" (whole month context → first full week)
  const offInMonth = lower.match(/(?:off|time\s+off|vacation|break)\s+(?:in|during)\s+(\w+)/i)
  if (offInMonth) {
    const month = MONTH_MAP[offInMonth[1].toLowerCase()]
    if (month !== undefined) {
      const year = new Date(thisYear, month, 1) < today ? thisYear + 1 : thisYear
      const { start, end } = getNthWeekOfMonth(month, 1, year)
      return { start, end }
    }
  }

  // "the second week" (no month — assume current or next month)
  const justNthWeek = lower.match(/(?:the\s+)?(\w+)\s+week\b(?!\s+(?:of|in))/i)
  if (justNthWeek && !nthWeekMonth) {
    const ord = ORDINAL_MAP[justNthWeek[1].toLowerCase()]
    if (ord !== undefined) {
      const curMonth = today.getMonth()
      const { start, end } = getNthWeekOfMonth(curMonth, ord, thisYear)
      if (isBefore(end, today)) {
        const next = getNthWeekOfMonth(curMonth + 1, ord, thisYear)
        return next
      }
      return { start, end }
    }
  }

  // "next [day name]" / "this [day name]"
  for (const [name, dow] of Object.entries(DAY_MAP)) {
    const re = new RegExp(`\\b(?:next|this|coming)?\\s*${name}\\b`)
    if (re.test(lower) && lower.length < 40) {
      let d = addDays(today, 1)
      for (let i = 0; i < 7; i++) {
        if (getDay(d) === dow) return { start: d, end: d }
        d = addDays(d, 1)
      }
    }
  }

  // "[day] through/to [day]" with day names — "monday through friday", "wed to fri"
  for (const [startName, startDow] of Object.entries(DAY_MAP)) {
    for (const [endName, endDow] of Object.entries(DAY_MAP)) {
      const re = new RegExp(`${startName}\\s+(?:through|thru|to|-|–)\\s+${endName}`)
      if (re.test(lower)) {
        let d = addDays(today, 1)
        for (let i = 0; i < 7; i++) {
          if (getDay(d) === startDow) {
            let endD = d
            while (getDay(endD) !== endDow) endD = addDays(endD, 1)
            return { start: d, end: endD }
          }
          d = addDays(d, 1)
        }
      }
    }
  }

  // "week of July 14" / "week of 7/14"
  const weekOf = lower.match(/week\s+of\s+(.+)/i)
  if (weekOf) {
    const d = tryParseDate(weekOf[1].trim())
    if (d) {
      const start = startOfWeek(d, { weekStartsOn: 1 })
      return { start, end: addDays(start, 4) }
    }
  }

  // --- Explicit date range patterns (high priority) ---

  // "July 4-6", "July 4th - 6th", "Jul 4 to 6", "december 15-19"
  const monthDayRange = lower.match(
    /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–]\s*(\d{1,2})(?:st|nd|rd|th)?/i,
  )
  if (monthDayRange) {
    const m = MONTH_MAP[monthDayRange[1].toLowerCase()]
    if (m !== undefined) {
      const d1 = parseInt(monthDayRange[2])
      const d2 = parseInt(monthDayRange[3])
      const year = new Date(thisYear, m, d1) < today ? thisYear + 1 : thisYear
      return { start: new Date(year, m, d1), end: new Date(year, m, d2) }
    }
  }

  // "July 4th to July 6th", "Jul 4 through Jul 10"
  const monthDayToMonthDay = lower.match(
    /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|through|thru|-|–)\s+(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?/i,
  )
  if (monthDayToMonthDay) {
    const m1 = MONTH_MAP[monthDayToMonthDay[1].toLowerCase()]
    const m2 = MONTH_MAP[monthDayToMonthDay[3].toLowerCase()]
    if (m1 !== undefined && m2 !== undefined) {
      const d1 = parseInt(monthDayToMonthDay[2])
      const d2 = parseInt(monthDayToMonthDay[4])
      const year1 = new Date(thisYear, m1, d1) < today ? thisYear + 1 : thisYear
      const year2 = m2 < m1 ? year1 + 1 : year1
      return { start: new Date(year1, m1, d1), end: new Date(year2, m2, d2) }
    }
  }

  // "4/14-4/17", "4/14 to 4/17"
  const slashRange = lower.match(
    /(\d{1,2})[/-](\d{1,2})\s*[-–]\s*(\d{1,2})[/-](\d{1,2})/,
  )
  if (slashRange) {
    const s = new Date(thisYear, parseInt(slashRange[1]) - 1, parseInt(slashRange[2]))
    const e = new Date(thisYear, parseInt(slashRange[3]) - 1, parseInt(slashRange[4]))
    if (isValid(s) && isValid(e)) {
      return { start: s < today ? addDays(s, 365) : s, end: e < today ? addDays(e, 365) : e }
    }
  }

  // --- Generic range with separator (fallback) ---
  const separators = [/\s+to\s+/i, /\s+through\s+/i, /\s+thru\s+/i]
  for (const sep of separators) {
    const parts = lower.split(sep)
    if (parts.length === 2) {
      const startDate = tryParseDate(parts[0].trim())
      if (startDate) {
        let endDate = tryParseDate(parts[1].trim())
        if (!endDate) {
          const numMatch = parts[1].trim().match(/^(\d{1,2})(?:st|nd|rd|th)?$/)
          if (numMatch) endDate = new Date(startDate.getFullYear(), startDate.getMonth(), parseInt(numMatch[1]))
        }
        if (endDate && isValid(endDate)) return { start: startDate, end: endDate }
      }
    }
  }

  // --- Single date tokens ---
  const tokens = lower.replace(/[,?!.]/g, '').split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const single = tryParseDate(tokens[i])
    if (single) return { start: single, end: single }
    if (i + 1 < tokens.length) {
      const pair = tryParseDate(`${tokens[i]} ${tokens[i + 1]}`)
      if (pair) return { start: pair, end: pair }
    }
  }

  return null
}

function getBalanceSummary(state: AppState): string {
  const v = state.profile.currentVacationHours
  const s = state.profile.currentSickHours
  const b = state.profile.currentBankHours
  return `You currently have **${fmt(v + s + b)} total hours** available:\n- Vacation: **${fmt(v)}** hrs\n- Sick: **${fmt(s)}** hrs\n- Bank: **${fmt(b)}** hrs`
}

function describeDateRange(start: Date, end: Date): string {
  if (start.getTime() === end.getTime()) return format(start, 'EEEE, MMM d')
  if (start.getMonth() === end.getMonth()) return `${format(start, 'MMM d')} – ${format(end, 'd')}`
  return `${format(start, 'MMM d')} – ${format(end, 'MMM d')}`
}

function analyzeRange(state: AppState, start: Date, end: Date) {
  const hoursPerDay = state.policy.hoursPerWorkDay
  const workDays = countWorkDays(start, end, state.policy)
  const needed = workDays * hoursPerDay

  // Build a hypothetical state that includes this proposed trip so the
  // shortfall check can see whether it would push other planned time off
  // into a deficit.
  const hypotheticalState: AppState = {
    ...state,
    plannedVacations: [
      ...state.plannedVacations,
      {
        id: '__chat_preview__',
        startDate: format(start, 'yyyy-MM-dd'),
        endDate: format(end, 'yyyy-MM-dd'),
        hourSource: 'any',
        locked: false,
        kind: 'planned',
      },
    ],
  }

  const projection = projectBalance(hypotheticalState, subDays(start, 1))
  const fitsAtStart = projection.totalAvailable >= needed

  const latestPlannedEnd = state.plannedVacations.reduce<Date>((latest, v) => {
    const e = parseISO(v.endDate)
    return e > latest ? e : latest
  }, end)
  const horizon =
    endOfYear(start) > latestPlannedEnd ? endOfYear(start) : latestPlannedEnd
  const fullProjection = projectBalance(hypotheticalState, horizon)
  const cumulativeShortfall = fullProjection.shortfall

  const affordable = fitsAtStart && cumulativeShortfall === 0
  const conflictsLater = fitsAtStart && cumulativeShortfall > 0
  const remaining = projection.totalAvailable - needed
  const earliest = !fitsAtStart ? earliestAffordableDate(state, needed, start) : null

  return {
    workDays,
    needed,
    projection,
    affordable,
    conflictsLater,
    cumulativeShortfall,
    remaining,
    earliest,
  }
}

export function processChat(input: string, state: AppState): ChatResponse {
  const lower = input.toLowerCase().trim().replace(/[?!]+$/, '').trim()
  const today = startOfDay(new Date())
  const hoursPerDay = state.policy.hoursPerWorkDay

  // --- Greetings ---
  if (/^(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening))\b/.test(lower)) {
    const total = state.profile.currentVacationHours + state.profile.currentSickHours + state.profile.currentBankHours
    return {
      text: `Hey! You have **${fmt(total)} hours** available. What would you like to plan?\n\nYou can ask things like:\n- "Can I take the second week of December off?"\n- "Book 4/15-4/17"\n- "How many sick days can I take?"`,
    }
  }

  // --- Help ---
  if (/\b(help|what\s+can|how\s+do|commands|options|what\s+do)\b/.test(lower)) {
    return {
      text: `I understand natural language! Try:\n\n**Planning:**\n- "Take off the second week of December"\n- "Book 4/15 through 4/17"\n- "I want next Friday off"\n- "Schedule a week in July"\n\n**Checking:**\n- "Can I afford a week off in September?"\n- "Do I have enough for 12/15-12/19?"\n- "What happens if I take 3 sick days?"\n\n**Info:**\n- "What's my balance?"\n- "Year-end projection"\n- "How many sick days can I take?"`,
    }
  }

  // --- "Tell me more about [dates]" ---
  if (/\b(tell\s+me\s+more|more\s+details|breakdown|explain)\b/.test(lower)) {
    const range = extractDateRange(lower)
    if (range) {
      const label = describeDateRange(range.start, range.end)
      const a = analyzeRange(state, range.start, range.end)
      let text = `**Details for ${label}:**\n\n- **${a.workDays} work day${a.workDays !== 1 ? 's' : ''}**, ${fmt(a.needed)} hrs needed\n- Projected balance on ${format(range.start, 'MMM d')}: **${fmt(a.projection.totalAvailable)} hrs**\n- After time off: **${fmt(a.remaining)} hrs** remaining`
      if (a.projection.vacationBalance > 0) text += `\n\nBreakdown: ${fmt(a.projection.vacationBalance)} vacation + ${fmt(a.projection.sickBalance)} sick + ${fmt(a.projection.bankBalance)} bank`
      if (!a.affordable && a.earliest) {
        text += `\n\nYou'd need to wait until **${format(a.earliest, 'MMM d')}** to have enough.`
      }
      return { text, action: a.affordable ? { type: 'plan_vacation', startDate: format(range.start, 'yyyy-MM-dd'), endDate: format(range.end, 'yyyy-MM-dd') } : undefined }
    }
  }

  // --- Balance ---
  if (/\b(balance|how\s+many\s+hours|how\s+much\s+do\s+i\s+have|what.*hours|my\s+hours|what.*balance)\b/.test(lower) && !/\bafford\b/.test(lower) && !/\bsick\b/.test(lower)) {
    const summary = getBalanceSummary(state)
    const hireDate = parseISO(state.profile.hireDate)
    const yos = differenceInYears(today, hireDate)
    const tier = computeAccrualTier(state.policy, yos)
    const monthly = (tier.hoursPerPayPeriod * 30) / state.policy.payPeriodLengthDays
    return { text: `${summary}\n\nYou're earning **${fmt(tier.hoursPerPayPeriod)} hrs** per pay period (~${fmt(monthly)} hrs/month) at the **${tier.label}** tier.` }
  }

  // --- Sick days ---
  if (/\bsick\b/.test(lower)) {
    const total = state.profile.currentVacationHours + state.profile.currentSickHours + state.profile.currentBankHours
    const plannedHours = state.plannedVacations
      .filter((v) => parseISO(v.endDate) >= today)
      .reduce((sum, v) => sum + countWorkDays(parseISO(v.startDate), parseISO(v.endDate), state.policy) * hoursPerDay, 0)
    const buffer = total - plannedHours
    const sickDays = Math.floor(Math.max(0, buffer) / hoursPerDay)

    if (/\b(what\s+if|what\s+happens|if\s+i\s+(take|get))\b/.test(lower)) {
      const numMatch = lower.match(/(\d+)\s*(?:sick|days?)/)
      const count = numMatch ? parseInt(numMatch[1]) : 2
      const sickHoursUsed = count * hoursPerDay
      const afterSick = buffer - sickHoursUsed
      if (afterSick >= 0) {
        return { text: `**${count} sick day${count !== 1 ? 's' : ''}** would use ${fmt(sickHoursUsed)} hrs, leaving **${fmt(afterSick)} hrs** of buffer above your planned time off.` }
      }
      return { text: `**${count} sick day${count !== 1 ? 's' : ''}** would put you **${fmt(Math.abs(afterSick))} hrs short** of covering your planned time off.` }
    }

    return {
      text: sickDays >= 1
        ? `Your current balance has room for about **${sickDays} sick day${sickDays !== 1 ? 's' : ''}** beyond your planned time off (**${fmt(buffer)} hrs** buffer).`
        : `Your planned time off accounts for nearly all of your available hours (**${fmt(buffer)} hrs** buffer).`,
    }
  }

  // --- Year-end ---
  if (/\b(year.?end|dec(ember)?\s+31|end\s+of\s+(the\s+)?year|eoy)\b/.test(lower)) {
    const yearEnd = endOfYear(today)
    const proj = projectBalance(state, yearEnd)
    const hireDate = parseISO(state.profile.hireDate)
    const yos = differenceInYears(today, hireDate)
    const tier = computeAccrualTier(state.policy, yos)
    const periodsPerYear = Math.round(365 / state.policy.payPeriodLengthDays)
    const cap = state.policy.carryoverCapStrategy === 'annual_accrual' ? tier.hoursPerPayPeriod * periodsPerYear
      : state.policy.carryoverCapStrategy === 'fixed_hours' ? (state.policy.carryoverFixedCap ?? 0) : null

    let text = `**Year-end projection (Dec 31):**\n- Vacation: **${fmt(proj.vacationBalance)} hrs**\n- Sick: **${fmt(proj.sickBalance)} hrs**\n- Bank: **${fmt(proj.bankBalance)} hrs**`
    if (cap !== null) {
      const surplus = proj.vacationBalance - cap
      if (surplus > 0) {
        text += `\n\nProjected to exceed the **${fmt(cap)} hr** carryover cap by **${fmt(surplus)} hrs**. Excess is paid out on the configured payout date.`
      } else {
        text += `\n\nProjected vacation is under the **${fmt(cap)} hr** carryover cap.`
      }
    }
    return { text }
  }

  // --- For everything else: try to extract dates first, then decide intent ---
  const range = extractDateRange(lower)
  const isQuestion = /\b(can\s+i|afford|enough|do\s+i\s+have|is\s+it\s+possible|able\s+to|will\s+i|would\s+i|could\s+i|should\s+i)\b/.test(lower)
  const isRequest = /\b(take\s+off|plan|schedule|book|i\s+want|i.?d\s+like|need|request|time\s+off|want\s+to|day\s+off|put\s+in|submit|use|block\s+off)\b/.test(lower) || /\bthe\s+day\b/.test(lower)

  if (range) {
    const label = describeDateRange(range.start, range.end)
    const a = analyzeRange(state, range.start, range.end)
    const action = {
      type: 'plan_vacation' as const,
      startDate: format(range.start, 'yyyy-MM-dd'),
      endDate: format(range.end, 'yyyy-MM-dd'),
    }

    if (isQuestion && !isRequest) {
      if (a.affordable) {
        return {
          text: `**Yes.** ${label} is **${a.workDays} work day${a.workDays !== 1 ? 's' : ''}** (${fmt(a.needed)} hrs). You'll have **${fmt(a.projection.totalAvailable)} hrs** available, leaving **${fmt(a.remaining)} hrs** after.`,
          action,
        }
      }
      if (a.conflictsLater) {
        return {
          text: `**Conflicts with later plans.** ${label} fits at the start (you'd have **${fmt(a.projection.totalAvailable)} hrs**, need **${fmt(a.needed)} hrs**) but adding it would leave you **${fmt(a.cumulativeShortfall)} hrs short** across your other planned time off.`,
        }
      }
      let text = `**Not enough hours.** ${label} needs **${fmt(a.needed)} hrs** (${a.workDays} days) but you'll only have **${fmt(a.projection.totalAvailable)} hrs** — **${fmt(Math.abs(a.remaining))} hrs short**.`
      if (a.earliest) {
        text += `\n\nYou'd have enough by **${format(a.earliest, 'MMM d, yyyy')}** (${differenceInDays(a.earliest, range.start)} days later).`
      }
      return { text }
    }

    if (a.affordable) {
      return {
        text: `**${label}** — ${a.workDays} work day${a.workDays !== 1 ? 's' : ''}, **${fmt(a.needed)} hrs** needed. You'll have **${fmt(a.projection.totalAvailable)} hrs** available (**${fmt(a.remaining)} hrs** remaining after).`,
        action,
      }
    }
    if (a.conflictsLater) {
      return {
        text: `**${label}** — fits at the start (**${fmt(a.projection.totalAvailable)} hrs** available, **${fmt(a.needed)} hrs** needed), but adding it would leave you **${fmt(a.cumulativeShortfall)} hrs short** for your other planned time off.`,
        action,
      }
    }
    let text = `**${label}** — ${a.workDays} work day${a.workDays !== 1 ? 's' : ''}, **${fmt(a.needed)} hrs** needed. You'd be **${fmt(Math.abs(a.remaining))} hrs short** (only ${fmt(a.projection.totalAvailable)} hrs available).`
    if (a.earliest) {
      text += ` You could afford it by **${format(a.earliest, 'MMM d')}**.`
    }
    return { text, action }
  }

  if (isRequest || isQuestion) {
    return {
      text: `I'd love to help with that! I couldn't figure out the specific dates though. I understand:\n\n- **"the second week of December"**\n- **"4/15 to 4/17"** or **"April 15-17"**\n- **"next Friday"** or **"tomorrow"**\n- **"a week in July"**\n- **"Wednesday through Friday"**\n\nCould you rephrase with dates?`,
    }
  }

  // --- General conversation / thanks / acknowledgement ---
  if (/\b(thanks|thank\s+you|thx|ty|appreciate|great|perfect|awesome|cool|nice|ok|okay|got\s+it|sounds\s+good)\b/.test(lower)) {
    return { text: `You're welcome! Let me know if you need anything else — I'm here to help with planning, balance checks, or anything time-off related.` }
  }

  if (/\b(bye|goodbye|see\s+ya|later|done|that.?s\s+all)\b/.test(lower)) {
    return { text: `Happy planning! Come back anytime you need help. Have a great day!` }
  }

  // --- True fallback ---
  return {
    text: `I'm here to help with time-off planning! I can:\n\n- **Plan time off** — "I want to take off the second week of December"\n- **Check affordability** — "Can I afford a week in September?"\n- **Answer questions** — "How many sick days can I take?"\n- **Project ahead** — "What's my year-end balance?"\n- **Quick info** — "What's my balance?"\n\nJust describe what you need in plain language!`,
  }
}
