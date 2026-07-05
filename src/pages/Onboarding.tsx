import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type SportConfig } from '../lib/supabase'
import { IconRunning, IconCycling, IconStrength, IconWarning, SPORT_DISPLAY } from '../lib/icons'

const TOTAL_STEPS = 6

const SPORT_OPTIONS = [
  { key: 'cycling',  Icon: IconCycling,  color: SPORT_DISPLAY.cycling.color,  label: 'Radfahren'     },
  { key: 'running',  Icon: IconRunning,  color: SPORT_DISPLAY.running.color,  label: 'Laufen'        },
  { key: 'strength', Icon: IconStrength, color: SPORT_DISPLAY.strength.color, label: 'Krafttraining' },
]

const SPORT_LABELS: Record<string, string> = {
  cycling: 'Radfahren',
  running: 'Laufen',
  strength: 'Krafttraining',
}

const PERSONA_STYLES = [
  { key: 'motivierend',    label: 'Motivierend' },
  { key: 'analytisch',     label: 'Analytisch' },
  { key: 'drill_sergeant', label: 'Drill Sergeant' },
]

function Stepper({ value, onDec, onInc, disableInc, titleInc }: {
  value: number; onDec: () => void; onInc: () => void
  disableInc?: boolean; titleInc?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onDec}
        className="w-9 h-9 flex items-center justify-center rounded-full bg-slate-600 hover:bg-slate-500 text-slate-200 text-xl font-bold transition-colors shrink-0"
      >−</button>
      <span className="w-5 text-center text-sm font-semibold text-slate-100">{value}</span>
      <button
        onClick={onInc}
        disabled={disableInc}
        title={disableInc ? titleInc : undefined}
        className="w-9 h-9 flex items-center justify-center rounded-full bg-slate-600 hover:bg-slate-500 disabled:opacity-30 text-slate-200 text-xl font-bold transition-colors shrink-0"
      >+</button>
    </div>
  )
}

export default function Onboarding() {
  const navigate = useNavigate()
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(1)

  // Schritt 1 — Willkommen + Name
  const [name, setName] = useState('')

  // Schritt 2 — Sportarten + Trainingstage
  const [trainingDays, setTrainingDays] = useState('')
  const [sportConfigs, setSportConfigs] = useState<SportConfig[]>([])
  const [focusedSport, setFocusedSport] = useState<string | null>(null)

  // Schritt 3 — Erstes Saisonziel
  const [goalEventName, setGoalEventName] = useState('')
  const [goalEventDate, setGoalEventDate] = useState('')
  const [goalSportType, setGoalSportType] = useState('')
  const [goalDistanceKm, setGoalDistanceKm] = useState('')
  const [goalElevationM, setGoalElevationM] = useState('')
  const [goalNotes, setGoalNotes] = useState('')

  // Schritt 4 — Leistungsdaten
  const [gender, setGender] = useState<'male' | 'female' | 'diverse' | null>(null)
  const [birthYear, setBirthYear] = useState('')
  const [maxHr, setMaxHr] = useState('')
  const [restingHr, setRestingHr] = useState('')
  const [weightKg, setWeightKg] = useState('')
  const [ftpWatts, setFtpWatts] = useState('')
  const [best5kInput, setBest5kInput] = useState('')
  const [best5kError, setBest5kError] = useState<string | null>(null)

  // Schritt 5 — Coach-Persönlichkeit
  const [personaStyle, setPersonaStyle] = useState('analytisch')
  const [personaFocus, setPersonaFocus] = useState('')

  // Schritt 6 — Speichern
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id') || sessionStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    ;(async () => {
      const { data } = await supabase
        .from('athletes')
        .select('*')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
      if (data) {
        const a = data as Athlete
        setAthlete(a)
        setName(a.name ?? '')
      }
      setLoading(false)
    })()
  }, [navigate])

  const trainingDaysNum = trainingDays ? parseInt(trainingDays) : 0
  const totalDays = sportConfigs.reduce((sum, s) => sum + s.days, 0)
  const hasSportViolation = trainingDaysNum > 0 && totalDays > trainingDaysNum

  function toggleSport(key: string) {
    setFocusedSport(prev => prev === key ? null : key)
    setSportConfigs(prev => {
      if (prev.find(s => s.type === key)) return prev
      const currentSum = prev.reduce((s, c) => s + c.days, 0)
      if (trainingDaysNum > 0 && currentSum >= trainingDaysNum) return prev
      return [...prev, { type: key, days: 1 }]
    })
  }

  function updateSportConfig(key: string, patch: Partial<SportConfig>) {
    if (patch.days !== undefined && patch.days <= 0) {
      setSportConfigs(prev => prev.filter(s => s.type !== key))
      setFocusedSport(null)
    } else {
      setSportConfigs(prev => prev.map(s => s.type === key ? { ...s, ...patch } : s))
    }
  }

  function applyTanakaMaxHR() {
    if (!birthYear) return
    const age = new Date().getFullYear() - parseInt(birthYear)
    setMaxHr(Math.round(208 - 0.7 * age).toString())
  }

  async function handleFinish() {
    if (!athlete) return
    setSaving(true)
    setSaveError(null)

    let best5kSeconds: number | null = null
    if (best5kInput.trim()) {
      const m = best5kInput.match(/^(\d{1,2}):(\d{2})$/)
      if (m) {
        const mins = parseInt(m[1])
        const secs = parseInt(m[2])
        if (mins >= 10 && mins <= 59 && secs <= 59) best5kSeconds = mins * 60 + secs
      }
    }

    const { error: goalError } = await supabase.from('season_goals').insert({
      athlete_id: athlete.id,
      event_name: goalEventName.trim(),
      event_date: goalEventDate,
      priority: 'A',
      sport_type: goalSportType || null,
      distance_km: goalDistanceKm ? parseFloat(goalDistanceKm) : null,
      elevation_m: goalElevationM ? parseFloat(goalElevationM) : null,
      notes: goalNotes.trim() || null,
      active: true,
    })
    if (goalError) {
      setSaveError('Speichern fehlgeschlagen. Bitte versuche es erneut.')
      setSaving(false)
      return
    }

    const { error: athleteError } = await supabase.from('athletes').update({
      name: name.trim(),
      gender,
      birth_year: birthYear ? parseInt(birthYear) : null,
      max_hr: maxHr ? parseInt(maxHr) : null,
      resting_hr: restingHr ? parseInt(restingHr) : null,
      weight_kg: weightKg ? parseFloat(weightKg) : null,
      ftp_watts: ftpWatts ? parseInt(ftpWatts) : null,
      best_5k_seconds: best5kSeconds,
      sport_types: sportConfigs,
      training_days_per_week: trainingDaysNum,
      coach_persona: { style: personaStyle, focus: personaFocus },
      onboarding_completed: true,
    }).eq('id', athlete.id)
    if (athleteError) {
      setSaveError('Speichern fehlgeschlagen. Bitte versuche es erneut.')
      setSaving(false)
      return
    }

    navigate('/dashboard', { replace: true })
  }

  function canProceed(): boolean {
    if (currentStep === 1) return name.trim().length >= 2
    if (currentStep === 2) return trainingDaysNum > 0 && sportConfigs.length > 0
    if (currentStep === 3) {
      if (!goalEventName.trim() || !goalEventDate || !goalSportType) return false
      const eventDate = new Date(goalEventDate)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      return eventDate.getTime() > today.getTime()
    }
    if (currentStep === 5) return personaStyle !== ''
    return true
  }

  function goNext() {
    if (!canProceed()) return
    setCurrentStep(s => Math.min(s + 1, TOTAL_STEPS))
  }

  function goBack() {
    setCurrentStep(s => Math.max(s - 1, 1))
  }

  if (loading || !athlete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {/* Fortschrittsanzeige */}
      <div className="flex items-center gap-2 px-6 pt-8 pb-2 max-w-lg mx-auto w-full">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map(step => (
          <div
            key={step}
            className={`flex-1 h-1.5 rounded-full transition-colors ${
              step <= currentStep ? 'bg-brand-500' : 'bg-slate-700'
            }`}
          />
        ))}
      </div>

      {/* Step-Inhalt */}
      <div className="flex-1 overflow-y-auto px-6 py-4 max-w-lg mx-auto w-full">
        {currentStep === 1 && (
          <div className="flex flex-col items-center text-center gap-6 pt-6">
            <img
              src="/peakform-logo.png"
              alt="PeakForm"
              className="h-12 w-auto"
              srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
            />
            <div>
              <h1 className="text-xl font-bold text-slate-100 mb-2">Willkommen bei PeakForm</h1>
              <p className="text-sm text-slate-400 leading-relaxed">
                Lass uns dein Profil in wenigen Schritten einrichten, damit dein Coach dich von Anfang an gut unterstützen kann.
              </p>
            </div>
            <div className="w-full text-left">
              <label className="text-xs text-slate-400 mb-1 block">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Dein Vorname"
                autoFocus
                className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
              />
            </div>
          </div>
        )}
        {currentStep === 2 && (
          <div className="pt-2">
            <h1 className="text-xl font-bold text-slate-100 mb-2">Deine Sportarten</h1>
            <p className="text-sm text-slate-400 leading-relaxed mb-6">
              Wähle deine Trainingstage pro Woche und die Sportarten, die dein Coach einplanen soll.
            </p>

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
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400 mb-2 block">Sportarten</label>
              <div className="flex flex-wrap gap-2">
                {SPORT_OPTIONS.map(({ key, Icon, color, label }) => {
                  const isActive = sportConfigs.some(s => s.type === key)
                  return (
                    <button
                      key={key}
                      onClick={() => toggleSport(key)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      <Icon size={14} color={isActive ? undefined : '#94a3b8'} style={isActive ? { color } : undefined} />
                      {label}
                    </button>
                  )
                })}
              </div>

              {(() => {
                const config = focusedSport ? sportConfigs.find(s => s.type === focusedSport) : null
                return (
                  <div style={{ maxHeight: config ? '72px' : '0', overflow: 'hidden', transition: 'max-height 200ms ease-out' }}>
                    {config && (
                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Stepper
                            value={config.days}
                            onDec={() => updateSportConfig(focusedSport!, { days: config.days - 1 })}
                            onInc={() => updateSportConfig(focusedSport!, { days: config.days + 1 })}
                            disableInc={trainingDaysNum > 0 && totalDays >= trainingDaysNum}
                            titleInc="Maximale Trainingstage erreicht"
                          />
                          <span className="text-xs text-slate-500">{config.days === 1 ? 'Tag' : 'Tage'}</span>
                        </div>
                        <span className="text-xs text-slate-500">{totalDays} / {trainingDaysNum || '—'} Tage</span>
                      </div>
                    )}
                  </div>
                )
              })()}

              {hasSportViolation && (
                <p className="mt-2 text-xs text-amber-400 flex items-center gap-1">
                  <IconWarning size={11} /> Deine Sporttage ({totalDays}) übersteigen die Trainingstage ({trainingDaysNum}) — das kannst du später im Profil korrigieren
                </p>
              )}
            </div>
          </div>
        )}
        {currentStep === 3 && (
          <div className="pt-2">
            <h1 className="text-xl font-bold text-slate-100 mb-2">Dein erstes Ziel</h1>
            <p className="text-sm text-slate-400 leading-relaxed mb-6">
              Ohne ein Ziel kann dein Coach nicht sinnvoll planen.
            </p>

            <div className="flex flex-col gap-4">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Eventname *</label>
                <input
                  type="text"
                  value={goalEventName}
                  onChange={e => setGoalEventName(e.target.value)}
                  placeholder="z.B. Ötztaler Radmarathon"
                  className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1 block">Datum *</label>
                <input
                  type="date"
                  value={goalEventDate}
                  onChange={e => setGoalEventDate(e.target.value)}
                  className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                {goalEventDate && new Date(goalEventDate).getTime() <= Date.now() && (
                  <p className="text-xs text-red-400 mt-1">Das Datum muss in der Zukunft liegen</p>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1 block">Sportart *</label>
                <select
                  value={goalSportType}
                  onChange={e => setGoalSportType(e.target.value)}
                  className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="">—</option>
                  {sportConfigs.map(s => (
                    <option key={s.type} value={SPORT_LABELS[s.type] ?? s.type}>
                      {SPORT_LABELS[s.type] ?? s.type}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Distanz (km)</label>
                  <input
                    type="number"
                    value={goalDistanceKm}
                    onChange={e => setGoalDistanceKm(e.target.value)}
                    placeholder="170"
                    className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Höhenmeter</label>
                  <input
                    type="number"
                    value={goalElevationM}
                    onChange={e => setGoalElevationM(e.target.value)}
                    placeholder="4000"
                    className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1 block">Notizen</label>
                <textarea
                  value={goalNotes}
                  onChange={e => setGoalNotes(e.target.value)}
                  placeholder="Besonderheiten, Anforderungen, Erwartungen…"
                  rows={2}
                  className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
                />
              </div>
            </div>
          </div>
        )}
        {currentStep === 4 && (
          <div className="pt-2">
            <h1 className="text-xl font-bold text-slate-100 mb-2">Deine Leistungsdaten</h1>
            <p className="text-sm text-slate-400 leading-relaxed mb-6">
              Optional, aber hilft deinem Coach von Anfang an präzise zu planen. Du kannst das jederzeit im Profil nachtragen.
            </p>

            <div className="flex flex-col gap-4">
              <div>
                <label className="text-xs text-slate-400 mb-2 block">Geschlecht</label>
                <div className="flex gap-2">
                  {(['male', 'female', 'diverse'] as const).map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setGender(gender === g ? null : g)}
                      className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                        gender === g
                          ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {g === 'male' ? 'Männlich' : g === 'female' ? 'Weiblich' : 'Divers'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1 block">Geburtsjahr</label>
                <input
                  type="number"
                  value={birthYear}
                  onChange={e => setBirthYear(e.target.value)}
                  placeholder="z.B. 1982"
                  min={1940}
                  max={2010}
                  step={1}
                  className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                />
              </div>

              <div>
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-slate-400 mb-1 block">Max HF</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={maxHr}
                        onChange={e => setMaxHr(e.target.value)}
                        placeholder="185"
                        className="bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                      />
                      <span className="text-slate-400 text-sm shrink-0">bpm</span>
                    </div>
                  </div>
                  {birthYear && (
                    <button
                      onClick={applyTanakaMaxHR}
                      className="text-xs text-brand-400 hover:text-brand-300 underline whitespace-nowrap pb-2"
                    >
                      Tanaka berechnen
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">Gemessener Wert empfohlen. Ohne Wert: Tanaka-Formel (208 − 0.7 × Alter) als Schätzung.</p>
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1 block">Ruheherzfrequenz</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={restingHr}
                    onChange={e => setRestingHr(e.target.value)}
                    placeholder="z.B. 52"
                    className="bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                  />
                  <span className="text-slate-400 text-sm shrink-0">bpm</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">Morgens vor dem Aufstehen messen</p>
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1 block">Gewicht</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={weightKg}
                    onChange={e => setWeightKg(e.target.value)}
                    placeholder="70"
                    className="bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                  />
                  <span className="text-slate-400 text-sm shrink-0">kg</span>
                </div>
              </div>

              {sportConfigs.some(s => s.type === 'cycling') && (
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">FTP</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={ftpWatts}
                      onChange={e => setFtpWatts(e.target.value)}
                      placeholder="250"
                      className="bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                    />
                    <span className="text-slate-400 text-sm shrink-0">W</span>
                  </div>
                </div>
              )}

              {sportConfigs.some(s => s.type === 'running') && (
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">5k Bestzeit</label>
                  <input
                    type="text"
                    value={best5kInput}
                    onChange={e => {
                      const val = e.target.value
                      setBest5kInput(val)
                      if (!val.trim()) { setBest5kError(null); return }
                      const m = val.match(/^(\d{1,2}):(\d{2})$/)
                      if (!m) { setBest5kError('Format: MM:SS (z.B. 25:51)'); return }
                      const mins = parseInt(m[1])
                      const secs = parseInt(m[2])
                      if (mins < 10 || mins > 59) { setBest5kError('Minuten: 10–59'); return }
                      if (secs > 59) { setBest5kError('Sekunden: 0–59'); return }
                      setBest5kError(null)
                    }}
                    placeholder="25:51"
                    className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
                  />
                  {best5kError
                    ? <p className="text-xs text-red-400 mt-1">{best5kError}</p>
                    : <p className="text-xs text-slate-500 mt-1">Wird für Pace-Berechnungen verwendet</p>
                  }
                </div>
              )}
            </div>
          </div>
        )}
        {currentStep === 5 && (
          <div className="pt-2">
            <h1 className="text-xl font-bold text-slate-100 mb-2">Dein Coach-Stil</h1>
            <p className="text-sm text-slate-400 leading-relaxed mb-6">
              Wähle, wie dein Coach mit dir kommunizieren soll. Du kannst das jederzeit im Profil ändern.
            </p>

            <div className="mb-4">
              <label className="text-xs text-slate-400 mb-2 block">Coach-Stil</label>
              <div className="flex flex-wrap gap-2">
                {PERSONA_STYLES.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setPersonaStyle(key)}
                    className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                      personaStyle === key
                        ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400 mb-1 block">
                Worauf soll dein Coach besonders achten?
              </label>
              <textarea
                value={personaFocus}
                onChange={e => setPersonaFocus(e.target.value)}
                placeholder="z.B. Ich neige zu Übertraining, bitte auf Regeneration achten…"
                rows={3}
                className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
              />
            </div>
          </div>
        )}
        {currentStep === 6 && (
          <div className="pt-2">
            <h1 className="text-xl font-bold text-slate-100 mb-2">Fast geschafft!</h1>
            <p className="text-sm text-slate-400 leading-relaxed mb-6">
              Prüfe deine Angaben — dein Coach legt danach direkt los.
            </p>

            <div className="flex flex-col gap-3">
              <div className="bg-slate-800 rounded-2xl p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Name</p>
                <p className="text-sm text-slate-100">{name.trim()}</p>
              </div>

              <div className="bg-slate-800 rounded-2xl p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Training</p>
                <p className="text-sm text-slate-100">
                  {trainingDaysNum} {trainingDaysNum === 1 ? 'Tag' : 'Tage'}/Woche · {sportConfigs.map(s => `${SPORT_LABELS[s.type] ?? s.type} (${s.days})`).join(', ')}
                </p>
              </div>

              <div className="bg-slate-800 rounded-2xl p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Ziel</p>
                <p className="text-sm text-slate-100">
                  {goalEventName} · {goalEventDate && new Date(goalEventDate).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })} · {goalSportType}
                </p>
              </div>

              {(maxHr || weightKg || ftpWatts || best5kInput) && (
                <div className="bg-slate-800 rounded-2xl p-4">
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Leistungsdaten</p>
                  <p className="text-sm text-slate-100">
                    {[
                      maxHr && `Max HF ${maxHr}`,
                      weightKg && `${weightKg}kg`,
                      ftpWatts && `FTP ${ftpWatts}W`,
                      best5kInput && !best5kError && `5k ${best5kInput}`,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
              )}

              <div className="bg-slate-800 rounded-2xl p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Coach</p>
                <p className="text-sm text-slate-100">{PERSONA_STYLES.find(p => p.key === personaStyle)?.label ?? personaStyle}</p>
              </div>
            </div>

            {saveError && (
              <p className="text-sm text-red-400 mt-4">{saveError}</p>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      <div
        className="px-6 py-4 max-w-lg mx-auto w-full flex gap-3"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        {currentStep > 1 && (
          <button
            onClick={goBack}
            disabled={saving}
            className="flex-1 py-3 rounded-xl text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 transition-colors"
          >
            Zurück
          </button>
        )}
        {currentStep < TOTAL_STEPS ? (
          <button
            onClick={goNext}
            disabled={!canProceed()}
            className="flex-1 py-3 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Weiter
          </button>
        ) : (
          <button
            onClick={handleFinish}
            disabled={saving}
            className="flex-1 py-3 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Speichert…' : "Los geht's"}
          </button>
        )}
      </div>
    </div>
  )
}
