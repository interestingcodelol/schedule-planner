import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startUpdateChecker } from './lib/updateChecker'

// Global update state — components can read this
export let updateAvailable = false
const listeners = new Set<() => void>()

export function onUpdateChange(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

startUpdateChecker((available) => {
  updateAvailable = available
  listeners.forEach((fn) => fn())
})
