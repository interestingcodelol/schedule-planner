import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, CalendarPlus, RotateCcw, Maximize2, Minimize2 } from 'lucide-react'
import { useAppState } from '../context'
import { processChat, type ChatResponse } from '../lib/chatParser'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  action?: ChatResponse['action']
  actionTaken?: boolean
}

export function ChatAssistant() {
  const { state, addVacation } = useAppState()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'Hi! I can help you plan time off. Try "take off July 14-18" or "can I afford next week?" Type **help** for more.',
    },
  ])
  // Last discussed date range, used to enrich follow-up messages.
  const [lastContext, setLastContext] = useState<{ startDate?: string; endDate?: string }>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const handleSend = () => {
    if (!input.trim()) return
    const userText = input.trim()

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: userText,
    }

    let enrichedInput = userText
    const lower = userText.toLowerCase()
    const hasDate = /\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|tomorrow|next\s+week|this\s+week/i.test(lower)

    if (!hasDate && lastContext.startDate && lastContext.endDate) {
      const isConfirmation = /\b(yes|yeah|yep|sure|ok|do\s+it|add\s+it|go\s+ahead|book\s+it|plan\s+it|sounds\s+good|let.?s\s+do|confirm)\b/i.test(lower)
      const isFollowUpQuestion = /\b(why|explain|tell\s+me\s+more|details|breakdown|how|when\s+will|when\s+can)\b/i.test(lower)
      if (isConfirmation) {
        enrichedInput = `book ${lastContext.startDate} to ${lastContext.endDate}`
      } else if (isFollowUpQuestion) {
        enrichedInput = `tell me more about ${lastContext.startDate} to ${lastContext.endDate}`
      }
    }

    const response = processChat(enrichedInput, state)

    if (response.action?.startDate) {
      setLastContext({ startDate: response.action.startDate, endDate: response.action.endDate })
    }

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: response.text,
      action: response.action,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleAddToPlan = (msg: Message) => {
    if (!msg.action || msg.action.type !== 'plan_vacation') return

    addVacation({
      id: crypto.randomUUID(),
      startDate: msg.action.startDate,
      endDate: msg.action.endDate,
      hourSource: 'any',
      note: msg.action.note,
      locked: false,
    })

    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, actionTaken: true } : m)),
    )
  }

  const clearChat = () => {
    setMessages([{
      id: 'welcome-' + Date.now(),
      role: 'assistant',
      text: 'Fresh start! What would you like to plan?',
    }])
    setLastContext({})
  }

  const renderText = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={i} className="font-semibold text-gray-900 dark:text-gray-100">
            {part.slice(2, -2)}
          </strong>
        )
      }
      return part.split('\n').map((line, j) => (
        <span key={`${i}-${j}`}>
          {j > 0 && <br />}
          {line}
        </span>
      ))
    })
  }

  const panelSize = expanded
    ? 'w-[min(560px,calc(100vw-2rem))] h-[min(600px,calc(100vh-3rem))]'
    : 'w-[min(384px,calc(100vw-2rem))] h-[min(480px,calc(100vh-3rem))]'

  return (
    <>
      {/* FAB */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-30 p-3.5 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white rounded-full shadow-lg shadow-blue-500/30 transition-all duration-200 hover:scale-110 hover:shadow-xl hover:shadow-blue-500/40"
          title="Open chat assistant — plan time off with natural language"
          aria-label="Open chat assistant"
        >
          <MessageCircle className="w-5 h-5" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className={`fixed bottom-5 right-5 z-30 ${panelSize} glass-card rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200/60 dark:border-gray-700/40 shrink-0">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <MessageCircle className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              </div>
              <span className="text-sm font-semibold">Plan Assistant</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={clearChat}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all"
                title="Clear chat / new conversation"
                aria-label="Clear chat"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setExpanded(!expanded)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all"
                title={expanded ? 'Shrink chat' : 'Expand chat'}
                aria-label={expanded ? 'Shrink chat' : 'Expand chat'}
              >
                {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-all"
                title="Close chat"
                aria-label="Close chat"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 scroll-panel">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  <div>{renderText(msg.text)}</div>

                  {msg.action && msg.action.type === 'plan_vacation' && (
                    <div className="mt-2">
                      {msg.actionTaken ? (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                          Added to plan
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAddToPlan(msg)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
                          title="Add this time off to your plan"
                        >
                          <CalendarPlus className="w-3 h-3" />
                          Add to plan
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="px-4 py-3 border-t border-gray-200/60 dark:border-gray-700/40 shrink-0">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder='e.g. "take off July 14-18"'
                className="flex-1 px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/60 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="p-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-xl transition-colors"
                title="Send message"
                aria-label="Send message"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
