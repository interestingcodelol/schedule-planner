import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { defaultPolicy } from '../src/lib/defaultPolicy'
import type { AppState } from '../src/lib/types'

function fixture(): AppState {
  return {
    profile: { displayName: 'Visual QA fixture', hireDate: '2023-01-01', currentVacationHours: 62.3, currentSickHours: 32, currentBankHours: 4.75, lastPaydayDate: '2026-09-25', lastSyncDate: '2026-09-29', timezone: 'UTC', backupRemindersDisabled: true },
    policy: { ...defaultPolicy },
    plannedVacations: [{ id: 'today-fixture', startDate: '2026-09-29', endDate: '2026-09-29', hourSource: 'any', locked: false, note: 'Synthetic time off for visual verification' }],
    bankHoursLog: [], theme: 'dark', showTour: false, version: 2,
  }
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' })
  const widths = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }))
  expect(widths.content, `${name} must not overflow horizontally`).toBeLessThanOrEqual(widths.viewport + 1)
}
async function seed(page: Page, legacy = false) {
  await page.clock.install({ time: new Date('2026-09-29T15:00:00Z') })
  await page.addInitScript(({ state, old }) => {
    const key = old ? 'schedule-planner-state-v1' : 'schedule-planner-state-v2'
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state))
  }, { state: { ...fixture(), version: legacy ? 1 : 2 }, old: legacy })
}

test('balance, editing, dialog, bank, planner and chat visual smoke', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await seed(page)
  await page.goto('/')
  await expect(page.getByLabel('Available now: 91.05 hours')).toBeVisible()
  await expect(page.getByRole('button', { name: /Bank hours: 0 hours/ })).toBeVisible()
  await expect(page.getByText('8 hrs used today, already included')).toBeVisible()
  await capture(page, info, '01-dashboard')
  await page.locator('summary').filter({ hasText: 'Balance details' }).click()
  await expect(page.getByRole('table')).toBeVisible()
  await capture(page, info, '02-balance-details')
  await page.getByRole('button', { name: /September 29, 2026, today, planned time off/ }).click()
  const editor = page.getByRole('dialog', { name: 'Plan time off for September 29' })
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: 'Partial Day', exact: true }).click()
  await capture(page, info, '03-partial-day-dialog')
  await editor.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByLabel('Available now: 95.05 hours')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Available now: 95.05 hours')).toBeVisible()
  await page.getByRole('button', { name: /Bank hours: 0.75 hours/ }).click()
  await expect(page.getByPlaceholder('Hours', { exact: true })).toBeVisible()
  await capture(page, info, '04-bank-management')
  await page.getByRole('button', { name: /Bank hours: 0.75 hours/ }).click()
  await page.getByLabel('Start', { exact: true }).fill('2026-10-01')
  await page.getByLabel('End', { exact: true }).fill('2026-10-02')
  await page.getByLabel('Hrs/day', { exact: true }).fill('2.25')
  await expect(page.getByText('Yes — affordable', { exact: true })).toBeVisible()
  await capture(page, info, '05-quarter-day-planner')
  await page.getByRole('button', { name: 'Plan time off with the assistant' }).click()
  await expect(page.getByRole('dialog', { name: 'Plan time off assistant' })).toBeVisible()
  await page.getByPlaceholder('e.g. "take off July 14-18"').fill("what's my balance?")
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(/You currently have/)).toBeVisible()
  await capture(page, info, '06-chat-current-balance')
  await page.getByRole('button', { name: 'Close chat' }).click()
  await expect(page.getByRole('dialog', { name: 'Plan time off assistant' })).not.toBeVisible()
  expect(errors).toEqual([])
})

test('legacy migration and backup settings are safe and reviewable', async ({ page }, info) => {
  await seed(page, true)
  await page.goto('/')
  await expect(page.getByLabel('Available now: 91.05 hours')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Available now: 91.05 hours')).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await capture(page, info, '07-profile-settings')
  await page.getByRole('button', { name: 'Data', exact: true }).click()
  await capture(page, info, '08-backup-settings')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup (JSON)', exact: true }).click()
  const download = await pending
  const file = info.outputPath('synthetic-v2-backup.json')
  await download.saveAs(file)
  const backup = JSON.parse(await readFile(file, 'utf8'))
  expect(backup._schemaVersion).toBe(2)
  expect(backup.state.version).toBe(2)
  expect(backup.state.plannedVacations[0].appliedDeductions).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused()
})
