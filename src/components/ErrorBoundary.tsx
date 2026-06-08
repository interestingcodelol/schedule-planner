import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { loadState, buildBackupJson, backupFilename, markExported } from '../lib/storage'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * Top-level safety net. A render error anywhere in the tree would otherwise
 * white-screen the whole app — and because this app is local-first, the user's
 * data is sitting in localStorage with no way to reach it. This boundary shows
 * a recovery screen with a one-click backup export (read straight from
 * localStorage, independent of React state) plus a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surfaced in the console for debugging; no remote logging (privacy/local-first).
    console.error('Schedule Planner crashed:', error, info)
  }

  handleExport = () => {
    try {
      const state = loadState()
      if (!state) return
      const blob = new Blob([buildBackupJson(state)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = backupFilename()
      a.click()
      URL.revokeObjectURL(url)
      markExported()
    } catch {
      // Best-effort — if even this fails the raw data is still in localStorage.
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const hasBackup = (() => {
      try {
        return loadState() !== null
      } catch {
        return false
      }
    })()

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-950">
        <div className="glass-card rounded-2xl max-w-md w-full p-6 text-center">
          <div className="flex justify-center mb-3">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-amber-500" />
            </div>
          </div>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">
            Something went wrong
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 leading-snug">
            The app hit an unexpected error. Your data is still saved on this
            device. Download a backup first, then reload.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mt-5">
            <button
              onClick={this.handleExport}
              disabled={!hasBackup}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Download backup
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 dark:bg-gray-800 text-gray-800 dark:text-gray-100 hover:bg-gray-300 dark:hover:bg-gray-700 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
