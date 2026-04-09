import { useRef, useState, useEffect } from 'react'
import { format } from 'date-fns'
import { X, Download, Upload, Trash2, RotateCcw } from 'lucide-react'
import { useAppState } from '../context'
import { PolicyEditor } from './PolicyEditor'
import { exportState, validateImportedState } from '../lib/storage'
import { generateDemoState } from '../lib/demoData'

type Props = {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const { state, setState, updateProfile, updatePolicy, resetToSetup } = useAppState()
  const [activeTab, setActiveTab] = useState<'profile' | 'policy' | 'data'>('profile')
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(0)
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

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
            setState(data)
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
      setState(generateDemoState())
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
                  Export & Import
                </h3>
                <div className="space-y-2.5">
                  <button
                    onClick={() => exportState(state)}
                    className="w-full flex items-center gap-2.5 px-5 py-3 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors duration-150"
                  >
                    <Download className="w-4 h-4" />
                    Export data
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center gap-2.5 px-5 py-3 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors duration-150"
                  >
                    <Upload className="w-4 h-4" />
                    Import data
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
