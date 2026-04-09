declare const __BUILD_ID__: string

const CURRENT_BUILD = __BUILD_ID__
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`

type UpdateCallback = (available: boolean) => void

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    return data.v ?? null
  } catch {
    return null
  }
}

/**
 * Check for new deployments by comparing the build ID baked into the JS bundle
 * against the version.json served by the CDN. Both use the exact same BUILD_ID
 * generated at build time, so they only differ when a new build is deployed.
 *
 * Calls the callback when a genuinely new version is detected.
 */
export function startUpdateChecker(onUpdate: UpdateCallback): () => void {
  let notified = false

  const check = async () => {
    if (notified) return // already told the UI, don't spam
    const latest = await fetchVersion()
    if (!latest) return // fetch failed or no version.json (dev mode)
    if (latest !== CURRENT_BUILD) {
      notified = true
      onUpdate(true)
    }
  }

  // Don't check immediately on load — give the page time to settle
  const initialDelay = setTimeout(check, 30_000) // first check after 30s
  const intervalId = setInterval(check, CHECK_INTERVAL)

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      check()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    clearTimeout(initialDelay)
    clearInterval(intervalId)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
