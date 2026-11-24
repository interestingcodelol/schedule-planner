export type ChangeType = 'new' | 'improved' | 'fixed'

export type ChangelogEntry = {
  /** Sortable id, newest first in the array (e.g. '2026-06-08'). */
  id: string
  /** Human-friendly date shown in the panel. */
  date: string
  title: string
  changes: { type: ChangeType; text: string }[]
}

/**
 * User-facing release notes. Add a new entry at the TOP for each release; the
 * "What's New" dot lights up until the user opens the panel. Keep wording
 * plain-English and generic (no internal/process detail).
 */
export const changelog: ChangelogEntry[] = [
  {
    id: '2026-11-24',
    date: 'November 2026',
    title: 'Ready for the new year',
    changes: [
      { type: 'new', text: 'Restore a backup right from the welcome screen. If your browser data was cleared, choose “Restore from a backup” and pick your backup file (or paste its text). No need to set up or load the demo first.' },
      { type: 'fixed', text: 'Christmas Eve and Christmas Day are both kept when they fall on a weekend. In 2027 Christmas is observed Thu Dec 23 (Christmas Eve stays Fri Dec 24), and in 2028 Christmas Eve moves to Tue Dec 26. Previously one of them was dropped, and planning that day off charged your PTO.' },
      { type: 'fixed', text: 'The day after Thanksgiving now always falls the day after Thanksgiving, including years when November starts on a Friday.' },
      { type: 'improved', text: 'In November and December the forecast looks past New Year’s, through the January sick-leave reset and the February carry-over payout.' },
      { type: 'fixed', text: 'In January, the carry-over payout for the year that just ended is no longer shown next to the following year’s year-end balance.' },
      { type: 'new', text: 'In November and December, the insights bar previews the new year: how many vacation hours carry over and where your sick leave lands after the Jan 1 reset.' },
      { type: 'improved', text: 'The bank-hours insight now gives the actual payout date and amount. In Settings, the two bank payout dates are labelled clearly: bank hours are paid out on both dates, so set them the same if you get one payout a year.' },
    ],
  },
  {
    id: '2026-09-30-calendar',
    date: 'September 2026',
    title: 'More accurate calendar exports',
    changes: [
      { type: 'fixed', text: 'Single-day partial absences with saved clock times now export as timed events in your profile timezone, rather than blocking the whole day.' },
      { type: 'fixed', text: 'Calendar export now explains that files are snapshots: repeated imports may duplicate events, and later changes or deletions do not update earlier imports.' },
      { type: 'fixed', text: 'Calendar text preserves Unicode and line breaks correctly. Clock times that do not exist during a daylight-saving change show an export error instead of silently shifting.' },
    ],
  },
  {
    id: '2026-09-30',
    date: 'September 2026',
    title: 'A clearer picture of your time off',
    changes: [
      { type: 'improved', text: 'Available now, today’s usage, and future forecasts are clearly separated. Open Balance details to see where every hour went.' },
      { type: 'fixed', text: 'Today’s PTO is reflected immediately across the calendar, bank hours, and chat, using your profile timezone.' },
      { type: 'fixed', text: 'Multi-day trips now record each elapsed day once, so reopening during a payday or payout does not change your balance.' },
      { type: 'fixed', text: 'More reliable edits, Undo, partial-day previews, observed holidays, and calendar exports.' },
      { type: 'improved', text: 'Backups now protect the daily balance history from older app versions. Close older tabs after updating and export a fresh backup.' },
    ],
  },
  {
    id: '2026-06-08-2',
    date: 'June 2026',
    title: 'A cleaner, faster dashboard',
    changes: [
      {
        type: 'new',
        text: 'Add and manage bank hours right from the Bank Hours card — no separate side panel.',
      },
      {
        type: 'improved',
        text: 'A cleaner full-height layout: the page scrolls as one, with no inner scrollbars on the panels.',
      },
      {
        type: 'improved',
        text: '"Next time off" now counts upcoming paid holidays, not just your planned trips.',
      },
      {
        type: 'improved',
        text: 'Dark mode is now the default throughout the app.',
      },
      {
        type: 'fixed',
        text: 'Re-exporting your calendar (.ics) now updates corrected events in place instead of creating duplicates, and never touches events you added yourself.',
      },
    ],
  },
  {
    id: '2026-06-08',
    date: 'June 2026',
    title: 'Sick-leave forecast & a cleaner dashboard',
    changes: [
      {
        type: 'new',
        text: 'The forecast now toggles between Vacation and Sick — the sick view shows your carry-over limit and a year-end "use it or lose it" warning when hours would be forfeited.',
      },
      {
        type: 'new',
        text: "This What's New panel, so you can see recent changes at a glance.",
      },
      {
        type: 'improved',
        text: 'Your vacation carry-over cap now rises automatically when you cross a service-year tier, and the forecast shows the change.',
      },
      {
        type: 'improved',
        text: 'Cleaner, more uniform header and status cards, plus a faster initial load.',
      },
      {
        type: 'fixed',
        text: 'Marking today as time off now updates your balance right away instead of waiting until the end of the day.',
      },
      {
        type: 'fixed',
        text: 'Added an editable sick carry-over limit in Settings — and your customizations are always kept across updates.',
      },
    ],
  },
  {
    id: '2026-05-26',
    date: 'May 2026',
    title: 'Reliability & accuracy',
    changes: [
      {
        type: 'improved',
        text: 'More accurate balance projections across pay periods, holidays, and time zones.',
      },
      {
        type: 'improved',
        text: 'Better layout on phones and tablets.',
      },
      {
        type: 'new',
        text: 'A portable backup file you can email yourself to restore on any device.',
      },
      {
        type: 'fixed',
        text: 'Several edge-case balance and calendar issues.',
      },
    ],
  },
]

export const LATEST_CHANGELOG_ID = changelog[0]?.id ?? ''

const SEEN_KEY = 'schedule-planner-changelog-seen'

/** True when there's a release the user hasn't opened the panel for yet. */
export function hasUnseenChangelog(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== LATEST_CHANGELOG_ID
  } catch {
    return false
  }
}

/** Record that the user has seen the latest release notes. */
export function markChangelogSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, LATEST_CHANGELOG_ID)
  } catch {
    // Non-fatal — the dot will just show again next time.
  }
}
