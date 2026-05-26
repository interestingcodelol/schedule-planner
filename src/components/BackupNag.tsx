import { useEffect, useMemo, useRef, useState } from 'react'
import { format, differenceInDays, parseISO } from 'date-fns'
import { Download, X, ShieldAlert } from 'lucide-react'
import { useAppState } from '../context'
import { exportState, getLastExportTimestamp } from '../lib/storage'
import { showToast } from '../lib/toastBus'

const DEFAULT_REMINDER_DAYS = 30

/**
 * Compact header chip — appears in the top-right action area when the user
 * hasn't downloaded a backup in a while. Designed to feel like a passive
 * notification: a small amber pill that fades in (no slide), can be
 * expanded to show the full message and CTA, dismissed for the session,
 * or muted permanently.
 *
 * Why a chip instead of a banner:
 * - The previous full-width banner shifted the dashboard down on appear,
 *   which felt jumpy. A chip lives among the existing header buttons,
 *   so there's no layout displacement when it appears or disappears.
 * - Hover/click reveals the message; the chip itself stays small.
 */
export function BackupNag() {
  const { state, updateProfile } = useAppState()
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Drives the entry fade — set to true on mount so the opacity transition
  // runs once, instead of slamming in at full opacity.
  const [mounted, setMounted] = useState(false)

  const reminderDays =
    state.profile.backupReminderDays ?? DEFAULT_REMINDER_DAYS

  // Prefer the profile timestamp (synced into state), but fall back to the
  // standalone localStorage key written by every export path — so an export
  // done outside the normal profile-update flow still clears the chip.
  const lastExportIso = useMemo(() => {
    if (state.profile.lastExportDate) return state.profile.lastExportDate
    return getLastExportTimestamp()
  }, [state.profile.lastExportDate])

  const daysSince = useMemo(() => {
    if (!lastExportIso) return null
    try {
      return differenceInDays(new Date(), parseISO(lastExportIso))
    } catch {
      return null
    }
  }, [lastExportIso])

  const visible = useMemo(() => {
    if (state.profile.backupRemindersDisabled) return false
    if (dismissed) return false
    const hasMeaningfulData =
      state.plannedVacations.length > 0 ||
      (state.bankHoursLog?.length ?? 0) > 0
    if (!hasMeaningfulData) return false
    // First-time nag: never exported (no profile date AND no stored timestamp).
    if (!lastExportIso) return true
    if (daysSince === null) return false
    return daysSince >= reminderDays
  }, [
    state.profile.backupRemindersDisabled,
    lastExportIso,
    state.plannedVacations.length,
    state.bankHoursLog?.length,
    dismissed,
    daysSince,
    reminderDays,
  ])

  // Schedule a microtask after first render so the opacity transition
  // animates from 0 → 1 instead of being skipped because the element
  // mounted already at the final state.
  useEffect(() => {
    if (!visible) return
    const t = window.setTimeout(() => setMounted(true), 16)
    return () => window.clearTimeout(t)
  }, [visible])

  // Close popover on outside click / Escape so it behaves like other
  // dropdown menus in the app.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!visible) return null

  const message =
    !lastExportIso || daysSince === null
      ? 'No backup yet'
      : `Backup ${daysSince}d old`

  const fullMessage =
    !lastExportIso || daysSince === null
      ? "You haven't backed up your Schedule Planner data yet."
      : `Last backup was ${daysSince} day${daysSince === 1 ? '' : 's'} ago.`

  const handleBackup = () => {
    exportState(state)
    updateProfile({ lastExportDate: format(new Date(), 'yyyy-MM-dd') })
    showToast({ message: 'Backup downloaded' })
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Backup reminder"
        title={fullMessage}
        className="group flex items-center gap-1.5 pl-2 pr-1.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-700 dark:text-amber-300 transition-all duration-200 ease-out"
        style={{
          opacity: mounted ? 1 : 0,
        }}
      >
        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        <span className="text-xs font-semibold whitespace-nowrap hidden sm:inline">
          {message}
        </span>
        <span
          role="button"
          tabIndex={-1}
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation()
            setDismissed(true)
          }}
          className="p-0.5 rounded text-amber-600/70 dark:text-amber-300/70 hover:text-amber-700 dark:hover:text-amber-200 hover:bg-amber-500/20 transition-colors"
          title="Dismiss for this session"
        >
          <X className="w-3 h-3" />
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full right-0 mt-2 z-30 glass-card rounded-xl shadow-xl px-4 py-3 w-72 max-w-[calc(100vw-1rem)] animate-fade-in"
          role="dialog"
          aria-label="Backup reminder"
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-700 dark:text-gray-200 leading-tight">
                {fullMessage}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-snug">
                Browser data can be cleared without warning — a quick backup keeps your plans safe.
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              onClick={() => {
                updateProfile({ backupRemindersDisabled: true })
                setOpen(false)
              }}
              className="text-xs font-medium text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title="Don't show this reminder again"
            >
              Don't remind me
            </button>
            <button
              onClick={handleBackup}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 active:scale-[0.98] text-white rounded-lg transition-all duration-150 shadow-sm"
              title="Download a JSON backup now"
            >
              <Download className="w-3.5 h-3.5" />
              Download backup
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
