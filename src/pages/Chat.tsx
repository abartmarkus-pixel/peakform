import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type ChatMessage } from '../lib/supabase'
import { buildCoachContext } from '../lib/coachContext'
import { COACH_SYSTEM_PROMPT } from '../lib/coachPrompt'

// ── helpers ────────────────────────────────────────────────────────────────

function getOrCreateThreadId(): string {
  let tid = localStorage.getItem('coach_thread_id')
  if (!tid) {
    tid = crypto.randomUUID()
    localStorage.setItem('coach_thread_id', tid)
  }
  return tid
}

// Minimal renderer: newlines + **bold**
function MessageContent({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <span>
      {lines.map((line, i) => {
        const parts = line.split(/(\*\*[^*]+\*\*)/)
        return (
          <span key={i}>
            {parts.map((p, j) =>
              p.startsWith('**') && p.endsWith('**')
                ? <strong key={j} className="font-semibold">{p.slice(2, -2)}</strong>
                : p
            )}
            {i < lines.length - 1 && <br />}
          </span>
        )
      })}
    </span>
  )
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1.5 items-center h-4">
          <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function Chat() {
  const navigate = useNavigate()
  const [athlete, setAthlete]     = useState<Athlete | null>(null)
  const [messages, setMessages]   = useState<ChatMessage[]>([])
  const [threadId, setThreadId]   = useState<string>('')
  const [input, setInput]         = useState('')
  const [sending, setSending]     = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // init thread id
  useEffect(() => {
    setThreadId(getOrCreateThreadId())
  }, [])

  // load athlete + messages whenever threadId changes
  useEffect(() => {
    if (!threadId) return
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    ;(async () => {
      const { data: athleteData } = await supabase
        .from('athletes')
        .select('*')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
      if (!athleteData) { navigate('/'); return }
      setAthlete(athleteData as Athlete)

      const { data: msgs } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true })
        .limit(50)
      setMessages((msgs ?? []) as ChatMessage[])
    })()
  }, [threadId, navigate])

  // auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  async function reloadMessages() {
    const { data } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .limit(50)
    setMessages((data ?? []) as ChatMessage[])
  }

  async function send() {
    if (!input.trim() || !athlete || !threadId || sending) return
    const content = input.trim()
    setInput('')
    setSendError(null)
    setSending(true)

    // reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    try {
      // 1. Persist user message — Supabase is source of truth
      await supabase.from('chat_messages').insert({
        thread_id:  threadId,
        athlete_id: athlete.id,
        role:       'user',
        content,
        chat_type:  'global',
      })

      // 2. Reload so UI reflects DB state
      await reloadMessages()

      // 3. Build full context (now includes the new user message in section 7)
      const context = await buildCoachContext(athlete.id, threadId)

      const prompt = `${context}

---

Antworte auf die letzte Nachricht des Athleten. Beziehe dich auf seine spezifischen Daten aus dem obigen Kontext. Keine allgemeinen Ratschläge.`

      // 4. Call Claude
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, max_tokens: 1024, system: COACH_SYSTEM_PROMPT }),
      })
      if (!res.ok) throw new Error('Claude API Fehler')
      const { text } = await res.json() as { text: string }

      // 5. Persist assistant response before displaying
      await supabase.from('chat_messages').insert({
        thread_id:  threadId,
        athlete_id: athlete.id,
        role:       'assistant',
        content:    text,
        chat_type:  'global',
      })

      // 6. Reload from Supabase — UI state is never the only source
      await reloadMessages()
    } catch (e) {
      console.error(e)
      setSendError('Nachricht konnte nicht gesendet werden.')
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const t = e.target as HTMLTextAreaElement
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 128) + 'px'
  }

  function startNewThread() {
    const tid = crypto.randomUUID()
    localStorage.setItem('coach_thread_id', tid)
    setThreadId(tid)
    setMessages([])
    setInput('')
    setSendError(null)
  }

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto">

      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
        <Link to="/dashboard" className="text-brand-500 hover:underline text-sm">← Zurück</Link>
        <h1 className="text-base font-semibold text-slate-100">Coach</h1>
        <button
          onClick={startNewThread}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          Neues Gespräch
        </button>
      </div>

      {/* ── Messages ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3 min-h-0">

        {messages.length === 0 && !sending && (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 py-16">
            <p className="text-4xl mb-4">💬</p>
            <p className="text-sm text-center leading-relaxed max-w-xs">
              Frag deinen Coach — über Training, Erholung, Ziele oder Strategie.
            </p>
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-brand-500 text-white rounded-br-sm'
                : 'bg-slate-800 text-slate-200 rounded-bl-sm'
            }`}>
              <MessageContent text={msg.content} />
            </div>
          </div>
        ))}

        {sending && <TypingIndicator />}

        {sendError && (
          <p className="text-xs text-red-400 text-center">{sendError}</p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ─────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-t border-slate-800 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Frag deinen Coach…"
            rows={1}
            disabled={sending}
            className="flex-1 bg-slate-800 text-slate-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500 disabled:opacity-50"
            style={{ maxHeight: '128px', overflowY: 'auto' }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="w-11 h-11 flex items-center justify-center bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-2xl transition-colors shrink-0 self-end"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="text-xs text-slate-600 text-center mt-2">
          Enter senden · Shift+Enter neue Zeile
        </p>
      </div>

    </div>
  )
}
