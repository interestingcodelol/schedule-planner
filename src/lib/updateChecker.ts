declare const __BUILD_TIME__: string

const CURRENT_BUILD = __BUILD_TIME__
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`

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

export function startUpdateChecker(): () => void {
  const knownVersion = CURRENT_BUILD

  const check = async () => {
    const latest = await fetchVersion()
    if (latest && knownVersion && latest !== knownVersion) {
      // New version deployed — reload to get it
      // Data is safe in IndexedDB + localStorage
      window.location.reload()
    }
  }

  const intervalId = setInterval(check, CHECK_INTERVAL)

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      check()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Return cleanup function
  return () => {
    clearInterval(intervalId)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
