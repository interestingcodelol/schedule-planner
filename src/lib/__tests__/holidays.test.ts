import { describe, expect, it } from 'vitest'
import { format } from 'date-fns'
import { computeHolidayDates, formatHolidayRule, getHolidayName } from '../holidays'
import { defaultPolicy } from '../defaultPolicy'
import { countWorkDays } from '../projection'

const iso = (d: Date) => format(d, 'yyyy-MM-dd')
const day = (s: string) => new Date(`${s}T00:00:00`)
const datesFor = (year: number) => computeHolidayDates(defaultPolicy, year).map(iso)

/** New Year's Day of `year` observed on Dec 31 of the year before? */
const nydSpillsBack = (year: number) => new Date(year, 0, 1).getDay() === 6

describe('holiday observance across year boundaries', () => {
  it('keeps both Christmas Eve and Christmas Day in 2027 (Dec 25 is a Saturday)', () => {
    const dates = datesFor(2027)
    expect(dates).toContain('2027-12-23')
    expect(dates).toContain('2027-12-24')
    expect(getHolidayName(defaultPolicy, day('2027-12-23'))).toBe('Christmas Day')
    expect(getHolidayName(defaultPolicy, day('2027-12-24'))).toBe('Christmas Eve')
  })

  it('keeps both Christmas Eve and Christmas Day in 2028 (Dec 24 is a Sunday)', () => {
    const dates = datesFor(2028)
    expect(dates).toContain('2028-12-25')
    expect(dates).toContain('2028-12-26')
    expect(getHolidayName(defaultPolicy, day('2028-12-25'))).toBe('Christmas Day')
    expect(getHolidayName(defaultPolicy, day('2028-12-26'))).toBe('Christmas Eve')
  })

  it("observes New Year's Day 2028 (Saturday) on Fri Dec 31, 2027", () => {
    expect(datesFor(2027)).toContain('2027-12-31')
    expect(datesFor(2028)).not.toContain('2028-01-01')
    expect(datesFor(2028)).not.toContain('2027-12-31')
    expect(getHolidayName(defaultPolicy, day('2027-12-31'))).toBe("New Year's Day")
    expect(getHolidayName(defaultPolicy, day('2028-01-01'))).toBeUndefined()
  })

  it('a Dec 2027 – Jan 2028 week off only charges the real workdays', () => {
    // Dec 20–31 2027: 10 weekdays, minus Dec 23, 24 and 31 = 7 workdays.
    expect(countWorkDays(day('2027-12-20'), day('2027-12-31'), defaultPolicy)).toBe(7)
    // Dec 27 2027 – Jan 7 2028: 10 weekdays, minus Dec 31 = 9.
    expect(countWorkDays(day('2027-12-27'), day('2028-01-07'), defaultPolicy)).toBe(9)
  })

  it('never loses a holiday in any year', () => {
    for (let year = 2022; year <= 2045; year++) {
      const count = computeHolidayDates(defaultPolicy, year).length
      const expected =
        defaultPolicy.holidays.length - (nydSpillsBack(year) ? 1 : 0) + (nydSpillsBack(year + 1) ? 1 : 0)
      expect({ year, count }).toEqual({ year, count: expected })
      // Every holiday lands on a weekday.
      for (const d of computeHolidayDates(defaultPolicy, year)) {
        expect([0, 6]).not.toContain(d.getDay())
      }
    }
  })

  it('puts the day after Thanksgiving on the Friday after Thanksgiving, even when Nov 1 is a Friday', () => {
    // 2024 and 2030: November starts on a Friday, so the 4th Friday is Nov 22,
    // a week before Thanksgiving.
    expect(datesFor(2024)).toEqual(expect.arrayContaining(['2024-11-28', '2024-11-29']))
    expect(datesFor(2024)).not.toContain('2024-11-22')
    expect(datesFor(2030)).toEqual(expect.arrayContaining(['2030-11-28', '2030-11-29']))
    expect(datesFor(2027)).toEqual(expect.arrayContaining(['2027-11-25', '2027-11-26']))
    const rule = defaultPolicy.holidays.find((h) => h.name === 'Day after Thanksgiving')!
    expect(formatHolidayRule(rule)).toBe('Day after Thanksgiving (Fri after 4th Thu in Nov)')
  })

  it('still dedupes a duplicated rule on the same real date', () => {
    const policy = {
      ...defaultPolicy,
      holidays: [...defaultPolicy.holidays, { ...defaultPolicy.holidays[5], name: 'Duplicate July 4' }],
    }
    expect(computeHolidayDates(policy, 2026)).toHaveLength(computeHolidayDates(defaultPolicy, 2026).length)
  })
})
