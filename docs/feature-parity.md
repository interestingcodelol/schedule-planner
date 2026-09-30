# Original feature parity review

Baseline: production/main `ed543d9c923af0974e3f2df701f33e110046c96b`.
The compact preview keeps the original feature entry points. No release is authorized by this review.

| Original feature | Current location and behavior | Evidence |
| --- | --- | --- |
| Visible insights bar | Restored directly below the balance cards, before calendar/planner; never collapsed behind Planning notes. All original insight categories and four-message priority selection retained. Bank amounts use available balance; profile timezone determines today. Actual trip totals count once, and the upcoming rate-increase reminder uses the real service anniversary within six calendar months (including leap-day hires). Desktop message row is keyboard focusable; smaller screens wrap messages. | `Insights.tsx`, `Dashboard.tsx`; eight-viewport visibility/overflow assertions |
| Total, Vacation, Sick, Bank balances | Same compact card grid, with immediate same-day deductions. Balance details adds a per-pool accounting explanation. | `BalanceSummary.tsx`; balance and lifecycle tests |
| Accrual rate and next payday | Annual and per-period amounts, original tier label, next date and period accrual remain visible. | `StatusCards.tsx` |
| Year-end forecast and payout warning | Total and Vacation/Sick/Bank breakdown, or payout warning, visible in the original card position. Forecast label distinguishes future amounts. | `StatusCards.tsx` |
| Forecast chart | Vacation/Sick tabs, point tooltips, threshold/carryover explanation retained. | `BalanceForecast.tsx`, unchanged `ForecastChart.tsx`; browser tab checks |
| Bank management | Extra hours worked description; visible Add affordance; hours/note entry, history, remove and Undo retained. Panel fits each breakpoint. | `BankCard.tsx`; eight-size quarter-hour add/remove checks |
| Next time off / all upcoming count | Original header trigger and count, upcoming holidays/PTO/payouts, jump-to-date, date edit, emoji, lock/unlock, delete and Undo retained. | `Dashboard.tsx`, `UpcomingMenu.tsx`, `UpcomingVacationRow.tsx`; browser inventory, existing lifecycle tests |
| Calendar | Previous/next/current month, month/year chooser, keyboard navigation, date indicators, lock controls and balance tooltips retained. Exact partial-day clock ranges remain in tooltip/editor; tight cells prioritize hours consumed. | `CalendarView.tsx`, `CalendarDay.tsx`; browser inventory and viewport screenshots |
| Day editor / past adjustments | Full/partial toggle, clock fields, source, note, Add/Update, remove, actual-hours adjustment and close retained. Untimed partial entries keep their original duration when opened/saved. | `DayPopover.tsx`; quarter-hour regression tests and eight-size dialog checks |
| What-if planner | Dates, source, hours/day, note, affordability/shortfall, downstream conflict, earliest-affordable suggestion, Add and Clear retained. The duplicate empty placeholder is omitted only on short desktop displays; the preview instruction and every input/result/action remain. | `VacationPlanner.tsx`; visual smoke and planning consistency tests |
| Chat | All four starter suggestions, balance/planning responses, Add to calendar, clear, expand/shrink and close retained. Repeated adds and pending replies are guarded. | `ChatAssistant.tsx`; browser inventory and chat tests |
| Settings and backup | Profile/Policy/Data tabs, policy customization, import from file/pasted text, JSON export, browser-supported copy/share, calendar export options, reminders, theme and reset retained. v2 backups safely preserve daily accounting. | `SettingsModal.tsx`, `PolicyEditor.tsx`; real export-byte check, import tests and keyboard access checks |
| Tour and changelog | Original header buttons, five-step tour and changelog dialog retained. Tour language matches the current labels. | `GuidedTour.tsx`, `WhatsNew.tsx`; browser inventory |

Verification is against synthetic data in Chromium. The viewport matrix covers 1366×768, 1440×900, 1920×1080, 768×1024, 360×800, 390×844 and two CSS reflow sizes (1093×614 and 683×384). The latter approximate 125%/200% zoom reflow; they are not browser-chrome zoom or real-device testing. Narrow/enlarged pages and expanded content retain natural vertical scrolling. Settings and the day editor keep scrollable content when necessary for access.
