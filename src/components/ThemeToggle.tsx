import { Moon, Sun } from 'lucide-react'
import { useAppState } from '../context'

export function ThemeToggle() {
  const { state, toggleTheme } = useAppState()

  return (
    <button
      onClick={toggleTheme}
      className="p-2.5 rounded-xl text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all duration-150"
      aria-label={`Switch to ${state.theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {state.theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  )
}
