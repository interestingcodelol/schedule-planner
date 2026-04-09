function parseHHMM(s: string): { h: number; m: number } {
  if (!s || typeof s !== 'string') return { h: 0, m: 0 }
  const [hRaw, mRaw] = s.split(':')
  const h = parseInt(hRaw, 10)
  const m = parseInt(mRaw ?? '0', 10)
  return {
    h: Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : 0,
    m: Number.isFinite(m) ? Math.max(0, Math.min(59, m)) : 0,
  }
}

function toHHMM(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "HH:MM" → fractional hours. "08:30" → 8.5. */
export function hhmmToHours(s: string): number {
  const { h, m } = parseHHMM(s)
  return h + m / 60
}

/** Fractional hours → "HH:MM", snapped to the nearest 15 minutes. */
export function hoursToHHMM(hours: number): string {
  const totalQuarters = Math.round(hours * 4)
  const h = Math.floor(totalQuarters / 4)
  const m = (totalQuarters % 4) * 15
  return toHHMM(h, m)
}

/** Round a fractional-hour value to the nearest 15-minute increment. */
export function roundToQuarter(hours: number): number {
  return Math.round(hours * 4) / 4
}

/** "08:30" → "8:30 AM"; "13:00" → "1 PM". */
export function formatTimeLabel(s: string): string {
  const { h, m } = parseHHMM(s)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  if (m === 0) return `${h12} ${period}`
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

/** Compact form for calendar cells: "8a", "8:30a", "12p", "1:15p". */
export function formatTimeCompact(s: string): string {
  const { h, m } = parseHHMM(s)
  const suffix = h >= 12 ? 'p' : 'a'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  if (m === 0) return `${h12}${suffix}`
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`
}

type ZonedNow = {
  isoDate: string
  hour: number
  minute: number
  year: number
  month: number
  day: number
}

/**
 * Read "now" in a specific IANA timezone via Intl.DateTimeFormat. Falls back
 * to local time if the zone name is invalid.
 */
export function getNowInZone(timezone: string, now: Date = new Date()): ZonedNow {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
    let hour = parseInt(get('hour'), 10)
    if (hour === 24) hour = 0
    const minute = parseInt(get('minute'), 10)
    const year = parseInt(get('year'), 10)
    const month = parseInt(get('month'), 10)
    const day = parseInt(get('day'), 10)
    const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return { isoDate, hour, minute, year, month, day }
  } catch {
    const hour = now.getHours()
    const minute = now.getMinutes()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const day = now.getDate()
    const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return { isoDate, hour, minute, year, month, day }
  }
}

/**
 * True once the user's local work day cutoff has passed (8 AM + hoursPerWorkDay).
 * Used to decide whether same-day time off should already be deducted from
 * displayed balances.
 */
export function isWorkDayOverInZone(
  timezone: string,
  hoursPerWorkDay: number,
  now: Date = new Date(),
): boolean {
  const zoned = getNowInZone(timezone, now)
  const cutoff = 8 + hoursPerWorkDay
  return zoned.hour >= cutoff
}

export const COMMON_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (Phoenix, no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
]
