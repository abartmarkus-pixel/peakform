import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type ChatMessage } from '../lib/supabase'
import { buildCoachContext } from '../lib/coachContext'
import { buildCoachSystemPrompt } from '../lib/coachPrompt'
import { IconChat, IconSend, IconRefresh } from '../lib/icons'
import { AppHeader } from '../components/AppHeader'
import { useFeatures } from '../lib/features'
import { DAY_FULL } from '../lib/weeklyPlan'
import {
  extractChatPlanRecommendation,
  applyPlanRecommendation,
  resolveTargetWeek,
  mondayForWeek,
  loadMatchingDays,
  type RecommendationDraft,
  type PlanSport,
} from '../lib/planRecommendation'
import { toDateStr } from '../lib/dateUtils'

// ── helpers ────────────────────────────────────────────────────────────────

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
  const [input, setInput]         = useState('')
  const [sending, setSending]     = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Coach-Empfehlung aus einer Chat-Nachricht in Wochenplan übernehmen
  // (analog zu ActivityDetail.tsx, aber Sportart wird hier erst extrahiert
  // statt aus dem Aktivitätstyp bekannt zu sein)
  const [recoModalOpen, setRecoModalOpen] = useState(false)
  const [recoLoading, setRecoLoading]     = useState(false)
  const [recoSaving, setRecoSaving]       = useState(false)
  const [recoError, setRecoError]         = useState<string | null>(null)
  const [recoSport, setRecoSport]         = useState<PlanSport | null>(null)
  const [recoDraft, setRecoDraft]         = useState<RecommendationDraft | null>(null)
  const [recoWeek, setRecoWeek]           = useState<'current' | 'next'>('current')
  const [recoDayOptions, setRecoDayOptions] = useState<string[]>([])
  const [recoDay, setRecoDay]             = useState<string>('')
  const [recoDuration, setRecoDuration]   = useState('')
  const [recoDistance, setRecoDistance]   = useState('')
  const [recoIntensity, setRecoIntensity] = useState('')
  const [recoDescription, setRecoDescription] = useState('')
  const [recoToast, setRecoToast]         = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // load athlete + messages (thread_id === athlete.id: one persistent global thread per athlete)
  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    ;(async () => {
      const { data: athleteData } = await supabase
        .from('athletes')
        .select('*')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
      if (!athleteData) { navigate('/'); return }
      const a = athleteData as Athlete
      if (!useFeatures(a).coach_chat) { navigate('/dashboard', { replace: true }); return }
      setAthlete(a)

      const { data: msgs } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('thread_id', a.id)
        .eq('athlete_id', a.id)
        .order('created_at', { ascending: true })
        .limit(50)
      setMessages((msgs ?? []) as ChatMessage[])
    })()
  }, [navigate])

  // auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  async function reloadMessages() {
    if (!athlete) return
    const { data } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', athlete.id)
      .eq('athlete_id', athlete.id)
      .order('created_at', { ascending: true })
      .limit(50)
    setMessages((data ?? []) as ChatMessage[])
  }

  async function send() {
    if (!input.trim() || !athlete || sending) return
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
        thread_id:  athlete.id,
        athlete_id: athlete.id,
        role:       'user',
        content,
        chat_type:  'global',
      })

      // 2. Reload so UI reflects DB state
      await reloadMessages()

      // 3. Build full context + dynamic system prompt in parallel
      const [context, systemPrompt] = await Promise.all([
        buildCoachContext(athlete.id, athlete.id),
        buildCoachSystemPrompt(athlete.id),
      ])

      const prompt = `${context}

---

Antworte auf die letzte Nachricht des Athleten. Beziehe dich auf seine spezifischen Daten aus dem obigen Kontext. Keine allgemeinen Ratschläge.`

      // 4. Call Claude
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, max_tokens: 1024, system: systemPrompt }),
      })
      if (!res.ok) throw new Error('Claude API Fehler')
      const { text } = await res.json() as { text: string }

      // 5. Persist assistant response before displaying
      await supabase.from('chat_messages').insert({
        thread_id:  athlete.id,
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

  // Lädt für eine Woche die Tage, die bereits die passende Sportart tragen
  // (nur solche sind im Dropdown wählbar — kein Verschieben der Trainingstag-Struktur).
  async function loadRecoWeek(which: 'current' | 'next', sport: PlanSport, preferDay?: string | null) {
    setRecoWeek(which)
    if (!athlete) return
    const weekStart = toDateStr(mondayForWeek(which))
    const result = await loadMatchingDays(athlete.id, weekStart, sport)
    if (!result) {
      setRecoDayOptions([])
      setRecoDay('')
      return
    }
    setRecoDayOptions(result.days)
    setRecoDay(preferDay && result.days.includes(preferDay) ? preferDay : (result.days[0] ?? ''))
  }

  async function openRecoModal(messageContent: string) {
    setRecoModalOpen(true)
    setRecoLoading(true)
    setRecoError(null)
    setRecoDraft(null)
    setRecoSport(null)
    try {
      const draft = await extractChatPlanRecommendation({ chatText: messageContent })
      setRecoSport(draft.sport)
      setRecoDraft(draft)
      setRecoDuration(draft.duration_min != null ? String(draft.duration_min) : '')
      setRecoDistance(draft.distance_km != null ? String(draft.distance_km) : '')
      setRecoIntensity(draft.intensity ?? '')
      setRecoDescription(draft.description)

      if (draft.sport) {
        const which = draft.day ? resolveTargetWeek(draft.day).which : 'current'
        await loadRecoWeek(which, draft.sport, draft.day)
      }
    } catch (e) {
      console.error(e)
      setRecoError(e instanceof Error ? e.message : 'Empfehlung konnte nicht extrahiert werden.')
    } finally {
      setRecoLoading(false)
    }
  }

  function closeRecoModal() {
    if (recoSaving) return
    setRecoModalOpen(false)
    setRecoDraft(null)
    setRecoError(null)
  }

  async function confirmApplyRecommendation() {
    if (!athlete || !recoSport || !recoDay) return
    setRecoSaving(true)
    setRecoError(null)
    try {
      await applyPlanRecommendation({
        athleteId: athlete.id,
        weekStart: toDateStr(mondayForWeek(recoWeek)),
        day: recoDay,
        sport: recoSport,
        dayUpdate: {
          duration_min: recoDuration.trim() ? Number(recoDuration) : null,
          distance_km: recoDistance.trim() ? Number(recoDistance) : null,
          intensity: recoIntensity.trim() || null,
          description: recoDescription.trim(),
        },
        source: 'Chat-Empfehlung',
      })
      setRecoModalOpen(false)
      setRecoDraft(null)
      setRecoToast({ type: 'success', message: 'In Plan übernommen ✓' })
      setTimeout(() => setRecoToast(null), 2500)
    } catch (e) {
      console.error(e)
      setRecoError(e instanceof Error ? e.message : 'Übernehmen fehlgeschlagen.')
    } finally {
      setRecoSaving(false)
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

  // Clears only the local view — history is tied to athlete.id, not a disposable
  // thread, so it reappears on next reload rather than being orphaned.
  function startNewThread() {
    setMessages([])
    setInput('')
    setSendError(null)
  }

  return (
    <>
    <AppHeader
      rightAction={
        <button
          onClick={startNewThread}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 rounded-full transition-colors"
          title="Neues Gespräch"
        >
          <IconRefresh size={12} />
          <span>Neu</span>
        </button>
      }
    />
    <div className="flex flex-col max-w-2xl mx-auto mt-[72px]" style={{ height: 'calc(100vh - 136px)' }}>

      {/* ── Messages ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3 min-h-0">

        {messages.length === 0 && !sending && (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 py-16">
            <IconChat size={40} className="mb-4 text-slate-600" />
            <p className="text-sm text-center leading-relaxed max-w-xs">
              Frag deinen Coach — über Training, Erholung, Ziele oder Strategie.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-brand-500 text-white rounded-br-sm'
                : 'bg-slate-800 text-slate-200 rounded-bl-sm'
            }`}>
              <MessageContent text={msg.content} />
            </div>
            {msg.role === 'assistant' && i === messages.length - 1 && !sending && (
              <button
                onClick={() => openRecoModal(msg.content)}
                className="mt-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full transition-colors"
              >
                In Plan übernehmen
              </button>
            )}
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
            className="flex-1 bg-slate-800 text-slate-100 rounded-2xl px-4 py-3 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500 disabled:opacity-50"
            style={{ maxHeight: '128px', overflowY: 'auto' }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="w-11 h-11 flex items-center justify-center bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-2xl transition-colors shrink-0 self-end text-white"
          >
            <IconSend size={18} />
          </button>
        </div>
        <p className="text-xs text-slate-600 text-center mt-2">
          Enter senden · Shift+Enter neue Zeile
        </p>
      </div>

    </div>

      {/* ── Empfehlung-übernehmen-Modal ────────────────────── */}
      {recoModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) closeRecoModal() }}
        >
          <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-lg flex flex-col gap-4 max-h-[85vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-slate-100">Empfehlung in Plan übernehmen</h2>

            {recoLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
                Empfehlung wird extrahiert…
              </div>
            )}

            {recoError && <p className="text-red-400 text-sm">{recoError}</p>}

            {recoDraft && recoSport && !recoLoading && (
              <>
                <p className="text-sm text-slate-400 italic">{recoDraft.reasoning}</p>

                <div className="flex gap-2">
                  {(['current', 'next'] as const).map(w => (
                    <button
                      key={w}
                      onClick={() => loadRecoWeek(w, recoSport, recoDay)}
                      className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                        recoWeek === w ? 'bg-brand-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                      }`}
                    >
                      {w === 'current' ? 'Diese Woche' : 'Nächste Woche'}
                    </button>
                  ))}
                </div>

                {recoDayOptions.length === 0 ? (
                  <p className="text-amber-400 text-sm">
                    Kein passender Trainingstag in dieser Woche gefunden — andere Woche wählen oder zuerst einen Plan erzeugen.
                  </p>
                ) : (
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-wider">Tag</label>
                    <select
                      value={recoDay}
                      onChange={e => setRecoDay(e.target.value)}
                      className="w-full mt-1 bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      {recoDayOptions.map(d => (
                        <option key={d} value={d}>{DAY_FULL[d] ?? d}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-wider">Dauer (Min)</label>
                    <input
                      type="number"
                      value={recoDuration}
                      onChange={e => setRecoDuration(e.target.value)}
                      className="w-full mt-1 bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  {recoSport === 'cycling' && (
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-wider">Distanz (km)</label>
                      <input
                        type="number"
                        value={recoDistance}
                        onChange={e => setRecoDistance(e.target.value)}
                        className="w-full mt-1 bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                  )}
                  <div className={recoSport === 'running' ? 'col-span-2' : ''}>
                    <label className="text-xs text-slate-500 uppercase tracking-wider">Intensität</label>
                    <input
                      type="text"
                      value={recoIntensity}
                      onChange={e => setRecoIntensity(e.target.value)}
                      placeholder="z.B. Z2"
                      className="w-full mt-1 bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-wider">Beschreibung</label>
                  <textarea
                    value={recoDescription}
                    onChange={e => setRecoDescription(e.target.value)}
                    rows={3}
                    className="w-full mt-1 bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
                  />
                </div>

                <div className="flex gap-3 pt-1">
                  <button
                    onClick={closeRecoModal}
                    disabled={recoSaving}
                    className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 bg-slate-700 hover:bg-slate-600 transition-colors disabled:opacity-50"
                  >
                    Abbrechen
                  </button>
                  <button
                    onClick={confirmApplyRecommendation}
                    disabled={recoSaving || !recoDay || !recoDescription.trim()}
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {recoSaving && (
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    )}
                    Übernehmen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Empfehlung-übernehmen-Toast ─────────────────────── */}
      {recoToast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg max-w-[90vw] text-center text-white ${
          recoToast.type === 'success' ? 'bg-brand-500' : 'bg-red-500'
        }`}>
          {recoToast.message}
        </div>
      )}
    </>
  )
}
