import { useRef, useState, useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import { X, Download, Upload, Trash2, RotateCcw, CalendarDays, History } from 'lucide-react'
import { useAppState } from '../context'
import { PolicyEditor } from './PolicyEditor'
import { exportState, validateImportedState } from '../lib/storage'
import { generateDemoState } from '../lib/demoData'
import { COMMON_TIMEZONES } from '../lib/timeUtils'
import { useFocusTrap } from '../lib/useFocusTrap'
import { downloadIcal, DEFAULT_ICAL_OPTIONS, type IcalExportOptions } from '../lib/icalExport'
import { showToast } from '../lib/toastBus'

type Props = {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const { state, importState, updateProfile, updatePolicy, resetToSetup } = useAppState()
  const [activeTab, setActiveTab] = useState<'profile' | 'policy' | 'data'>('profile')
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(0)
  const [importError, setImportError] = useState('')
  const [showIcalOptions, setShowIcalOptions] = useState(false)
  const [icalOptions, setIcalOptions] = useState<IcalExportOptions>(DEFAULT_ICAL_OPTIONS)
  const [showHistory, setShowHistory] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, true)

  const handleJsonExport = () => {
    exportState(state)
    updateProfile({ lastExportDate: format(new Date(), 'yyyy-MM-dd') })
    showToast({ message: 'Backup downloaded' })
  }

  const handleIcalExport = () => {
    const filename = downloadIcal(state, icalOptions)
    updateProfile({ lastExportDate: format(new Date(), 'yyyy-MM-dd') })
    showToast({ message: `Calendar exported (${filename})`, duration: 5000 })
  }

  const toggleIcal = (key: keyof IcalExportOptions) => {
    setIcalOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    modalRef.current?.focus()
  }, [])

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        if (validateImportedState(data)) {
          if (window.confirm('This will replace all your current data. Continue?')) {
            importState(data)
            setImportError('')
          }
        } else {
          setImportError('Invalid file format — not a valid Schedule Planner backup.')
        }
      } catch {
        setImportError('Could not parse file as JSON.')
      }
    }
    reader.readAsText(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleResetDemo = () => {
    if (confirmReset) {
      importState(generateDemoState())
      setConfirmReset(false)
    } else {
      setConfirmReset(true)
    }
  }

  const handleClearAll = () => {
    if (confirmClear === 0) {
      setConfirmClear(1)
    } else if (confirmClear === 1) {
      setConfirmClear(2)
    } else {
      resetToSetup()
    }
  }

  const tabs = [
    { id: 'profile' as const, label: 'Profile' },
    { id: 'policy' as const, label: 'Policy' },
    { id: 'data' as const, label: 'Data' },
  ]

  const inputClass =
    'w-full px-4 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="glass-card rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200/60 dark:border-gray-700/40 shrink-0">
          <h2 className="text-lg font-bold">Settings</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
            aria-label="Close settings"
            title="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex border-b border-gray-200/60 dark:border-gray-700/40 shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-3.5 text-sm font-semibold transition-all duration-150 ${
                activeTab === tab.id
                  ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'profile' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                  Display name
                </label>
                <input
                  type="text"
                  value={state.profile.displayName}
                  onChange={(e) => updateProfile({ displayName: e.target.value })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                  Hire date
                </label>
                <input
                  type="date"
                  value={state.profile.hireDate}
                  onChange={(e) => updateProfile({ hireDate: e.target.value })}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                    Vacation hrs
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={state.profile.currentVacationHours}
                    onChange={(e) =>
                      updateProfile({ currentVacationHours: Number(e.target.value) })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                    Sick hrs
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={state.profile.currentSickHours}
                    onChange={(e) =>
                      updateProfile({ currentSickHours: Number(e.target.value) })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                    Bank hrs
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={state.profile.currentBankHours}
                    onChange={(e) =>
                      updateProfile({ currentBankHours: Number(e.target.value) })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                  Last payday
                </label>
                <input
                  type="date"
                  value={state.profile.lastPaydayDate}
                  onChange={(e) => updateProfile({ lastPaydayDate: e.target.value })}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1.5 font-medium">
                  Timezone
                </label>
                <select
                  value={
                    COMMON_TIMEZONES.some((tz) => tz.value === state.profile.timezone)
                      ? state.profile.timezone
                      : '__other__'
                  }
                  onChange={(e) => {
                    if (e.target.value === '__other__') return
                    updateProfile({ timezone: e.target.value })
                  }}
                  className={inputClass}
                >
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                  {!COMMON_TIMEZONES.some((tz) => tz.value === state.profile.timezone) && (
                    <option value="__other__">{state.profile.timezone} (current)</option>
                  )}
                </select>
                <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                  Used so same-day time off doesn't deduct from your available hours until after your local end-of-work-day.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'policy' && (
            <PolicyEditor
              policy={state.policy}
              onChange={(policy) => updatePolicy(policy)}
            />
          )}

          {activeTab === 'data' && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
                  Backup & restore
                </h3>
                <div className="space-y-2.5">
                  <button
                    onClick={handleJsonExport}
                    className="w-full flex items-center gap-2.5 px-5 py-3 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors duration-150"
                    title="Save a JSON file you can re-import later"
                  >
                    <Download className="w-4 h-4" />
                    Export backup (JSON)
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center gap-2.5 px-5 py-3 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors duration-150"
                  >
                    <Upload className="w-4 h-4" />
                    Import backup
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImport}
                    className="hidden"
                  />
                  {importError && (
                    <p className="text-red-400 text-sm">{importError}</p>
                  )}
                  {state.profile.lastExportDate && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      Last backup:{' '}
                      {format(parseISO(state.profile.lastExportDate), 'MMM d, yyyy')}
                    </p>
                  )}
                </div>
              </div>

              <div className="border-t border-gray-200/60 dark:border-gray-700/40 pt-5">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Calendar export
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 leading-snug">
                  Generate an .ics file you can import into Outlook (it will appear in
                  Teams calendar too), Google Calendar, or Apple Calendar.
                </p>
                <div className="space-y-2.5">
                  <button
                    onClick={() => setShowIcalOptions((v) => !v)}
                    className="w-full flex items-center justify-between gap-2.5 px-5 py-3 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors duration-150"
                    aria-expanded={showIcalOptions}
                  >
                    <span className="flex items-center gap-2.5">
                      <CalendarDays className="w-4 h-4" />
                      What to include
                    </span>
                    <span className="text-xs text-gray-400">
                      {showIcalOptions ? 'Hide' : 'Show'}
                    </span>
                  </button>
                  <div className="collapsible" data-open={showIcalOptions}>
                    <div className="collapsible-inner">
                      <div className="rounded-xl bg-gray-50 dark:bg-gray-800/40 p-4 space-y-2 border border-gray-200/60 dark:border-gray-700/40">
                        <IcalToggle
                          label="Scheduled time off"
                          checked={icalOptions.includePlannedTimeOff}
                          onChange={() => toggleIcal('includePlannedTimeOff')}
                        />
                        <IcalToggle
                          label="Logged past absences"
                          checked={icalOptions.includeLoggedPast}
                          onChange={() => toggleIcal('includeLoggedPast')}
                        />
                        <IcalToggle
                          label="Holidays"
                          checked={icalOptions.includeHolidays}
                          onChange={() => toggleIcal('includeHolidays')}
                        />
                        <IcalToggle
                          label="Paydays (with accrual amount)"
                          checked={icalOptions.includePaydays}
                          onChange={() => toggleIcal('includePaydays')}
                        />
                        <IcalToggle
                          label="Carryover payout date"
                          checked={icalOptions.includeCarryoverPayout}
                          onChange={() => toggleIcal('includeCarryoverPayout')}
                        />
                        <IcalToggle
                          label="Bank hours payout window"
                          checked={icalOptions.includeBankWindow}
                          onChange={() => toggleIcal('includeBankWindow')}
                        />
                        <IcalToggle
                          label="Work anniversaries / tier increases"
                          checked={icalOptions.includeAnniversaries}
                          onChange={() => toggleIcal('includeAnniversaries')}
                        />
                        <div className="flex items-center justify-between pt-2 border-t border-gray-200/60 dark:border-gray-700/40">
                          <label
                            htmlFor="ical-years"
                            className="text-sm text-gray-600 dark:text-gray-300"
                          >
                            Years ahead
                          </label>
                          <input
                            id="ical-years"
                            type="number"
                            min="1"
                            max="5"
                            value={icalOptions.yearsAhead}
                            onChange={(e) =>
                              setIcalOptions((prev) => ({
                                ...prev,
                                yearsAhead: Math.max(
                                  1,
                                  Math.min(5, Number(e.target.value) || 1),
                                ),
                              }))
                            }
                            className="w-16 px-2 py-1 text-sm tabular-nums text-right bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={handleIcalExport}
                    className="w-full flex items-center gap-2.5 px-5 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white rounded-xl transition-all duration-150 shadow-md shadow-blue-600/20"
                    title="Download .ics file"
                  >
                    <CalendarDays className="w-4 h-4" />
                    Export to calendar (.ics)
                  </button>
                </div>
              </div>

              <div className="border-t border-gray-200/60 dark:border-gray-700/40 pt-5">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
                  Backup reminder
                </h3>
                <div className="space-y-3">
                  <label className="flex items-center justify-between gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <span>Show reminder when no backup in</span>
                    <span className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="1"
                        max="365"
                        value={state.profile.backupReminderDays ?? 30}
                        onChange={(e) =>
                          updateProfile({
                            backupReminderDays: Math.max(
                              1,
                              Math.min(365, Number(e.target.value) || 30),
                            ),
                          })
                        }
                        className="w-16 px-2 py-1 text-sm tabular-nums text-right bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-500 dark:text-gray-400">days</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={!!state.profile.backupRemindersDisabled}
                      onChange={(e) =>
                        updateProfile({ backupRemindersDisabled: e.target.checked })
                      }
                      className="w-4 h-4 rounded accent-blue-500"
                    />
                    Disable backup reminders entirely
                  </label>
                </div>
              </div>

              <div className="border-t border-gray-200/60 dark:border-gray-700/40 pt-5">
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  className="w-full flex items-center justify-between text-sm font-bold text-gray-700 dark:text-gray-300 mb-2"
                  aria-expanded={showHistory}
                >
                  <span className="flex items-center gap-2">
                    <History className="w-4 h-4" />
                    Recent catch-up history
                  </span>
                  <span className="text-xs text-gray-400">
                    {(state.catchUpHistory?.length ?? 0)} entries · {showHistory ? 'Hide' : 'Show'}
                  </span>
                </button>
                <div className="collapsible" data-open={showHistory}>
                  <div className="collapsible-inner">
                    <div className="rounded-xl bg-gray-50 dark:bg-gray-800/40 p-3 max-h-[260px] overflow-y-auto scroll-panel border border-gray-200/60 dark:border-gray-700/40">
                      {state.catchUpHistory && state.catchUpHistory.length > 0 ? (
                        <div className="space-y-3">
                          {state.catchUpHistory.map((entry, i) => (
                            <div key={i} className="text-xs">
                              <div className="flex items-center justify-between text-gray-500 dark:text-gray-400 font-semibold">
                                <span>{format(parseISO(entry.ranOn), 'MMM d, yyyy')}</span>
                                <span className="text-[10px] uppercase tracking-wider">
                                  synced through {format(parseISO(entry.syncedTo), 'MMM d')}
                                </span>
                              </div>
                              <div className="text-gray-700 dark:text-gray-300 mt-0.5">
                                {entry.summary}
                              </div>
                              {entry.events.length > 0 && (
                                <ul className="mt-1 ml-2 text-gray-400 dark:text-gray-500 space-y-0.5">
                                  {entry.events.slice(0, 6).map((e, j) => (
                                    <li key={j} className="truncate">
                                      {format(parseISO(e.date), 'MMM d')} · {e.label}{' '}
                                      <span className="tabular-nums">
                                        ({e.delta > 0 ? '+' : ''}
                                        {Number.isInteger(e.delta) ? e.delta : e.delta.toFixed(2)})
                                      </span>
                                    </li>
                                  ))}
                                  {entry.events.length > 6 && (
                                    <li className="italic">
                                      … and {entry.events.length - 6} more
                                    </li>
                                  )}
                                </ul>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">
                          No catch-up runs recorded yet. Entries appear here after
                          the app reconciles missed paydays, sick grants, or
                          finished vacations.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-200/60 dark:border-gray-700/40 pt-5">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">
                  Reset
                </h3>
                <div className="space-y-2.5">
                  <button
                    onClick={handleResetDemo}
                    className="w-full flex items-center gap-2.5 px-5 py-3 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors duration-150"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {confirmReset ? 'Click again to confirm' : 'Reset to demo data'}
                  </button>
                  <button
                    onClick={handleClearAll}
                    className={`w-full flex items-center gap-2.5 px-5 py-3 text-sm border rounded-xl transition-colors duration-150 ${
                      confirmClear > 0
                        ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700/60 text-red-600 dark:text-red-400'
                        : 'bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700/60 hover:bg-gray-100 dark:hover:bg-gray-700/60'
                    }`}
                  >
                    <Trash2 className="w-4 h-4" />
                    {confirmClear === 0
                      ? 'Clear all data'
                      : confirmClear === 1
                        ? 'Click again to confirm'
                        : 'Final confirmation — delete everything'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function IcalToggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-gray-600 dark:text-gray-300 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-4 h-4 rounded accent-blue-500"
      />
      {label}
    </label>
  )
}
