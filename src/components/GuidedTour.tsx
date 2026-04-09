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
      'Log extra hours you work beyond your regular day. Bank hours can be used for time off and are used first when you select "Auto". They get paid out during the Dec-Feb window.',
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
  const TOOLTIP_W = 400
  const TOOLTIP_H = 260
  const BORDER_R = 16

  const updatePosition = useCallback(() => {
    if (!active) return
    const step = steps[currentStep]
    const el = document.querySelector(step.target)
    if (!el) return

    const rect = el.getBoundingClientRect()
    const pad = 12

    setSpotlightRect({
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    })

    let top = 0
    let left = 0
    const gap = 20

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

  const vw = window.innerWidth
  const vh = window.innerHeight

  return (
    <>
      <svg
        className="fixed inset-0 z-40 w-full h-full"
        style={{ pointerEvents: 'auto' }}
        onClick={dismiss}
      >
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {spotlightRect && (
              <rect
                x={spotlightRect.left}
                y={spotlightRect.top}
                width={spotlightRect.width}
                height={spotlightRect.height}
                rx={BORDER_R}
                ry={BORDER_R}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width={vw}
          height={vh}
          fill="rgba(0,0,0,0.55)"
          mask="url(#tour-mask)"
        />
      </svg>

      {spotlightRect && (
        <div
          className="fixed z-40 pointer-events-none"
          style={{
            top: spotlightRect.top - 2,
            left: spotlightRect.left - 2,
            width: spotlightRect.width + 4,
            height: spotlightRect.height + 4,
            borderRadius: BORDER_R + 2,
            border: '2px solid rgba(59, 130, 246, 0.5)',
            boxShadow:
              '0 0 24px rgba(59, 130, 246, 0.35), 0 0 60px rgba(59, 130, 246, 0.12)',
          }}
        />
      )}

      <div
        className="fixed z-50 rounded-2xl shadow-2xl p-6"
        style={{
          top: tooltipPos.top,
          left: tooltipPos.left,
          width: TOOLTIP_W,
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          border: '1px solid rgba(59, 130, 246, 0.25)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
        role="dialog"
        aria-label={`Tour step ${currentStep + 1} of ${steps.length}`}
      >
        <div className="flex gap-1.5 mb-4">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                i < currentStep
                  ? 'bg-blue-500'
                  : i === currentStep
                    ? 'bg-blue-400 shadow-sm shadow-blue-400/50'
                    : 'bg-gray-700'
              }`}
            />
          ))}
        </div>

        <div className="flex items-start justify-between mb-3">
          <h3 className="text-base font-bold text-white pr-4">{step.title}</h3>
          <button
            onClick={dismiss}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors shrink-0"
            aria-label="Close tour"
            title="Close tour"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-400 leading-relaxed mb-5">
          {step.description}
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500 font-medium">
            {currentStep + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={dismiss}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors rounded-lg"
              title="Skip tour"
            >
              Skip
            </button>
            {currentStep > 0 && (
              <button
                onClick={prev}
                className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/60 transition-all"
                aria-label="Previous step"
                title="Previous step"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={next}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-colors shadow-lg shadow-blue-600/30"
              title={isLast ? 'Finish tour' : 'Next step'}
            >
              {isLast ? 'Done' : 'Next'}
              {!isLast && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
