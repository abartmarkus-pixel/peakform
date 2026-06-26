import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type SportConfig } from '../lib/supabase'

// ── constants ──────────────────────────────────────────────────────────────

const SPORT_OPTIONS = [
  { key: 'cycling',  label: '🚴 Radfahren' },
  { key: 'running',  label: '🏃 Laufen' },
  { key: 'strength', label: '🏋️ Krafttraining' },
]

const BODY_GOALS = [
  'Event',
  'Muskelaufbau',
  'Gewicht reduzieren',
  'Nackt gut ausschauen',
]

const PERSONA_STYLES = [
  { key: 'motivierend', label: '🔥 Motivierend' },
  { key: 'analytisch',  label: '📊 Analytisch' },
  { key: 'direkt',      label: '⚡ Direkt' },
  { key: 'empathisch',  label: '💙 Empathisch' },
]

// ── sub-components ─────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 rounded-2xl p-5">
      <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  )
}

function NumberField({
  label, value, onChange, unit, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void
  unit?: string; placeholder?: string
}) {
  return (
    <div>
      <label className="text-xs text-slate-400 mb-1 block">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? '—'}
          className="bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        {unit && <span className="text-slate-400 text-sm shrink-0">{unit}</span>}
      </div>
    </div>
  )
}

function Stepper({ value, onDec, onInc, disableDec, disableInc }: {
  value: number; onDec: () => void; onInc: () => void
  disableDec?: boolean; disableInc?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onDec}
        disabled={disableDec}
        className="w-9 h-9 flex items-center justify-center rounded-full bg-slate-600 hover:bg-slate-500 disabled:opacity-30 text-slate-200 text-xl font-bold transition-colors shrink-0"
      >−</button>
      <span className="w-5 text-center text-sm font-semibold text-slate-100">{value}</span>
      <button
        onClick={onInc}
        disabled={disableInc}
        className="w-9 h-9 flex items-center justify-center rounded-full bg-slate-600 hover:bg-slate-500 disabled:opacity-30 text-slate-200 text-xl font-bold transition-colors shrink-0"
      >+</button>
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function Profile() {
  const navigate = useNavigate()
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const initialized = useRef(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // form state
  const [name,          setName]           = useState('')
  const [ftpWatts,      setFtpWatts]      = useState('')
  const [maxHr,         setMaxHr]          = useState('')
  const [weightKg,      setWeightKg]       = useState('')
  const [trainingDays,  setTrainingDays]   = useState('')
  const [sportConfigs,  setSportConfigs]   = useState<SportConfig[]>([])
  const [focusedSport,  setFocusedSport]   = useState<string | null>(null)
  const [bodyGoals,     setBodyGoals]      = useState<string[]>([])
  const [personaStyle,  setPersonaStyle]   = useState('')
  const [personaFocus,  setPersonaFocus]   = useState('')

  // load
  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    supabase
      .from('athletes')
      .select('*')
      .eq('strava_athlete_id', Number(stravaId))
      .single()
      .then(({ data }) => {
        if (!data) return
        const a = data as Athlete
        setAthlete(a)
        setName(a.name ?? '')
        setFtpWatts(a.ftp_watts?.toString() ?? '')
        setMaxHr(a.max_hr?.toString() ?? '')
        setWeightKg(a.weight_kg?.toString() ?? '')
        setTrainingDays(a.training_days_per_week?.toString() ?? '')
        const raw = a.sport_types as unknown
        const isNewFormat = Array.isArray(raw) && raw.length > 0 &&
          typeof (raw as unknown[])[0] === 'object' && 'days' in ((raw as unknown[])[0] as object)
        setSportConfigs(isNewFormat ? (raw as SportConfig[]) : [])
        setBodyGoals(a.body_goals ?? [])
        const persona = a.coach_persona as Record<string, string> | null
        setPersonaStyle(persona?.style ?? '')
        setPersonaFocus(persona?.focus ?? '')
        initialized.current = true
      })
  }, [navigate])

  // debounced auto-save — fires 800ms after any field change
  useEffect(() => {
    if (!initialized.current || !athlete) return
    if (debounce.current) clearTimeout(debounce.current)

    setSaveState('saving')
    debounce.current = setTimeout(async () => {
      await supabase
        .from('athletes')
        .update({
          name:                    name.trim() || null,
          ftp_watts:               ftpWatts     ? parseInt(ftpWatts)       : null,
          max_hr:                  maxHr        ? parseInt(maxHr)           : null,
          weight_kg:               weightKg     ? parseFloat(weightKg)     : null,
          training_days_per_week:  trainingDays ? parseInt(trainingDays)   : null,
          sport_types:             sportConfigs.length ? sportConfigs : null,
          body_goals:              bodyGoals.length ? bodyGoals : null,
          coach_persona:           (personaStyle || personaFocus)
                                     ? { style: personaStyle, focus: personaFocus }
                                     : null,
        })
        .eq('id', athlete.id)

      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2000)
    }, 800)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, ftpWatts, maxHr, weightKg, trainingDays, sportConfigs, bodyGoals, personaStyle, personaFocus])

  const trainingDaysNum = trainingDays ? parseInt(trainingDays) : 0
  const totalDays = sportConfigs.reduce((sum, s) => sum + s.days, 0)

  function toggleSport(key: string) {
    // Akkordeon: gleiche Pill schließt, andere Pill öffnet
    setFocusedSport(prev => prev === key ? null : key)
    // Config anlegen falls noch nicht vorhanden
    setSportConfigs(prev =>
      prev.find(s => s.type === key) ? prev : [...prev, { type: key, days: 1 }]
    )
  }

  function updateSportConfig(key: string, patch: Partial<SportConfig>) {
    if (patch.days !== undefined && patch.days <= 0) {
      setSportConfigs(prev => prev.filter(s => s.type !== key))
      setFocusedSport(null)
    } else {
      setSportConfigs(prev => prev.map(s => s.type === key ? { ...s, ...patch } : s))
    }
  }

  function toggleGoal(goal: string) {
    setBodyGoals(prev =>
      prev.includes(goal) ? prev.filter(g => g !== goal) : [...prev, goal]
    )
  }

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto pb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link to="/dashboard" className="text-brand-500 hover:underline text-sm">
          ← Zurück
        </Link>
        <span className={`text-xs transition-opacity duration-300 ${
          saveState === 'saved'   ? 'text-brand-400 opacity-100' :
          saveState === 'saving'  ? 'text-slate-500 opacity-100' : 'opacity-0'
        }`}>
          {saveState === 'saved' ? '✓ Gespeichert' : 'Speichert…'}
        </span>
      </div>

      <h1 className="text-2xl font-bold text-slate-100 mb-6">Profil</h1>

      <div className="flex flex-col gap-4">

        {/* Name */}
        <SectionCard title="Allgemein">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Dein Vorname"
              className="bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
            />
          </div>
        </SectionCard>

        {/* Leistungsdaten */}
        <SectionCard title="Leistungsdaten">
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="FTP"     value={ftpWatts}  onChange={setFtpWatts}  unit="W"  placeholder="250" />
            <NumberField label="Max HF"  value={maxHr}     onChange={setMaxHr}     unit="bpm" placeholder="185" />
            <NumberField label="Gewicht" value={weightKg}  onChange={setWeightKg}  unit="kg" placeholder="70" />
          </div>
        </SectionCard>

        {/* Training */}
        <SectionCard title="Training">
          {/* Trainingstage */}
          <div className="mb-4">
            <label className="text-xs text-slate-400 mb-2 block">Trainingstage pro Woche</label>
            <div className="flex gap-2">
              {[1,2,3,4,5,6,7].map(n => (
                <button
                  key={n}
                  onClick={() => setTrainingDays(trainingDays === String(n) ? '' : String(n))}
                  className={`w-9 h-9 rounded-xl text-sm font-semibold transition-colors ${
                    trainingDays === String(n)
                      ? 'bg-brand-500 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Sportarten */}
          <div>
            <label className="text-xs text-slate-400 mb-2 block">Sportarten</label>

            {/* Pills — horizontal */}
            <div className="flex gap-2">
              {SPORT_OPTIONS.map(({ key, label }) => {
                const isFocused = focusedSport === key
                return (
                  <button
                    key={key}
                    onClick={() => toggleSport(key)}
                    className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                      isFocused
                        ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {/* Expand: stepper für die aktuell fokussierte Sportart */}
            {(() => {
              const config = focusedSport
                ? sportConfigs.find(s => s.type === focusedSport)
                : null
              return (
                <div style={{
                  maxHeight: config ? '72px' : '0',
                  overflow: 'hidden',
                  transition: 'max-height 200ms ease-out',
                }}>
                  {config && (
                    <div className="mt-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Stepper
                          value={config.days}
                          onDec={() => updateSportConfig(focusedSport!, { days: config.days - 1 })}
                          onInc={() => updateSportConfig(focusedSport!, { days: config.days + 1 })}
                          disableDec={false}
                          disableInc={trainingDaysNum > 0 && totalDays >= trainingDaysNum}
                        />
                        <span className="text-xs text-slate-500">
                          {config.days === 1 ? 'Tag' : 'Tage'}
                        </span>
                      </div>
                      <span className={`text-xs ${trainingDaysNum > 0 && totalDays > trainingDaysNum ? 'text-amber-400' : 'text-slate-500'}`}>
                        {totalDays} / {trainingDaysNum || '—'} Tage
                      </span>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </SectionCard>

        {/* Ziel & Coach */}
        <SectionCard title="Ziel & Coach-Einstellungen">
          {/* Ziele */}
          <div className="mb-4">
            <label className="text-xs text-slate-400 mb-2 block">Ziele (Mehrfachauswahl)</label>
            <div className="flex flex-wrap gap-2">
              {BODY_GOALS.map(goal => (
                <button
                  key={goal}
                  onClick={() => toggleGoal(goal)}
                  className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                    bodyGoals.includes(goal)
                      ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {goal}
                </button>
              ))}
            </div>
          </div>

          {/* Coach-Stil */}
          <div className="mb-4">
            <label className="text-xs text-slate-400 mb-2 block">Coach-Stil</label>
            <div className="flex flex-wrap gap-2">
              {PERSONA_STYLES.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setPersonaStyle(personaStyle === key ? '' : key)}
                  className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                    personaStyle === key
                      ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Coach-Fokus */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">
              Worauf soll der Coach besonders achten?
            </label>
            <textarea
              value={personaFocus}
              onChange={e => setPersonaFocus(e.target.value)}
              placeholder="z.B. Ich neige zu Übertraining, bitte auf Regeneration achten…"
              rows={3}
              className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
            />
          </div>
        </SectionCard>

      </div>
    </div>
  )
}
