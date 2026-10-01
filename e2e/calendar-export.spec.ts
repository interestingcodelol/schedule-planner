import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { defaultPolicy } from '../src/lib/defaultPolicy'
import type { AppState } from '../src/lib/types'

for (const invalidTime of [false, true]) {
  test(`calendar snapshot ${invalidTime ? 'reports nonexistent clock time without marking exported' : 'downloads saved clock interval with safe refresh guidance'}`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-30T15:00:00Z') })
    const state: AppState = {
      version: 2, theme: 'dark', showTour: false,
      profile: { displayName: 'Synthetic calendar QA', hireDate: '2021-10-05', currentVacationHours: 40, currentSickHours: 20, currentBankHours: 0, lastPaydayDate: '2026-09-25', lastSyncDate: '2026-09-30', timezone: 'America/New_York', backupRemindersDisabled: true },
      policy: { ...defaultPolicy }, bankHoursLog: [],
      plannedVacations: [{ id: 'calendar-fixture', startDate: invalidTime ? '2027-03-14' : '2026-10-20', endDate: invalidTime ? '2027-03-14' : '2026-10-20', hoursPerDay: 2, timeOffStart: invalidTime ? '02:30' : '10:00', timeOffEnd: invalidTime ? '04:30' : '12:00', hourSource: 'vacation', locked: false, note: 'Synthetic appointment' }],
    }
    await page.addInitScript((value) => {
      if (!localStorage.getItem('schedule-planner-state-v2')) localStorage.setItem('schedule-planner-state-v2', JSON.stringify(value))
    }, state)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('./')
    await page.getByRole('button', { name: 'Open settings', exact: true }).click()
    await page.getByRole('button', { name: 'Data', exact: true }).click()
    await expect(page.getByText(/Importing again may create duplicates/)).toBeVisible()
    await expect(page.getByText(/Never clear a calendar containing other appointments/)).toBeVisible()
    if (invalidTime) {
      await page.getByRole('button', { name: 'Export to calendar (.ics)', exact: true }).click()
      await expect(page.getByText(/does not exist in America\/New_York/)).toBeVisible()
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('schedule-planner-state-v2')!).profile.lastExportDate)).toBeUndefined()
    } else {
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export to calendar (.ics)', exact: true }).click()
      const file = await download
      const contents = await readFile((await file.path())!, 'utf8')
      const event = contents.split('BEGIN:VEVENT').find((entry) => entry.includes('UID:vacation-calendar-fixture@'))!
      expect(event).toContain('DTSTART:20261020T140000Z')
      expect(event).toContain('DTEND:20261020T160000Z')
      expect(event).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:FALSE')
      expect(event).toContain('X-MICROSOFT-CDO-BUSYSTATUS:OOF')
      const paydays = contents.replace(/\r\n /g, '').split('BEGIN:VEVENT')
      const anniversaryPayday = paydays.find((entry) => entry.includes('UID:payday-20261009@'))!
      expect(anniversaryPayday).toContain('SUMMARY:💰 Payday (+3.52 hrs vacation)')
      expect(anniversaryPayday).toContain('Vacation accrual: +3.52 hrs.')
      const followingPayday = paydays.find((entry) => entry.includes('UID:payday-20261023@'))!
      expect(followingPayday).toContain('SUMMARY:💰 Payday (+4.62 hrs vacation)')
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('schedule-planner-state-v2')!).profile.currentVacationHours)).toBe(40)
      await expect(page.getByText(/Calendar snapshot exported/)).toBeVisible()
    }
    expect(errors).toEqual([])
  })
}
