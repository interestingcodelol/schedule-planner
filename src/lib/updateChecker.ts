declare const __BUILD_TIME__: string

const CURRENT_BUILD = __BUILD_TIME__
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`

type UpdateCallback = (available: boolean) => void

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    return data.t ?? null
  } catch {
    return null
  }
}

/**
 * Check for new deployments. Instead of auto-reloading (jarring),
 * calls the callback so the UI can show a gentle update banner.
 */
export function startUpdateChecker(onUpdate: UpdateCallback): () => void {
  const knownVersion = CURRENT_BUILD

  const check = async () => {
    const latest = await fetchVersion()
    if (latest && knownVersion && latest !== knownVersion) {
      onUpdate(true)
    }
  }

  const intervalId = setInterval(check, CHECK_INTERVAL)

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      check()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    clearInterval(intervalId)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
