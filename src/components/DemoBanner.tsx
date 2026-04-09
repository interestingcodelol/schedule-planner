import { FlaskConical } from 'lucide-react'

type Props = {
  onReset: () => void
}

export function DemoBanner({ onReset }: Props) {
  return (
    <div className="bg-blue-950/60 border-b border-blue-800/40 px-4 py-2 text-center text-sm">
      <span className="inline-flex items-center gap-1.5 text-blue-300">
        <FlaskConical className="w-3.5 h-3.5" />
        You're viewing demo data
        <span className="text-blue-500 mx-1">&mdash;</span>
        <button
          onClick={onReset}
          className="text-blue-400 hover:text-blue-200 underline underline-offset-2 font-medium transition-colors duration-150"
        >
          Reset and set up with your info
        </button>
      </span>
    </div>
  )
}
