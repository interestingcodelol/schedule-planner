import { useRef, useState } from 'react'
import { format, isBefore, differenceInDays, parseISO, startOfDay } from 'date-fns'
import { Calendar, Sparkles, ArrowRight, ArrowLeft, Upload, ClipboardPaste, FileJson } from 'lucide-react'
import type { AppState } from '../lib/types'
import { defaultPolicy } from '../lib/defaultPolicy'
import { generateDemoState } from '../lib/demoData'
import { parseImportedBackup } from '../lib/storage'

type Props = {
  onComplete: (state: AppState, isDemo: boolean) => void
  /** Restore a parsed, validated backup. When provided, the welcome screen
   *  offers "Restore from a backup" so someone whose browser data was cleared
   *  can get straight back in without setting up or loading the demo first. */
  onRestore?: (state: AppState) => void
}

/** Step 3 is the restore screen; 0–2 are the welcome/setup steps. */
const RESTORE_STEP = 3

export function SetupWizard({ onComplete, onRestore }: Props) {
  const [step, setStep] = useState(0)
  const [restoreError, setRestoreError] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const restoreFromText = (raw: string): boolean => {
    const result = parseImportedBackup(raw)
    if (!result.ok) {
      setRestoreError(result.error)
      return false
    }
    setRestoreError('')
    document.documentElement.classList.add('dark')
    onRestore?.(result.state)
    return true
  }

  const restoreFromFile = (file: File | undefined) => {
    if (!file) return
    file.text().then(
      (text) => restoreFromText(text),
      () => setRestoreError('Could not read that file. Try pasting the backup text instead.'),
    )
  }
  const [displayName, setDisplayName] = useState('')
  const [hireDate, setHireDate] = useState('')
  const [vacationHours, setVacationHours] = useState('')
  const [sickHours, setSickHours] = useState('')
  const [bankHours, setBankHours] = useState('')
  const [lastPayday, setLastPayday] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleDemo = () => {
    const demoState = generateDemoState()
    document.documentElement.classList.add('dark')
    onComplete(demoState, true)
  }

  const validateStep2 = (): boolean => {
    const newErrors: Record<string, string> = {}
    const today = startOfDay(new Date())

    if (!hireDate) {
      newErrors.hireDate = 'Hire date is required'
    } else {
      const parsed = parseISO(hireDate)
      if (!isBefore(parsed, today)) {
        newErrors.hireDate = 'Hire date must be in the past'
      }
    }

    if (!vacationHours && vacationHours !== '0') {
      newErrors.vacationHours = 'Current vacation balance is required'
    } else if (isNaN(Number(vacationHours)) || Number(vacationHours) < 0) {
      newErrors.vacationHours = 'Must be a non-negative number'
    }

    if (sickHours && (isNaN(Number(sickHours)) || Number(sickHours) < 0)) {
      newErrors.sickHours = 'Must be a non-negative number'
    }

    if (bankHours && (isNaN(Number(bankHours)) || Number(bankHours) < 0)) {
      newErrors.bankHours = 'Must be a non-negative number'
    }

    if (!lastPayday) {
      newErrors.lastPayday = 'Last payday date is required'
    } else {
      const parsed = parseISO(lastPayday)
      const daysDiff = differenceInDays(today, parsed)
      if (daysDiff > 21) {
        newErrors.lastPayday = 'Last payday is more than 21 days ago — please update'
      }
      if (daysDiff < 0) {
        newErrors.lastPayday = 'Last payday cannot be in the future'
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleFinish = () => {
    const detectedTz = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
      } catch {
        return 'America/New_York'
      }
    })()
    const state: AppState = {
      profile: {
        displayName: displayName || 'User',
        hireDate,
        currentVacationHours: Number(vacationHours),
        currentSickHours: Number(sickHours) || 0,
        currentBankHours: Number(bankHours) || 0,
        lastPaydayDate: lastPayday,
        timezone: detectedTz,
        // The user just keyed in their balances, so they're current as of
        // now — don't let the first catch-up re-apply paydays/grants from
        // before this moment.
        lastSyncDate: format(new Date(), 'yyyy-MM-dd'),
      },
      policy: { ...defaultPolicy },
      plannedVacations: [],
      bankHoursLog: [],
      theme: 'dark',
      showTour: true,
      version: 1,
    }
    document.documentElement.classList.add('dark')
    onComplete(state, false)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-start sm:items-center justify-center overflow-y-auto py-8 p-4 relative">
      {/* GIS-themed background */}
      <div className="absolute inset-0 opacity-[0.07]" style={{
        backgroundImage: `
          linear-gradient(rgba(59,130,246,0.3) 1px, transparent 1px),
          linear-gradient(90deg, rgba(59,130,246,0.3) 1px, transparent 1px),
          linear-gradient(rgba(59,130,246,0.15) 1px, transparent 1px),
          linear-gradient(90deg, rgba(59,130,246,0.15) 1px, transparent 1px)
        `,
        backgroundSize: '100px 100px, 100px 100px, 20px 20px, 20px 20px',
      }} />
      {/* Radial glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-blue-500/[0.04] blur-3xl" />
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-gray-950 to-transparent" />

      <div className="w-full max-w-lg relative z-10">
        {step === 0 && (
          <div className="text-center space-y-8">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium mb-2">
                Browser-based PTO Planner
              </div>
              <h1 className="text-4xl font-bold tracking-tight gradient-text">Schedule Planner</h1>
              <p className="text-gray-400 text-lg leading-relaxed max-w-md mx-auto">
                Project your vacation accrual forward in time and plan time off against
                that projection. All data stays in your browser.
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => setStep(1)}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors duration-150"
              >
                <Calendar className="w-4 h-4" />
                Set up with my info
              </button>
              <button
                onClick={handleDemo}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg font-medium border border-gray-700 transition-colors duration-150"
              >
                <Sparkles className="w-4 h-4" />
                Try with demo data
              </button>
              {onRestore && (
                <button
                  onClick={() => {
                    setRestoreError('')
                    setStep(RESTORE_STEP)
                  }}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 text-gray-300 hover:text-white hover:bg-gray-800/60 rounded-lg font-medium border border-dashed border-gray-700 transition-colors duration-150"
                >
                  <Upload className="w-4 h-4" />
                  Restore from a backup
                </button>
              )}
            </div>

            <p className="text-xs text-gray-500">
              No account needed. No data leaves your browser.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">Your info</h2>
              <p className="text-sm text-gray-400 mt-1">
                We need a few details to project your accruals.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Display name <span className="text-gray-500">(optional)</span>
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Hire date <span className="text-red-400">*</span>
                </label>
                <input
                  type="date"
                  value={hireDate}
                  onChange={(e) => setHireDate(e.target.value)}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {errors.hireDate && (
                  <p className="text-red-400 text-sm mt-1">{errors.hireDate}</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Vacation <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={vacationHours}
                    onChange={(e) => setVacationHours(e.target.value)}
                    placeholder="47.30"
                    title="Your current vacation hour balance"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {errors.vacationHours && (
                    <p className="text-red-400 text-sm mt-1">{errors.vacationHours}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Sick
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={sickHours}
                    onChange={(e) => setSickHours(e.target.value)}
                    placeholder="40"
                    title="Your current sick hour balance"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {errors.sickHours && (
                    <p className="text-red-400 text-sm mt-1">{errors.sickHours}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Bank
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={bankHours}
                    onChange={(e) => setBankHours(e.target.value)}
                    placeholder="0"
                    title="Extra hours worked that can be used as PTO — leave blank if none"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {errors.bankHours && (
                    <p className="text-red-400 text-sm mt-1">{errors.bankHours}</p>
                  )}
                </div>
              </div>
              <p className="text-xs text-gray-500 -mt-2">
                Sick and bank hours are optional — enter 0 or leave blank if you don't have any.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Last payday <span className="text-red-400">*</span>
                </label>
                <input
                  type="date"
                  value={lastPayday}
                  onChange={(e) => setLastPayday(e.target.value)}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {errors.lastPayday && (
                  <p className="text-red-400 text-sm mt-1">{errors.lastPayday}</p>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(0)}
                className="flex items-center gap-1 px-4 py-2 text-gray-400 hover:text-gray-200 transition-colors duration-150"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <button
                onClick={() => {
                  if (validateStep2()) setStep(2)
                }}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors duration-150"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 text-center">
            <div className="space-y-3">
              <h2 className="text-xl font-semibold">You're all set</h2>
              <p className="text-gray-400 leading-relaxed">
                You can customize accrual rates, tiers, holidays, and all other
                policy details anytime in Settings.
              </p>
            </div>

            <button
              onClick={handleFinish}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors duration-150"
            >
              Open Schedule Planner
              <ArrowRight className="w-4 h-4" />
            </button>

            <button
              onClick={() => setStep(1)}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors duration-150"
            >
              Go back and edit
            </button>
          </div>
        )}

        {step === RESTORE_STEP && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">Restore from a backup</h2>
              <p className="text-sm text-gray-400 mt-1">
                Choose the <span className="font-mono text-gray-300">schedule-planner-backup-….json</span>{' '}
                file you exported earlier (Settings → Data). Your balances, plans and
                settings come back exactly as saved, and any paydays since then are
                applied automatically.
              </p>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                restoreFromFile(e.dataTransfer.files?.[0])
              }}
              className={`rounded-xl border-2 border-dashed p-6 text-center space-y-3 transition-colors duration-150 ${
                dragging ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 bg-gray-900/60'
              }`}
            >
              <FileJson className="w-8 h-8 mx-auto text-blue-400" aria-hidden />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors duration-150"
              >
                <Upload className="w-4 h-4" />
                Choose backup file
              </button>
              <p className="text-xs text-gray-500">or drag and drop it here</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                aria-label="Backup file"
                onChange={(e) => {
                  restoreFromFile(e.target.files?.[0])
                  e.target.value = ''
                }}
                className="hidden"
              />
            </div>

            <details className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
              <summary className="cursor-pointer text-sm text-gray-300 flex items-center gap-2">
                <ClipboardPaste className="w-4 h-4" />
                Paste backup text instead
              </summary>
              <div className="mt-3 space-y-2.5">
                <p className="text-xs text-gray-500">
                  Emailed yourself the backup? Open it, copy everything, and paste it below.
                </p>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={5}
                  aria-label="Backup text"
                  placeholder="Paste your backup JSON here (starts with { … )"
                  spellCheck={false}
                  className="w-full px-3 py-2 text-xs font-mono bg-gray-950 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                />
                <button
                  onClick={() => restoreFromText(pasteText)}
                  disabled={!pasteText.trim()}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-100 rounded-lg border border-gray-700 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Restore pasted backup
                </button>
              </div>
            </details>

            {restoreError && (
              <p role="alert" className="text-red-400 text-sm">
                {restoreError}
              </p>
            )}

            <button
              onClick={() => {
                setRestoreError('')
                setStep(0)
              }}
              className="flex items-center gap-1 px-4 py-2 text-gray-400 hover:text-gray-200 transition-colors duration-150"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
