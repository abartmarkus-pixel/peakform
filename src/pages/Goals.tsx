import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, type SeasonGoal } from '../lib/supabase'

// ── types & constants ──────────────────────────────────────────────────────

type GoalForm = {
  event_name: string
  event_date: string
  priority: 'A' | 'B' | 'C'
  sport_type: string
  distance_km: string
  elevation_m: string
  notes: string
}

const EMPTY_FORM: GoalForm = {
  event_name: '', event_date: '', priority: 'B',
  sport_type: '', distance_km: '', elevation_m: '', notes: '',
}

const SPORT_TYPES = ['Radfahren', 'Laufen', 'Triathlon', 'Schwimmen', 'Wandern', 'Krafttraining']

const PRIORITY_STYLE = {
  A: { badge: 'bg-red-500/20 text-red-400 ring-1 ring-red-500/50',   btn: 'bg-red-500/20 text-red-400 ring-1 ring-red-500' },
  B: { badge: 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/50', btn: 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500' },
  C: { badge: 'bg-slate-700 text-slate-300',                          btn: 'bg-slate-700 text-slate-100 ring-1 ring-slate-500' },
}

function countdown(dateStr: string): { totalDays: number; label: string } {
  const totalDays = Math.ceil((new Date(dateStr).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  if (totalDays <= 0) return { totalDays, label: 'vergangen' }
  return { totalDays, label: `${totalDays} ${totalDays === 1 ? 'Tag' : 'Tage'}` }
}

// ── sub-components ─────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-slate-400 mb-1 block">{label}</label>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
    />
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function Goals() {
  const navigate = useNavigate()
  const [athleteId, setAthleteId]   = useState<string | null>(null)
  const [goals, setGoals]           = useState<SeasonGoal[]>([])
  const [loading, setLoading]       = useState(true)
  const [showModal, setShowModal]   = useState(false)
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [form, setForm]             = useState<GoalForm>(EMPTY_FORM)
  const [saving, setSaving]         = useState(false)

  // load
  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    ;(async () => {
      const { data: athleteData } = await supabase
        .from('athletes')
        .select('id')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
      if (!athleteData) { setLoading(false); return }

      setAthleteId(athleteData.id)
      const { data: goalsData } = await supabase
        .from('season_goals')
        .select('*')
        .eq('athlete_id', athleteData.id)
        .eq('active', true)
        .order('event_date', { ascending: true })
      setGoals((goalsData ?? []) as SeasonGoal[])
      setLoading(false)
    })()
  }, [navigate])

  function openAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  function openEdit(g: SeasonGoal) {
    setEditingId(g.id)
    setForm({
      event_name:  g.event_name,
      event_date:  g.event_date,
      priority:    g.priority,
      sport_type:  g.sport_type ?? '',
      distance_km: g.distance_km?.toString() ?? '',
      elevation_m: g.elevation_m?.toString() ?? '',
      notes:       g.notes ?? '',
    })
    setShowModal(true)
  }

  async function handleSave() {
    if (!athleteId || !form.event_name || !form.event_date) return
    setSaving(true)

    const payload = {
      athlete_id:  athleteId,
      event_name:  form.event_name,
      event_date:  form.event_date,
      priority:    form.priority,
      sport_type:  form.sport_type || null,
      distance_km: form.distance_km ? parseFloat(form.distance_km) : null,
      elevation_m: form.elevation_m ? parseFloat(form.elevation_m) : null,
      notes:       form.notes || null,
      active:      true,
    }

    if (editingId) {
      const { data } = await supabase
        .from('season_goals')
        .update(payload)
        .eq('id', editingId)
        .select()
        .single()
      if (data) setGoals(prev => prev.map(g => g.id === editingId ? data as SeasonGoal : g))
    } else {
      const { data } = await supabase
        .from('season_goals')
        .insert(payload)
        .select()
        .single()
      if (data) setGoals(prev => [...prev, data as SeasonGoal].sort(
        (a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime()
      ))
    }

    setSaving(false)
    setShowModal(false)
  }

  async function handleDeactivate(id: string) {
    await supabase.from('season_goals').update({ active: false }).eq('id', id)
    setGoals(prev => prev.filter(g => g.id !== id))
  }

  const nextA = goals.find(g => g.priority === 'A' && countdown(g.event_date).totalDays > 0)
  const sorted = [
    ...goals.filter(g => g.priority === 'A'),
    ...goals.filter(g => g.priority === 'B'),
    ...goals.filter(g => g.priority === 'C'),
  ]

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto pb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link to="/dashboard" className="text-brand-500 hover:underline text-sm">← Zurück</Link>
        <button
          onClick={openAdd}
          className="bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          + Ziel hinzufügen
        </button>
      </div>

      <h1 className="text-2xl font-bold text-slate-100 mb-6">Saison-Ziele</h1>

      {/* A-Event Countdown */}
      {nextA && (
        <div className="bg-brand-500/10 border border-brand-500/20 rounded-2xl px-5 py-4 mb-6">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Nächstes A-Event</p>
          <p className="text-3xl font-bold text-brand-400">{countdown(nextA.event_date).label}</p>
          <p className="text-slate-300 text-sm mt-0.5">
            {nextA.event_name} · {new Date(nextA.event_date).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      )}

      {/* Goal list */}
      {sorted.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <p className="text-4xl mb-3">🎯</p>
          <p className="text-sm">Noch keine Ziele. Füge dein erstes Saisonziel hinzu.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map(g => {
            const cd = countdown(g.event_date)
            return (
              <li key={g.id} className="bg-slate-800 rounded-2xl p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${PRIORITY_STYLE[g.priority].badge}`}>
                      {g.priority}
                    </span>
                    <span className="font-semibold text-slate-100 truncate">{g.event_name}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => openEdit(g)}
                      className="text-slate-500 hover:text-slate-300 text-xs"
                    >
                      Bearbeiten
                    </button>
                    <button
                      onClick={() => handleDeactivate(g.id)}
                      className="text-slate-600 hover:text-red-400 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
                  <span>{new Date(g.event_date).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                  <span className={cd.totalDays <= 0 ? 'text-slate-600' : 'text-slate-500'}>{cd.label}</span>
                  {g.sport_type  && <span>{g.sport_type}</span>}
                  {g.distance_km && <span>{g.distance_km} km</span>}
                  {g.elevation_m && <span>{g.elevation_m} hm</span>}
                </div>

                {g.notes && (
                  <p className="text-xs text-slate-500 mt-2 leading-relaxed">{g.notes}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}
        >
          <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-lg flex flex-col gap-4">
            <h2 className="text-lg font-bold text-slate-100">
              {editingId ? 'Ziel bearbeiten' : 'Neues Ziel'}
            </h2>

            <Field label="Eventname *">
              <Input value={form.event_name} onChange={v => setForm(f => ({ ...f, event_name: v }))} placeholder="z.B. Ötztaler Radmarathon" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Datum *">
                <Input type="date" value={form.event_date} onChange={v => setForm(f => ({ ...f, event_date: v }))} />
              </Field>
              <Field label="Sportart">
                <select
                  value={form.sport_type}
                  onChange={e => setForm(f => ({ ...f, sport_type: e.target.value }))}
                  className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="">—</option>
                  {SPORT_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Priorität">
              <div className="flex gap-2">
                {(['A', 'B', 'C'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setForm(f => ({ ...f, priority: p }))}
                    className={`flex-1 py-2 rounded-xl text-sm font-bold transition-colors ${
                      form.priority === p ? PRIORITY_STYLE[p].btn : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                A = Hauptziel · B = wichtig · C = Nebenziel
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Distanz (km)">
                <Input type="number" value={form.distance_km} onChange={v => setForm(f => ({ ...f, distance_km: v }))} placeholder="170" />
              </Field>
              <Field label="Höhenmeter">
                <Input type="number" value={form.elevation_m} onChange={v => setForm(f => ({ ...f, elevation_m: v }))} placeholder="4000" />
              </Field>
            </div>

            <Field label="Notizen">
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Besonderheiten, Anforderungen, Erwartungen…"
                rows={2}
                className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
              />
            </Field>

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 bg-slate-700 hover:bg-slate-600 transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.event_name || !form.event_date}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Speichert…' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
