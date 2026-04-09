import { useState, useEffect, useCallback } from 'react'
import { X, ArrowRight, ArrowLeft } from 'lucide-react'
import { useAppState } from '../context'

type TourStep = {
  target: string
  title: string
  description: string
  placement: 'bottom' | 'top' | 'left' | 'right'
}

const steps: TourStep[] = [
  {
    target: '[data-tour="status-cards"]',
    title: 'Your Balances at a Glance',
    description:
      'See your total available hours across all pools — vacation, sick, and bank hours. The year-end card warns you if you might exceed your carryover cap.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="calendar"]',
    title: 'Interactive Calendar',
    description:
      'Click any work day to mark it as planned time off. Each day shows your projected balance. Green dots = paydays, amber = holidays. Use arrow keys or buttons to navigate months.',
    placement: 'right',
  },
  {
    target: '[data-tour="planner"]',
    title: 'Time Off Planner',
    description:
      'Use the "What-if" planner to check if a trip is affordable. Choose which hour pool to draw from. Green = affordable, red = not yet. You can also use the chat assistant to plan in natural language.',
    placement: 'left',
  },
  {
    target: '[data-tour="bank-hours"]',
    title: 'Bank Hours',
    description:
      'Log extra hours you work beyond your regular day. Bank hours can be used for time off and are used first when you select "Any available". They get paid out during the Dec-Feb window.',
    placement: 'left',
  },
  {
    target: '[data-tour="settings"]',
    title: 'Customize Everything',
    description:
      'Edit your profile, customize accrual tiers and rates, manage holidays, configure bank hours payout, and import/export your data. Re-open this tour anytime with the help button.',
    placement: 'bottom',
  },
]

type Rect = { top: number; left: number; width: number; height: number }

export function GuidedTour() {
  const { state, setShowTour } = useAppState()
  const [currentStep, setCurrentStep] = useState(0)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 })
  const [spotlightRect, setSpotlightRect] = useState<Rect | null>(null)

  const active = state.showTour
  const TOOLTIP_W = 380
  const TOOLTIP_H = 240

  const updatePosition = useCallback(() => {
    if (!active) return
    const step = steps[currentStep]
    const el = document.querySelector(step.target)
    if (!el) return

    const rect = el.getBoundingClientRect()
    const pad = 8

    // Spotlight rect (viewport-relative)
    setSpotlightRect({
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    })

    // Compute tooltip position
    let top = 0
    let left = 0
    const gap = 16

    switch (step.placement) {
      case 'bottom':
        top = rect.bottom + gap
        left = rect.left + rect.width / 2 - TOOLTIP_W / 2
        break
      case 'top':
        top = rect.top - TOOLTIP_H - gap
        left = rect.left + rect.width / 2 - TOOLTIP_W / 2
        break
      case 'left':
        top = rect.top
        left = rect.left - TOOLTIP_W - gap
        break
      case 'right':
        top = rect.top
        left = rect.right + gap
        break
    }

    // Clamp to viewport
    const vw = window.innerWidth
    const vh = window.innerHeight
    left = Math.max(12, Math.min(left, vw - TOOLTIP_W - 12))
    top = Math.max(12, Math.min(top, vh - TOOLTIP_H - 12))

    setTooltipPos({ top, left })
  }, [active, currentStep])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(updatePosition, 80)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [updatePosition, active])

  const dismiss = () => {
    setShowTour(false)
    setCurrentStep(0)
  }

  const next = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      dismiss()
    }
  }

  const prev = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1)
  }

  if (!active) return null

  const step = steps[currentStep]
  const isLast = currentStep === steps.length - 1

  // Build clip-path to create a "spotlight" hole in the overlay
  const clipPath = spotlightRect
    ? `polygon(
        0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%,
        ${spotlightRect.left}px ${spotlightRect.top}px,
        ${spotlightRect.left}px ${spotlightRect.top + spotlightRect.height}px,
        ${spotlightRect.left + spotlightRect.width}px ${spotlightRect.top + spotlightRect.height}px,
        ${spotlightRect.left + spotlightRect.width}px ${spotlightRect.top}px,
        ${spotlightRect.left}px ${spotlightRect.top}px
      )`
    : undefined

  return (
    <>
      {/* Overlay with spotlight cutout */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        style={{ clipPath }}
        onClick={dismiss}
      />
      {/* Spotlight border glow */}
      {spotlightRect && (
        <div
          className="fixed z-40 rounded-xl border-2 border-blue-500/50 pointer-events-none"
          style={{
            top: spotlightRect.top,
            left: spotlightRect.left,
            width: spotlightRect.width,
            height: spotlightRect.height,
            boxShadow: '0 0 0 9999px transparent, 0 0 30px rgba(59,130,246,0.3)',
          }}
        />
      )}

      {/* Tooltip */}
      <div
        className="fixed z-50 glass-card rounded-2xl shadow-2xl p-5"
        style={{
          top: tooltipPos.top,
          left: tooltipPos.left,
          width: TOOLTIP_W,
        }}
        role="dialog"
        aria-label={`Tour step ${currentStep + 1} of ${steps.length}`}
      >
        {/* Progress bar */}
        <div className="flex gap-1 mb-3">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
                i <= currentStep ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>

        <div className="flex items-start justify-between mb-2">
          <h3 className="text-sm font-bold pr-4">{step.title}</h3>
          <button
            onClick={dismiss}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors shrink-0"
            aria-label="Close tour"
            title="Close tour"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-4">
          {step.description}
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400 font-medium">
            {currentStep + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={dismiss}
              className="px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              title="Skip tour"
            >
              Skip
            </button>
            {currentStep > 0 && (
              <button
                onClick={prev}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all"
                aria-label="Previous step"
                title="Previous step"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={next}
              className="flex items-center gap-1 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              title={isLast ? 'Finish tour' : 'Next step'}
            >
              {isLast ? 'Done' : 'Next'}
              {!isLast && <ArrowRight className="w-3 h-3" />}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
