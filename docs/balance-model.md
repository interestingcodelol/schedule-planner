# Balance model and review checklist

## One meaning for each number

- **Available now** is the recorded balance minus scheduled workdays through today that have not yet been recorded. Today uses the profile's timezone, from midnight, regardless of an appointment's display time.
- **Used today** shows the hours actually drawn from each pool, including recorded deductions. Unfunded hours appear separately as a shortfall; they are not presented as hours that were consumed.
- **Recorded** is the persisted starting balance. Reconciliation records elapsed scheduled days individually, using the same ordering as forecasting. Already-recorded days are not charged again.
- **Looking ahead** and the calendar include future PTO, accruals, annual grants and configured payouts. Future PTO does not reduce Available now.
- **Auto** retains the established bank → vacation → sick ordering. An explicitly selected pool cannot borrow from another pool. Existing negative recorded balances are preserved, not silently zeroed.

## Why daily recording matters

Previously a trip was only recorded after its entire date range ended. A payday or bank payout occurring midway could therefore run before elapsed PTO when the app was reopened during the trip. For example, with 40 vacation hours, 8 bank hours, an 8-hour/day Auto trip June 15–17, and a June 16 accrual/payout, a single reconciliation produced 27.08 vacation hours while reopening midway produced 19.08. Daily ledger rows make both paths agree.

Each planned entry can contain `appliedDeductions`: dated requested hours and the exact draw per pool. Legacy plans without rows remain unrecorded until reconciliation; legacy logged entries remain recorded. A zero-draw row records a shortage so later accruals cannot retroactively fund it merely because the app was opened again.

Deleting or changing recorded days refunds only their actual draw. Unchanged rows survive note-only edits and future date extensions. Undo restores the original draw for a completed absence, including underfunded entries. Changed historical hours are deliberate corrections against the current balance; they do not reopen completed payroll payouts.

## Preserved policy rules

- Only configured workdays that are not observed holidays consume PTO
- Quarter-hour partial days and entry-total actual hours retain distinct meanings
- Accrual tier changes are prorated across a pay period
- Jan 1 sick carryover cap precedes the annual grant and maximum-balance cap
- Accrual precedes PTO; vacation carryover and bank payout follow PTO on the same date
- Both bank payout anchors resolve to paydays and coincident anchors run once
- Bank hiding is a display preference; existing nonzero bank amounts remain auditable in balance details

## Storage and backup compatibility

Daily recording is schema v2. An old build cannot safely interpret a partially
recorded active trip: it would subtract the recorded days again. V2 therefore
uses a separate localStorage key (`schedule-planner-state-v2`) and IndexedDB
record (`app-state-v2`), while retaining the existing database and store. Old
tabs can neither receive v2 cross-tab updates nor overwrite the new records.

On first migration, the app compares timestamps across legacy localStorage and
IndexedDB before promoting the newest snapshot. Once either v2 store exists,
newer writes from old tabs are ignored. Reset markers in both stores prevent
legacy records from reappearing after a reset, even if an old tab writes again.
Close or refresh old tabs before continuing edits; their later changes are not
merged into v2. Legacy records are otherwise retained for recovery, so rolling
back the application sees the pre-migration snapshot, not subsequent v2 edits.

JSON exports wrap v2 state in a versioned envelope that old importers reject.
The current importer accepts both that wrapper and legacy raw/root-envelope
backups, preserving ledger rows and recorded pool draws. Import v2 backups only
into the current app; do not unwrap them or change their version manually.

## Verification before release

Automated checks cover immediate same-day usage, midnight/DST and differing host/profile timezones, partial and explicit/Auto pools, shortages, multi-day paydays/payouts/year boundaries, reload, edit/delete/Undo, legacy and backup migration, calendar summaries, chat, observed holidays and iCalendar export. CI runs tests, TypeScript, ESLint and the production build in UTC, America/Los_Angeles and Pacific/Auckland.

The public release was exercised with disposable demo data. The local cloud-browser preview was unavailable, so the modified build was validated separately in GitHub-hosted Chromium. The [visual verification run](https://github.com/interestingcodelol/schedule-planner/actions/runs/36651492936) passed four browser flows at 1440×1000 desktop and 360×800 mobile on application commit `844114f44a120359be15a096dd16ecb662097363`. Captured PNGs were inspected, not only the assertions. This exposed and fixed mobile label/time clipping and a calendar-contained dialog; the final day editor is page-level and its full bounds are asserted inside the viewport.

Screenshots cover the dashboard, balance details, partial-day editor, bank management, what-if planner, chat, profile/data settings, lower settings controls and a populated upcoming month. Browser assertions cover edit/reload stability, no horizontal overflow, v1 migration, real JSON export contents, settings scrolling and Escape/focus restoration. The 222 unit/component/integration tests also pass in UTC, Los Angeles and Auckland; TypeScript, ESLint and production builds pass.

**This is a preview, not a deployment. Keep the PR draft and wait for the user's approval of the visual preview before any merge or production publication.** The checks do not claim exhaustive cross-browser/device testing; Safari/Firefox, real personal records and deployment/update-banner end-to-end behavior were not exercised.

### Public-release audit coverage (demo data only)

| Area | Checked on existing public release | Changed-build coverage |
| --- | --- | --- |
| Getting started | Landing page and demo setup | Existing state/migration tests |
| Calendar | Today full day → partial day; immediate total change; month picker | Same-day/timezone cells, monthly actual totals, shortages, preview allocation tests |
| Upcoming plans | Date edit, lock/unlock, delete, immediate Undo | App mutation, partial-ledger refund and Undo tests |
| What-if planner | Full/partial affordability, downstream warning, Add clears fields | Projection regressions, accessible labels and invalid-hour tests |
| Bank | Quarter-hour addition, deletion and Undo affordance | Available balance component; future entry lifecycle tests |
| Past absences | Partial sick absence, actual hours adjustment and refund | Exact per-pool edits/refunds and shortage Undo tests |
| Chat | Parse a dated trip, add, clear and close | Current/date/year-end/sick parser tests, interrupted-response and duplicate-add tests |
| Forecasts | Vacation/Sick tabs and cap labels | Projection, carryover, payout and year-boundary regressions |
| Settings | Profile, policy and data surfaces | Policy/date/import validation; cross-tab policy sync |
| Backup/export | Public release export updates last-backup UI; modified Chromium test verifies actual JSON bytes | JSON migration/roundtrip/isolation and iCalendar content tests |
| Help/update | Changelog open/close; tour Next/Previous/Skip | Release notes updated; deployment/update-banner end-to-end not exercised |

No real PTO records were accessed. Clear-all and production update/deployment were not executed. The final modified-build desktop/mobile screenshots were reviewed after the fixes above. Production publication still requires the user to approve this preview.
