import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startUpdateChecker } from './lib/updateChecker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Auto-reload when a new version is deployed (data is safe in IndexedDB)
startUpdateChecker()
