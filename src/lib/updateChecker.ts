declare const __BUILD_ID__: string

const CURRENT_BUILD = __BUILD_ID__
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`

type UpdateCallback = (available: boolean) => void

/** sessionStorage key remembering the latest build we already prompted a
 *  reload for. If a reload didn't change the running build, we suppress
 *  re-showing the banner for that same latest version to avoid a permanent,
 *  un-clearable banner. */
const SEEN_LATEST_KEY = 'schedule-planner-seen-latest'

async function fetchVersion(): Promise<string | null> {
  try {
    // Cache-bust in addition to no-store so an intermediary/proxy can't serve
    // a stale version.json and pin a false "update available" state.
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    // Only trust a string `v`. A numeric/garbage value would otherwise never
    // equal CURRENT_BUILD and trigger a false, sticky update banner.
    if (typeof data?.v !== 'string') return null
    return data.v
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
      // If we already prompted a reload for this exact `latest` and the running
      // build STILL doesn't match it, the reload didn't pick up the new build
      // (CDN lag, SW cache, etc.). Suppress further banners for this latest so
      // the user isn't stuck with an un-clearable banner.
      let seenLatest: string | null = null
      try {
        seenLatest = sessionStorage.getItem(SEEN_LATEST_KEY)
      } catch {
        // sessionStorage unavailable (private mode / disabled) — fall through
        // and behave as before (show the banner once per session via `notified`).
      }
      if (seenLatest === latest) {
        notified = true // stop re-checking this session; reload didn't help
        return
      }
      try {
        sessionStorage.setItem(SEEN_LATEST_KEY, latest)
      } catch {
        /* non-fatal */
      }
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
