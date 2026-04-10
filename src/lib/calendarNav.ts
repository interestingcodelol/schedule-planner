type Listener = (date: Date) => void

const listeners = new Set<Listener>()

/** Request that the calendar view jump to the month containing `date`. */
export function navigateCalendarToDate(date: Date): void {
  listeners.forEach((fn) => fn(date))
}

/** Subscribe to calendar navigation requests. Returns an unsubscribe function. */
export function subscribeToCalendarNav(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
