import { Bot, ChevronRight, ExternalLink, Loader2, Mic, MicOff, Send, Volume2, X } from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { assistantChatAPI, type AssistantAction, type AssistantLink, type AssistantMessage } from '../lib/api'
import { useSessionStore, type CaptureType, type SessionState } from '../store/session'

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: any) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

type ChatMessage = AssistantMessage & {
  id: string
  suggestions?: string[]
  actions?: AssistantAction[]
  links?: AssistantLink[]
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const routeLabels: Record<string, string> = {
  '/': 'Home',
  '/language': 'Language picker',
  '/welcome': 'Welcome',
  '/consent': 'Consent',
  '/otp': 'OTP verification',
  '/setup': 'Jewellery setup',
  '/capture': 'Photo capture',
  '/certificate-scan': 'Bill/certificate upload',
  '/video-eval': 'Video evaluation',
  '/audio-eval': 'Audio evaluation',
  '/weight': 'Weight entry',
  '/processing': 'Processing',
  '/result': 'Pre-qualification result',
  '/final-eval': 'Final evaluation',
  '/gold-loan-app': 'Loan application',
  '/confirmation': 'Confirmation',
}

function visiblePageText() {
  if (typeof document === 'undefined') return ''
  const root = document.querySelector('#root')
  if (!root) return ''
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-assistant-root="true"]').forEach((node) => node.remove())
  return (clone.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800)
}

function compactSession(state: SessionState) {
  const captureSummary = (Object.entries(state.captures) as Array<[CaptureType, SessionState['captures'][CaptureType]]>)
    .filter(([, asset]) => Boolean(asset))
    .map(([type, asset]) => ({
      type,
      captured: true,
      timestamp: asset?.timestamp ?? null,
    }))

  return {
    sessionId: state.sessionId,
    language: state.lang,
    phoneProvided: Boolean(state.phone),
    nameProvided: Boolean(state.name),
    captures: captureSummary,
    manualWeightG: state.weightG,
    typedHuid: state.huidCode,
    scannedKarat: state.scannedKarat,
    bill: state.certificateData
      ? {
          authenticityFound: state.certificateData.authenticityFound,
          karat: state.certificateData.karat,
          weightG: state.certificateData.weightG,
          huid: state.certificateData.huid,
          itemDescription: state.certificateData.itemDescription,
          billNumber: state.certificateData.billNumber,
          jewellerName: state.certificateData.jewellerName,
          purchaseDate: state.certificateData.purchaseDate,
          confidence: state.certificateData.confidence,
          notes: state.certificateData.notes?.slice(0, 4),
        }
      : null,
    huidVerification: state.huidVerification
      ? {
          huid: state.huidVerification.huid,
          status: state.huidVerification.status,
          confidence: state.huidVerification.confidence,
          purity: state.huidVerification.purity,
          articleType: state.huidVerification.article_type,
          jewellerName: state.huidVerification.jeweller_name,
          hallmarkDate: state.huidVerification.hallmark_date,
          error: state.huidVerification.error,
        }
      : null,
    liveAuth: state.liveAuthResult,
    tapTest: state.tapTestResult,
    assessment: state.result
      ? {
          routing: state.result.routing,
          purity: state.result.purity,
          weight: state.result.weight,
          valueInr: state.result.value_inr,
          loanOffer: state.result.loan_offer,
          confidence: state.result.confidence,
          fraudSignals: state.result.fraud_signals,
          reasoningText: state.result.reasoning_text,
        }
      : null,
    finalEvaluation: state.evalData
      ? {
          city: state.evalData.city,
          state: state.evalData.state,
          serviceable: state.evalData.serviceable,
          cityGoldValueInr: state.evalData.cityGoldValueInr,
          cityPricePerG: state.evalData.cityPricePerG,
          priceSource: state.evalData.priceSource,
          cibilScore: state.evalData.cibilScore,
          ltvFinalPct: state.evalData.ltvFinalPct,
          maxLoanInr: state.evalData.maxLoanInr,
          eligible: state.evalData.eligible,
          rejectReason: state.evalData.rejectReason,
        }
      : null,
    loanApplication: state.loanAppData
      ? {
          requestedLoanInr: state.loanAppData.requestedLoanInr,
          tenureMonths: state.loanAppData.tenureMonths,
          repaymentType: state.loanAppData.repaymentType,
          roiPaPct: state.loanAppData.roiPaPct,
          monthlyPayment: state.loanAppData.monthlyPayment,
          bulletPayment: state.loanAppData.bulletPayment,
          totalInterest: state.loanAppData.totalInterest,
          totalPayment: state.loanAppData.totalPayment,
          disbursementInr: state.loanAppData.disbursementInr,
        }
      : null,
  }
}

export function FloatingAssistant() {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [listening, setListening] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const { state } = useSessionStore()
  const quietRoutes = new Set([
    '/',
    '/language',
    '/welcome',
    '/otp',
    '/setup',
    '/gold-loan-app',
    '/confirmation',
  ])

  const voiceSupported = useMemo(() => {
    if (typeof window === 'undefined') return false
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  }, [])

  useEffect(() => {
    if (!open) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, open])

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      window.speechSynthesis?.cancel()
    }
  }, [])

  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const userMessage: ChatMessage = { id: makeId(), role: 'user', content: trimmed }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)

    try {
      const history = nextMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-8)
        .map(({ role, content }) => ({ role, content }))
      const pageContext = {
        route: location.pathname,
        pageLabel: routeLabels[location.pathname] ?? 'Unknown page',
        visibleText: visiblePageText(),
        session: compactSession(state),
      }
      const response = await assistantChatAPI(trimmed, location.pathname, history, pageContext)
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: 'assistant',
          content: response.reply,
          suggestions: response.suggestions,
          actions: response.actions,
          links: response.links ?? [],
        },
      ])
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: 'assistant',
          content: 'The assistant brain is unavailable right now. Please check the backend model keys and try again.',
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void sendMessage(input)
  }

  function handleAction(action: AssistantAction) {
    setOpen(false)
    navigate(action.route)
  }

  function speak(text: string) {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.95
    utterance.pitch = 1
    window.speechSynthesis.speak(utterance)
  }

  function toggleVoice() {
    if (!voiceSupported) {
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: 'assistant',
          content: 'Voice input is not supported in this browser. You can type your question here.',
        },
      ])
      return
    }

    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) return

    const recognition = new Recognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-IN'
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0]?.transcript ?? '')
        .join(' ')
        .trim()
      if (transcript) {
        setInput(transcript)
        void sendMessage(transcript)
      }
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  const showAssistant = ['/language', '/profile', '/welcome', '/otp', '/setup'].includes(location.pathname)
  if (!showAssistant) return null

  if (quietRoutes.has(location.pathname)) return null

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute right-4 bottom-[calc(var(--safe-bottom)+5.5rem)] z-50 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 text-white shadow-brand transition active:scale-95"
        aria-label="Open GoldEye assistant"
      >
        <Bot className="h-6 w-6" />
      </button>
    )
  }

  return (
    <div
      data-assistant-root="true"
      className="absolute inset-x-4 bottom-[calc(var(--safe-bottom)+5.5rem)] z-50 overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-brand-100 bg-gradient-to-r from-brand-50 via-white to-gold-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-800 text-white">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <p className="font-display text-sm font-bold text-stone-900">GoldEye Assistant</p>
            <p className="text-xs text-stone-500">Captures, HUID, bills, loans</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn-icon h-10 w-10 rounded-full"
          aria-label="Close assistant"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div ref={scrollRef} className="max-h-[52dvh] space-y-3 overflow-y-auto bg-[#FFF8F0] px-4 py-4">
        {messages.length === 0 && (
          <div className="rounded-3xl border border-stone-200 bg-white px-4 py-5 text-center shadow-sm">
            <Bot className="mx-auto mb-3 h-8 w-8 text-brand-600" />
            <p className="font-display text-sm font-bold text-stone-900">Ask anything about GoldEye</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              Capture help, HUID, bill upload, loan eligibility, or any step where you are stuck.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                message.role === 'user'
                  ? 'max-w-[82%] rounded-3xl rounded-br-lg bg-brand-600 px-4 py-3 text-sm font-medium text-white'
                  : 'max-w-[88%] rounded-3xl rounded-bl-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800 shadow-sm'
              }
            >
              <p className="leading-relaxed">{message.content}</p>
              {message.role === 'assistant' && (
                <button
                  type="button"
                  onClick={() => speak(message.content)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-600"
                >
                  <Volume2 className="h-3.5 w-3.5" />
                  Listen
                </button>
              )}
              {message.actions && message.actions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.actions.map((action) => (
                    <button
                      key={`${message.id}-${action.route}`}
                      type="button"
                      onClick={() => handleAction(action)}
                      className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700"
                    >
                      {action.label}
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              )}
              {message.links && message.links.length > 0 && (
                <div className="mt-3 flex flex-col gap-2">
                  {message.links.map((link) => (
                    <a
                      key={`${message.id}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-between gap-2 rounded-2xl border border-blue-100 bg-blue-50 px-3 py-2 text-left text-xs font-semibold text-blue-800"
                    >
                      <span className="min-w-0 truncate">{link.label}</span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ))}
                </div>
              )}
              {message.suggestions && message.suggestions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.suggestions.slice(0, 3).map((suggestion) => (
                    <button
                      key={`${message.id}-${suggestion}`}
                      type="button"
                      onClick={() => sendMessage(suggestion)}
                      className="rounded-full bg-stone-100 px-3 py-1.5 text-left text-xs font-semibold text-stone-700"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-3xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-500 shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Thinking
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-stone-100 bg-white p-3">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleVoice}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
              listening ? 'border-red-200 bg-red-50 text-red-600' : 'border-stone-200 bg-stone-50 text-stone-600'
            }`}
            aria-label={listening ? 'Stop voice input' : 'Start voice input'}
          >
            {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="min-w-0 flex-1 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm outline-none focus:border-brand-300 focus:bg-white"
            placeholder="Ask about the app"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-5 w-5" />
          </button>
        </form>
      </div>
    </div>
  )
}
