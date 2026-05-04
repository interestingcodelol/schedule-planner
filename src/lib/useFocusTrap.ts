import { useEffect, type RefObject } from 'react'

/**
 * Trap Tab/Shift-Tab inside `containerRef` while `active` is true and restore
 * focus to whatever was active before the trap engaged when it disengages.
 * Used by modals so Tab cannot escape behind the dialog overlay.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return
    const node = containerRef.current
    if (!node) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusFirst = () => {
      const focusables = getFocusable(node)
      if (focusables.length > 0) focusables[0].focus()
      else node.focus()
    }
    focusFirst()

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusables = getFocusable(node)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (current === first || !node.contains(current)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (current === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus()
      }
    }
  }, [containerRef, active])
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === root,
  )
}
