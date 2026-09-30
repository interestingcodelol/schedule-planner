import { test, expect } from '@playwright/test'
import { defaultPolicy } from '../src/lib/defaultPolicy'
import type { AppState } from '../src/lib/types'

// Every Playwright test gets a disposable browser context. These records are
// synthetic, including when the same smoke test targets the public release.
const fixture = (savedAt: number, name: string): AppState => ({
  version: 1,
  savedAt,
  theme: 'dark',
  showTour: false,
  profile: {
    displayName: name,
    hireDate: '2023-01-01',
    currentVacationHours: 45.25,
    currentSickHours: 18,
    currentBankHours: 3.5,
    lastPaydayDate: '2026-09-25',
    lastSyncDate: '2026-09-30',
    timezone: 'UTC',
    backupRemindersDisabled: true,
    backupReminderDays: 21,
  },
  policy: {
    ...defaultPolicy,
    carryoverCapStrategy: 'fixed_hours',
    carryoverFixedCap: 123,
    holidays: [...defaultPolicy.holidays],
    hoursPerWorkDay: 7.5,
  },
  plannedVacations: [
    {
      id: 'preserved-future',
      startDate: '2026-10-20',
      endDate: '2026-10-20',
      hoursPerDay: 2.25,
      hourSource: 'vacation',
      locked: true,
      note: 'Synthetic saved appointment',
    },
    {
      id: 'preserved-past',
      startDate: '2026-09-28',
      endDate: '2026-09-28',
      actualHoursUsed: 1.5,
      hourSource: 'sick',
      kind: 'logged_past',
      locked: false,
      note: 'Synthetic saved absence',
      debitedFrom: { vacation: 0, sick: 1.5, bank: 0 },
    },
  ],
  bankHoursLog: [
    {
      id: 'preserved-bank',
      date: '2026-09-28',
      hours: 3.5,
      note: 'Synthetic saved extra hours',
      appliedToBalance: true,
    },
  ],
  catchUpHistory: [],
})

test('published build identifies the deployed commit', async ({ request }) => {
  test.skip(!process.env.EXPECTED_RELEASE_SHA, 'Commit identity is verified after Pages deployment')
  await expect
    .poll(
      async () => {
        const response = await request.get(`./version.json?verification=${Date.now()}`)
        return response.ok() ? (await response.json()).commit : null
      },
      { timeout: 120_000, intervals: [2000, 5000, 10000] },
    )
    .toBe(process.env.EXPECTED_RELEASE_SHA)
})

for (const winner of ['local', 'indexeddb'] as const) {
  test(`release migration preserves newest ${winner} snapshot and legacy originals`, async ({
    page,
  }, info) => {
    await page.clock.install({ time: new Date('2026-09-30T15:00:00Z') })
    await page.goto('./')
    const local = fixture(winner === 'local' ? 200 : 100, 'Synthetic local user')
    const idb = fixture(winner === 'indexeddb' ? 200 : 100, 'Synthetic IndexedDB user')
    const expected = winner === 'local' ? local : idb
    await page.evaluate(
      async ({ local, idb }) => {
        localStorage.setItem('schedule-planner-state-v1', JSON.stringify(local))
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('schedule-planner', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('state')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('state', 'readwrite')
            tx.objectStore('state').put(idb, 'app-state')
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onerror = () => reject(tx.error)
          }
        })
      },
      { local, idb },
    )
    await page.reload()
    await expect(page.getByLabel('Available now: 66.75 hours')).toBeVisible()
    const assertPreserved = async () => {
      const stored = await page.evaluate(async () => {
        const legacyIdb = await new Promise<unknown>((resolve, reject) => {
          const request = indexedDB.open('schedule-planner', 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const read = db.transaction('state', 'readonly').objectStore('state').get('app-state')
            read.onsuccess = () => {
              db.close()
              resolve(read.result)
            }
            read.onerror = () => reject(read.error)
          }
        })
        return {
          current: JSON.parse(localStorage.getItem('schedule-planner-state-v2')!),
          legacyLocal: localStorage.getItem('schedule-planner-state-v1'),
          legacyIdb,
        }
      })
      expect(stored.current.profile).toEqual(expected.profile)
      expect(stored.current.policy).toEqual(expected.policy)
      expect(stored.current.bankHoursLog).toEqual(expected.bankHoursLog)
      expect(stored.current.plannedVacations).toEqual(
        expected.plannedVacations.map((v) => ({ ...v, kind: v.kind ?? 'planned' })),
      )
      expect(stored.current.theme).toBe(expected.theme)
      expect(stored.current.version).toBe(2)
      expect(stored.legacyLocal).toBe(JSON.stringify(local))
      expect(stored.legacyIdb).toEqual(idb)
    }
    await assertPreserved()
    await page.reload()
    await expect(page.getByLabel('Available now: 66.75 hours')).toBeVisible()
    await assertPreserved()
    await page.screenshot({ path: info.outputPath(`migration-${winner}.png`), fullPage: true })
  })
}

test('unreadable saved data stays intact and does not open setup', async ({ page }, info) => {
  await page.goto('./')
  const raw = '{"version":2,"profile":{"displayName":"Synthetic damaged record"'
  await page.evaluate((raw) => localStorage.setItem('schedule-planner-state-v2', raw), raw)
  await page.reload()
  await expect(page.getByText('Your saved planner needs attention')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('schedule-planner-state-v2'))).toBe(raw)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Your saved planner needs attention')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('schedule-planner-state-v2'))).toBe(raw)
  await page.screenshot({ path: info.outputPath('preserved-data-recovery.png'), fullPage: true })
})

test('legacy backup file remains restorable with records and custom policy', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T15:00:00Z') })
  await page.goto('./')
  await page.evaluate(
    (state) => localStorage.setItem('schedule-planner-state-v1', JSON.stringify(state)),
    fixture(100, 'Synthetic initial data'),
  )
  await page.reload()
  await expect(page.getByLabel('Available now: 66.75 hours')).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()
  const backup = fixture(50, 'Synthetic restored legacy backup')
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('input[type="file"]').setInputFiles({
    name: 'synthetic-legacy-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('schedule-planner-state-v2')!).profile.displayName,
      ),
    )
    .toBe(backup.profile.displayName)
  const restored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('schedule-planner-state-v2')!),
  )
  expect(restored.profile).toEqual(backup.profile)
  expect(restored.policy).toEqual(backup.policy)
  expect(restored.bankHoursLog).toEqual(backup.bankHoursLog)
  expect(restored.plannedVacations.map((v: { id: string }) => v.id)).toEqual(
    backup.plannedVacations.map((v) => v.id),
  )
  await page.reload()
  await expect(page.getByLabel('Available now: 66.75 hours')).toBeVisible()
})

test('temporary database failure does not promote an older local snapshot', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T15:00:00Z') })
  await page.goto('./')
  const original = JSON.stringify(fixture(100, 'Synthetic protected legacy data'))
  await page.evaluate((raw) => {
    localStorage.setItem('schedule-planner-state-v1', raw)
    sessionStorage.setItem('synthetic-idb-failure', 'yes')
  }, original)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('synthetic-idb-failure')) {
      indexedDB.open = () => {
        throw new DOMException('Synthetic read failure', 'UnknownError')
      }
    }
  })
  await page.reload()
  await expect(page.getByText('Your saved planner needs attention')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('schedule-planner-state-v1'))).toBe(
    original,
  )
  expect(await page.evaluate(() => localStorage.getItem('schedule-planner-state-v2'))).toBeNull()
  expect(
    await page.evaluate(() => localStorage.getItem('schedule-planner-v2-initialized')),
  ).toBeNull()
  await page.evaluate(() => sessionStorage.removeItem('synthetic-idb-failure'))
  await page.reload()
  await expect(page.getByLabel('Available now: 66.75 hours')).toBeVisible()
})
