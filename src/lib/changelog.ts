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
