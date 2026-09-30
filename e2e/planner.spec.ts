import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { defaultPolicy } from '../src/lib/defaultPolicy'
import type { AppState } from '../src/lib/types'

function fixture(): AppState {
  return {
    profile: {
      displayName: 'Visual QA fixture',
      hireDate: '2023-01-01',
      currentVacationHours: 62.3,
      currentSickHours: 32,
      currentBankHours: 4.75,
      lastPaydayDate: '2026-09-25',
      lastSyncDate: '2026-09-29',
      timezone: 'UTC',
      backupRemindersDisabled: true,
    },
    policy: { ...defaultPolicy },
    plannedVacations: [
      {
        id: 'today-fixture',
        startDate: '2026-09-29',
        endDate: '2026-09-29',
        hourSource: 'any',
        locked: false,
        note: 'Synthetic time off for visual verification',
      },
      {
        id: 'future-fixture',
        startDate: '2026-10-05',
        endDate: '2026-10-09',
        hourSource: 'vacation',
        locked: false,
        note: 'Example vacation',
      },
      {
        id: 'appointment-fixture',
        startDate: '2026-10-19',
        endDate: '2026-10-19',
        hoursPerDay: 2.25,
        hourSource: 'vacation',
        locked: false,
        note: 'Example appointment',
      },
    ],
    bankHoursLog: [],
    theme: 'dark',
    showTour: false,
    version: 2,
  }
}
async function capture(page: Page, info: TestInfo, name: string) {
  const viewportOnly = /dialog|chat|settings/.test(name)
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: !viewportOnly,
    animations: 'disabled',
  })
  const widths = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  expect(widths.content, `${name} must not overflow horizontally`).toBeLessThanOrEqual(
    widths.viewport + 1,
  )
}
async function seed(page: Page, legacy = false) {
  await page.clock.install({ time: new Date('2026-09-29T15:00:00Z') })
  await page.addInitScript(
    ({ state, old }) => {
      const key = old ? 'schedule-planner-state-v1' : 'schedule-planner-state-v2'
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state))
    },
    { state: { ...fixture(), version: legacy ? 1 : 2 }, old: legacy },
  )
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
  if (info.project.name === 'mobile-360') {
    const bounds = await page.getByLabel('Off from', { exact: true }).boundingBox()
    expect(bounds?.width).toBeGreaterThan(200)
  }
  const editorBounds = await editor.boundingBox()
  expect(editorBounds?.y).toBeGreaterThanOrEqual(0)
  expect((editorBounds?.y ?? 0) + (editorBounds?.height ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  )
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
  await page.getByRole('button', { name: 'Next month', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible()
  await capture(page, info, '10-next-month-planning')
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
  await settings
    .getByRole('button', { name: 'Clear all data', exact: true })
    .scrollIntoViewIfNeeded()
  await expect(settings.getByRole('button', { name: 'Clear all data', exact: true })).toBeVisible()
  await capture(page, info, '09-settings-bottom-reachable')
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused()
})

// Compare the original production layout and revised branch with identical data,
// browser, date and viewport. No production data or production writes are used.
test('compact layout matches original density', async ({ page, browser }, info) => {
  test.skip(!process.env.BASELINE_URL, 'Original build is supplied by visual CI')
  await seed(page)
  await page.goto('/')
  await expect(page.getByLabel('Available now: 91.05 hours')).toBeVisible()
  const measure = (p: Page) =>
    p.evaluate(() => {
      const top = document.querySelector('[data-tour="status-cards"]')!.getBoundingClientRect()
      const calendar = document.querySelector('[data-tour="calendar"]')!.getBoundingClientRect()
      return {
        topBlockHeight: top.height,
        calendarTop: calendar.top,
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        viewportHeight: innerHeight,
      }
    })
  const revised = await measure(page)
  const sizes = await page.getByTestId('balance-card-grid').evaluate((el) =>
    Array.from(el.children).map((card) => ({
      width: card.getBoundingClientRect().width,
      height: card.getBoundingClientRect().height,
    })),
  )
  const equalWidthCards = info.project.name === 'desktop' ? sizes : sizes.slice(1)
  expect(
    Math.max(...equalWidthCards.map((s) => s.width)) -
      Math.min(...equalWidthCards.map((s) => s.width)),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.max(...sizes.map((s) => s.height)) - Math.min(...sizes.map((s) => s.height)),
  ).toBeLessThanOrEqual(1)
  await page.screenshot({
    path: info.outputPath('compact-revised-viewport.png'),
    animations: 'disabled',
  })
  await capture(page, info, 'compact-revised-full')
  const originalContext = await browser.newContext({
    viewport: page.viewportSize()!,
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  })
  const original = await originalContext.newPage()
  await seed(original, true)
  await original.goto(process.env.BASELINE_URL!)
  await expect(original.locator('[data-tour="status-cards"]')).toBeVisible()
  const baseline = await measure(original)
  await original.screenshot({
    path: info.outputPath('compact-original-viewport.png'),
    animations: 'disabled',
  })
  await capture(original, info, 'compact-original-full')
  await writeFile(
    info.outputPath('layout-measurements.json'),
    JSON.stringify({ original: baseline, revised, cards: sizes }, null, 2),
  )
  if (info.project.name === 'desktop') {
    // The inline deduction explanation is the only additional row.
    expect(revised.topBlockHeight).toBeLessThanOrEqual(baseline.topBlockHeight + 40)
    expect(revised.calendarTop).toBeLessThanOrEqual(baseline.calendarTop + 40)
    expect(revised.topBlockHeight).toBeLessThan(160)
  }
  await originalContext.close()
})

test('viewport and accessible reflow audit', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'Run the viewport matrix once')
  test.setTimeout(180_000)
  const matrix = [
    { name: 'laptop-1366x768', width: 1366, height: 768 },
    { name: 'desktop-1440x900', width: 1440, height: 900 },
    { name: 'desktop-1920x1080', width: 1920, height: 1080 },
    { name: 'tablet-768x1024', width: 768, height: 1024 },
    { name: 'phone-360x800', width: 360, height: 800 },
    { name: 'phone-390x844', width: 390, height: 844 },
    // Equivalent CSS viewport reflow at 125%/200% on a 1366x768 display.
    // This is not browser-chrome zoom or a claim of real-device coverage.
    { name: 'reflow-125percent', width: 1093, height: 614 },
    { name: 'reflow-200percent', width: 683, height: 384 },
  ]
  const measurements = []
  for (const size of matrix) {
    const context = await browser.newContext({
      viewport: size,
      timezoneId: 'UTC',
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    await seed(page)
    await page.goto('/')
    await expect(page.getByLabel('Available now: 91.05 hours')).toBeVisible()
    const dimensions = await page.evaluate(() => {
      const rect = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height }
      }
      const nestedScroll = Array.from(document.querySelectorAll('main *'))
        .filter((el) => {
          const style = getComputedStyle(el)
          return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
        })
        .map((el) => ({
          tag: el.tagName,
          label: el.getAttribute('aria-label'),
          height: el.clientHeight,
          scrollHeight: el.scrollHeight,
        }))
      return {
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        calendar: rect('[data-tour="calendar"]'),
        planner: rect('[data-tour="planner"]'),
        nestedScroll,
      }
    })
    measurements.push({ name: size.name, ...dimensions })
    expect(dimensions.documentWidth, `${size.name} horizontal overflow`).toBeLessThanOrEqual(
      size.width + 1,
    )
    expect(dimensions.nestedScroll, `${size.name} dashboard nested scrolling`).toEqual([])
    await page.screenshot({
      path: info.outputPath(`${size.name}-dashboard.png`),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: /Bank hours: 0 hours/ }).click()
    const bankInput = page.getByPlaceholder('Hours', { exact: true })
    await expect(bankInput).toBeVisible()
    const bankBounds = await bankInput.locator('..').locator('..').boundingBox()
    expect(bankBounds!.x).toBeGreaterThanOrEqual(0)
    expect(bankBounds!.x + bankBounds!.width).toBeLessThanOrEqual(size.width + 1)
    await page.screenshot({
      path: info.outputPath(`${size.name}-bank.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Next month', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible()
    await page.screenshot({
      path: info.outputPath(`${size.name}-populated.png`),
      animations: 'disabled',
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Open settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: 'Data', exact: true }).click()
    const clear = settings.getByRole('button', { name: 'Clear all data', exact: true })
    await clear.focus()
    await expect(clear).toBeInViewport()
    const bounds = await settings.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width + 1)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1)
    await page.screenshot({
      path: info.outputPath(`${size.name}-settings-bottom.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(settings).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused()
    await context.close()
  }
  await writeFile(
    info.outputPath('viewport-measurements.json'),
    JSON.stringify(measurements, null, 2),
  )
})
