# Schedule Planner

A browser-based PTO and vacation accrual planner. Track vacation, sick, and bank hours, project balances forward, and plan time off with an interactive calendar. All data stays in your browser.

**Live demo:** [interestingcodelol.github.io/schedule-planner](https://interestingcodelol.github.io/schedule-planner/)

## Why this exists

Many employers use timecard systems that track vacation accrual balances but offer no forward-looking planning view. You can see "you have 47.3 hours today" but cannot easily answer:

- "If I take the week of September 15 off, will I have enough hours by then?"
- "What will my balance be on December 31?"
- "Am I going to lose hours to the carryover cap?"

Schedule Planner solves this by projecting your balances forward day-by-day — accounting for accruals, planned time off, bank hours payouts, sick leave grants, and carryover caps — so you can plan with confidence.

## Features

- **Forward projection** — see your projected balance on any future date across all pools (vacation, sick, bank)
- **Balance Forecast chart** — compact visual of your total balance from today through year-end with carryover-cap overlay; hover any week to read the projected balance
- **Interactive calendar** — click days to plan time off, each day shows projected total balance
- **15-minute partial days** — schedule appointments down to quarter-hour precision (e.g. 10:00–11:45)
- **Timezone-aware "today"** — same-day time off doesn't deduct from your available hours until after your local end-of-work-day, since timecards are filed at end of day
- **Reconcile past entries** — click any past planned day to record the *actual* hours used (e.g. scheduled 8h but only took 5h), with the difference auto-credited back to the right pool
- **Log unscheduled past absences** — click any past day to retroactively log a sick day; deducts from the matching pool and stays in sync with your timecard system
- **Month picker** — click the month title to jump to any month/year instantly
- **What-if planner** — check trip affordability before committing, with a clear yes/no panel and earliest-affordable date suggestion
- **Upcoming events dropdown** — top-bar pill showing the next planned time off plus a click-to-expand list of all future entries, holidays, and paydays
- **Accrual tier tracking** — handles tier transitions based on years of service
- **Carryover cap warnings** — alerts when vacation might exceed cap at year-end, plus an at-risk band on the forecast chart
- **Holiday awareness** — 12 US federal holidays computed by formula, correct for any year
- **Bank hours** — track extra hours worked, with history view and undo on delete
- **Sick leave** — annual grant with carryover cap and max-balance cap, projected across years
- **Bank hours payout** — dual payout dates (e.g. Dec and Feb), balance zeros and resets
- **Chat assistant** — plan time off with natural language
- **Fully customizable** — accrual tiers, rates, holidays, pay periods, work schedule, timezone
- **Responsive layout** — reflows cleanly from mobile (360 px) up to ultra-wide
- **Dark mode** — refined dark-first aesthetic with blue/teal GIS-inspired theme
- **Import/Export** — backup and restore your data as JSON
- **Guided tour** — spotlight walkthrough of all features
- **Auto-update** — gentle banner when a new version is deployed, no data loss
- **Privacy-first** — all data stays in your browser (localStorage + IndexedDB, with JSON export for real backups), nothing is sent anywhere

## Tech stack

- Vite + React 19 + TypeScript (strict mode)
- Tailwind CSS v4
- date-fns for date math
- lucide-react for icons
- Vitest + React Testing Library for tests

## How the projection works

The projection engine (`src/lib/projection.ts`) is a pure function that processes events chronologically:

1. **Start** from current balances (vacation, sick, bank) as of today
2. **Generate events** — paydays (accruals), planned vacation deductions, carryover adjustments, bank hour payouts, annual sick leave grants
3. **Sort chronologically** with deterministic ordering for same-day events
4. **Process each event** updating the appropriate balance pool
5. **Return** final balances, event trail, and totals

Key behaviors:
- **Tier transitions** take effect on the first payday on or after your service anniversary
- **Bank hours payout** zeros the bank balance at both payout window start and end dates
- **Sick leave grant** applies the carryover cap on Jan 1, then adds the annual grant, then enforces the max-balance cap
- **Vacation carryover** caps vacation hours on the payout date; the excess is paid out on the configured payout date
- **"Any" pool deduction** uses bank first, then vacation, then sick
- **Partial days** deduct the configured hours per day in 15-minute increments

## Data persistence

All data lives in your browser. The app writes every change to two stores in parallel:

- **localStorage** — read first on load (synchronous, fastest path).
- **IndexedDB** — written alongside localStorage; read as a fallback if localStorage is empty.

Both are durable across normal page reloads and browser restarts. **Neither survives** any of the following:

- Clearing site data, cookies, or "browsing data" for this site in browser settings.
- Private / Incognito windows (data is wiped when the window closes).
- The browser evicting storage under disk-pressure (rare, but possible — neither localStorage nor IndexedDB is granted persistent storage by default).
- Switching browsers, profiles, or devices.

For real backups, use **Settings → Data → Export** to download a JSON snapshot you can keep elsewhere or restore later. Import the same JSON to restore.

## Customizing for your employer

Open **Settings > Policy** to customize:

- **Accrual tiers** — add/remove tiers, set hours per pay period for each tenure range
- **Pay period** — set the length in days (14 for bi-weekly, 7 for weekly, etc.)
- **Carryover** — choose annual accrual cap, fixed hours cap, or unlimited
- **Work schedule** — select which days of the week are work days
- **Holidays** — add/remove holidays with fixed-date, nth-weekday, or last-weekday rules
- **Hours per day** — default is 8, adjust for your schedule
- **Sick leave** — annual grant, carryover cap, and max balance
- **Bank hours payout** — start and end dates for the payout window

## Privacy

All data is stored locally in your browser's IndexedDB and localStorage. Nothing is sent to any server, API, or third-party service. There is no analytics, tracking, or telemetry of any kind. No account is needed.

To move your data between browsers, use the Export/Import feature in Settings.

## Feedback & Issues

Found a bug, incorrect calculation, or have a feature idea? [Open an issue](https://github.com/interestingcodelol/schedule-planner/issues/new/choose) — templates are provided for bug reports, feature requests, and calculation issues.

This project is maintained by a single developer. Pull requests are not accepted at this time, but feedback via issues is welcome.

## License

MIT — see [LICENSE](LICENSE)
