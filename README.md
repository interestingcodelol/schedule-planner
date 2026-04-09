# Leave Lens

A personal PTO and vacation planning tool that projects your vacation accrual forward in time and lets you plan time off against that projection.

![Leave Lens Screenshot](/docs/screenshot.png)

## Why this exists

Many employers use timecard systems that track vacation accrual balances but offer no forward-looking planning view. You can see "you have 47.3 hours today" but cannot easily answer:

- "If I take the week of September 15 off, will I have enough hours by then?"
- "What will my balance be on December 31?"
- "Am I going to lose hours to the carryover cap?"

Leave Lens solves this by letting you input your current balance, hire date, and accrual rules, then projects balances forward day-by-day across a calendar view where you can plan time off interactively.

## Features

- **Forward projection** — see your projected balance on any future date
- **Interactive calendar** — click days to plan time off, hover for balance tooltips
- **What-if planner** — check trip affordability before committing
- **Accrual tier tracking** — handles tier transitions based on years of service
- **Carryover cap warnings** — alerts when you might lose hours
- **Holiday awareness** — deducts only actual work days from planned vacations
- **Fully customizable** — accrual tiers, rates, holidays, pay periods, work schedule
- **Dark mode** — refined dark-first aesthetic
- **Import/Export** — backup and restore your data as JSON
- **Guided tour** — first-run walkthrough of all features
- **Privacy-first** — all data stays in your browser, nothing is sent anywhere

## Tech stack

- Vite + React + TypeScript
- Tailwind CSS
- date-fns for date math
- lucide-react for icons
- Vitest + React Testing Library for tests

## Quick start

```bash
git clone <repo-url>
cd leave-lens
npm install
npm run dev       # start dev server
npm test          # run tests
npm run build     # production build
```

## How the projection works

The projection engine (`src/lib/projection.ts`) is a pure function with no side effects:

1. **Start** from your current vacation balance as of today
2. **Generate pay period boundaries** from your last payday forward to the target date
3. **Accrue hours** on each payday based on your current tier (determined by years since hire date)
4. **Deduct hours** for each planned vacation day that falls on a work day (excluding weekends and holidays)
5. **Apply carryover cap** on the payout date (e.g., Feb 1) — hours above the cap are forfeited

Tier transitions take effect on the first payday that falls on or after your service anniversary date.

## Customizing for your employer

Open **Settings > Policy** to customize:

- **Accrual tiers** — add/remove tiers, set hours per pay period for each tenure range
- **Pay period** — set the length in days (14 for bi-weekly, 7 for weekly, etc.)
- **Carryover** — choose annual accrual cap, fixed hours cap, or unlimited
- **Work schedule** — select which days of the week are work days
- **Holidays** — add/remove holidays with fixed-date, nth-weekday, or last-weekday rules
- **Hours per day** — default is 8, adjust for your schedule

The defaults represent a common US employer policy pattern and are not specific to any company.

## Privacy

All data is stored in your browser's localStorage. Nothing is sent to any server, API, or third-party service. There is no analytics, tracking, or telemetry of any kind.

To move your data between browsers, use the Export/Import feature in Settings.

## License

MIT — see [LICENSE](LICENSE)
