import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  supabase,
  type Athlete,
  type SportConfig,
  type EquipmentConfig,
  type AestheticGoals,
} from '../lib/supabase'
import { calculateSeasonPhase } from '../lib/coachContext'

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

const EQUIPMENT_ITEMS: { key: keyof EquipmentConfig; label: string }[] = [
  { key: 'dumbbells',  label: 'Kurzhanteln' },
  { key: 'bands',      label: 'Bänder / Tubes' },
  { key: 'bodyweight', label: 'Körpergewicht' },
  { key: 'pullup_bar', label: 'Klimmzugstange' },
]

const MUSCLE_GROUPS = [
  { key: 'glutes',    label: 'Po / Hüfte' },
  { key: 'shoulders', label: 'Schultern' },
  { key: 'arms',      label: 'Arme' },
  { key: 'core',      label: 'Core / Bauch' },
  { key: 'chest',     label: 'Brust' },
  { key: 'back',      label: 'Rücken' },
  { key: 'legs',      label: 'Beine' },
]

const PHASE_OPTIONS: { key: 'readaptation' | 'base' | 'race' | 'taper' | null; label: string }[] = [
  { key: null,            label: 'Auto' },
  { key: 'readaptation',  label: 'Readaptation' },
  { key: 'base',          label: 'Grundlage' },
  { key: 'race',          label: 'Wettkampf' },
  { key: 'taper',         label: 'Taper' },
]

const DEFAULT_EQUIPMENT: EquipmentConfig = {
  dumbbells:  { active: false, max_kg: 20 },
  bands:      { active: false },
  bodyweight: { active: true },
  pullup_bar: { active: false },
  gym:        { active: false },
}

const DEFAULT_AESTHETIC: AestheticGoals = {
  priorities: MUSCLE_GROUPS.map(g => g.key),
  notes: '',
}

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

function Checkmark() {
  return (
    <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2 6 5 9 10 3" />
    </svg>
  )
}

function SortableMuscleItem({ id, label, rank }: { id: string; label: string; rank: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      className="flex items-center gap-3 bg-slate-700 hover:bg-slate-600 rounded-xl px-3 py-2.5 cursor-grab active:cursor-grabbing touch-none select-none"
      {...attributes}
      {...listeners}
    >
      <span className="text-xs font-bold text-brand-400 w-4 text-center shrink-0">{rank}</span>
      <span className="text-sm text-slate-100 font-medium flex-1">{label}</span>
      <svg viewBox="0 0 16 16" className="w-4 h-4 text-slate-500 shrink-0" fill="currentColor">
        <circle cx="5" cy="4" r="1.3"/><circle cx="11" cy="4" r="1.3"/>
        <circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/>
        <circle cx="5" cy="12" r="1.3"/><circle cx="11" cy="12" r="1.3"/>
      </svg>
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function Profile() {
  const navigate = useNavigate()
  const [athlete, setAthlete]       = useState<Athlete | null>(null)
  const [saveState, setSaveState]   = useState<'idle' | 'saving' | 'saved'>('idle')
  const initialized                 = useRef(false)
  const debounce                    = useRef<ReturnType<typeof setTimeout> | null>(null)

  // form state
  const [name,           setName]          = useState('')
  const [ftpWatts,       setFtpWatts]      = useState('')
  const [maxHr,          setMaxHr]         = useState('')
  const [weightKg,       setWeightKg]      = useState('')
  const [trainingDays,   setTrainingDays]  = useState('')
  const [sportConfigs,   setSportConfigs]  = useState<SportConfig[]>([])
  const [focusedSport,   setFocusedSport]  = useState<string | null>(null)
  const [bodyGoals,      setBodyGoals]     = useState<string[]>([])
  const [personaStyle,   setPersonaStyle]  = useState('')
  const [personaFocus,   setPersonaFocus]  = useState('')
  const [equipment,           setEquipment]           = useState<EquipmentConfig>(DEFAULT_EQUIPMENT)
  const [aestheticGoals,      setAestheticGoals]      = useState<AestheticGoals>(DEFAULT_AESTHETIC)
  const [seasonPhaseOverride, setSeasonPhaseOverride] = useState<'readaptation' | 'base' | 'race' | 'taper' | null>(null)
  const [primaryEventDate,    setPrimaryEventDate]    = useState<string | null>(null)

  // dnd-kit sensors (8px threshold prevents accidental drags on scroll)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // load
  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    ;(async () => {
      const { data } = await supabase
        .from('athletes')
        .select('*')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
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

      setEquipment(a.equipment ?? DEFAULT_EQUIPMENT)

      const ag = a.aesthetic_goals
      setAestheticGoals({
        priorities: ag?.priorities?.length ? ag.priorities : DEFAULT_AESTHETIC.priorities,
        notes: ag?.notes ?? '',
      })

      setSeasonPhaseOverride(a.season_phase_override ?? null)

      // Load primary A-event for auto-phase display
      const { data: goalData } = await supabase
        .from('season_goals')
        .select('event_date')
        .eq('athlete_id', a.id)
        .eq('priority', 'A')
        .eq('active', true)
        .order('event_date', { ascending: true })
        .limit(1)
      setPrimaryEventDate(goalData?.[0]?.event_date ?? null)

      initialized.current = true
    })()
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
          ftp_watts:               ftpWatts     ? parseInt(ftpWatts)     : null,
          max_hr:                  maxHr        ? parseInt(maxHr)        : null,
          weight_kg:               weightKg     ? parseFloat(weightKg)  : null,
          training_days_per_week:  trainingDays ? parseInt(trainingDays) : null,
          sport_types:             sportConfigs.length ? sportConfigs : null,
          body_goals:              bodyGoals.length ? bodyGoals : null,
          coach_persona:           (personaStyle || personaFocus)
                                     ? { style: personaStyle, focus: personaFocus }
                                     : null,
          equipment,
          aesthetic_goals:         aestheticGoals,
          season_phase_override:   seasonPhaseOverride,
        })
        .eq('id', athlete.id)

      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2000)
    }, 800)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, ftpWatts, maxHr, weightKg, trainingDays, sportConfigs, bodyGoals, personaStyle, personaFocus, equipment, aestheticGoals, seasonPhaseOverride])

  // ── sport helpers ───────────────────────────────────────────────────────

  const trainingDaysNum = trainingDays ? parseInt(trainingDays) : 0
  const totalDays = sportConfigs.reduce((sum, s) => sum + s.days, 0)

  function toggleSport(key: string) {
    setFocusedSport(prev => prev === key ? null : key)
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

  // ── equipment helpers ───────────────────────────────────────────────────

  function toggleEquipment(key: keyof EquipmentConfig) {
    setEquipment(prev => {
      if (key === 'gym') {
        return { ...prev, gym: { active: !prev.gym.active } }
      }
      if (prev.gym.active) return prev // gym active → other items locked
      const item = prev[key] as { active: boolean; max_kg?: number }
      return { ...prev, [key]: { ...item, active: !item.active } }
    })
  }

  function setDumbbellMaxKg(val: number) {
    setEquipment(prev => ({ ...prev, dumbbells: { ...prev.dumbbells, max_kg: val } }))
  }

  // ── aesthetic goals helpers ─────────────────────────────────────────────

  // Ensure all 7 muscle groups appear; missing ones appended in default order
  const orderedGroups = (() => {
    const inOrder = aestheticGoals.priorities
      .map(key => MUSCLE_GROUPS.find(g => g.key === key))
      .filter((g): g is { key: string; label: string } => Boolean(g))
    const missing = MUSCLE_GROUPS.filter(g => !aestheticGoals.priorities.includes(g.key))
    return [...inOrder, ...missing]
  })()

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = orderedGroups.map(g => g.key)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    setAestheticGoals(prev => ({
      ...prev,
      priorities: arrayMove(ids, oldIndex, newIndex),
    }))
  }

  const showAesthetic = bodyGoals.includes('Nackt gut ausschauen')

  // ── render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto pb-12">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link to="/dashboard" className="text-brand-500 hover:underline text-sm">
          ← Zurück
        </Link>
        <span className={`text-xs transition-opacity duration-300 ${
          saveState === 'saved'  ? 'text-brand-400 opacity-100' :
          saveState === 'saving' ? 'text-slate-500 opacity-100' : 'opacity-0'
        }`}>
          {saveState === 'saved' ? '✓ Gespeichert' : 'Speichert…'}
        </span>
      </div>

      <h1 className="text-2xl font-bold text-slate-100 mb-6">Profil</h1>

      <div className="flex flex-col gap-4">

        {/* ── Allgemein ──────────────────────────────────────── */}
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

        {/* ── Leistungsdaten ─────────────────────────────────── */}
        <SectionCard title="Leistungsdaten">
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="FTP"     value={ftpWatts} onChange={setFtpWatts} unit="W"   placeholder="250" />
            <NumberField label="Max HF"  value={maxHr}    onChange={setMaxHr}    unit="bpm" placeholder="185" />
            <NumberField label="Gewicht" value={weightKg} onChange={setWeightKg} unit="kg"  placeholder="70" />
          </div>
        </SectionCard>

        {/* ── Training ───────────────────────────────────────── */}
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
            <div className="flex gap-2">
              {SPORT_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => toggleSport(key)}
                  className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                    focusedSport === key
                      ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Akkordeon-Stepper */}
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

        {/* ── Trainingsphase ─────────────────────────────────── */}
        <SectionCard title="Trainingsphase">
          {(() => {
            const weeksUntilEvent = primaryEventDate
              ? Math.round((new Date(primaryEventDate).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000))
              : 99
            const autoPhase = calculateSeasonPhase(weeksUntilEvent, null)
            const autoLabel = primaryEventDate
              ? `Automatisch: ${autoPhase.label} (${weeksUntilEvent} Wochen bis Event)`
              : `Automatisch: ${autoPhase.label} (kein A-Event gesetzt)`
            return (
              <>
                <p className="text-xs text-slate-400 mb-3">{autoLabel}</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {PHASE_OPTIONS.map(opt => (
                    <button
                      key={String(opt.key)}
                      onClick={() => setSeasonPhaseOverride(opt.key)}
                      className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                        seasonPhaseOverride === opt.key
                          ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                          : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {seasonPhaseOverride && (
                  <p className="text-xs text-amber-400/80">
                    Manuell überschrieben — aktiv bis du wieder "Auto" wählst.
                    Sinnvoll nach Krankheit oder Verletzung.
                  </p>
                )}
                {!seasonPhaseOverride && (
                  <p className="text-xs text-slate-600">
                    Überschreibe die automatische Phase wenn du nach Krankheit oder Verletzung zurückgeworfen wurdest.
                  </p>
                )}
              </>
            )
          })()}
        </SectionCard>

        {/* ── Ziel & Coach ───────────────────────────────────── */}
        <SectionCard title="Ziel & Coach-Einstellungen">
          {/* Körperziele */}
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

        {/* ── Equipment ──────────────────────────────────────── */}
        <SectionCard title="Equipment">
          <div className="flex flex-col gap-3">
            {EQUIPMENT_ITEMS.map(item => {
              const itemData = equipment[item.key] as { active: boolean; max_kg?: number }
              const isGymActive = equipment.gym.active
              const isDisabled = isGymActive
              const isActive = isGymActive || itemData.active

              return (
                <div key={item.key} className={`flex items-center gap-3 ${isDisabled ? 'opacity-50' : ''}`}>
                  <button
                    onClick={() => toggleEquipment(item.key)}
                    disabled={isDisabled}
                    className={`w-5 h-5 rounded-md flex items-center justify-center border transition-colors shrink-0 ${
                      isActive
                        ? 'bg-brand-500 border-brand-500'
                        : 'border-slate-600 bg-slate-700 hover:border-slate-500'
                    } disabled:cursor-default`}
                    aria-label={item.label}
                  >
                    {isActive && <Checkmark />}
                  </button>
                  <span className="text-sm text-slate-200 flex-1">{item.label}</span>

                  {/* Kurzhantel kg-Input */}
                  {item.key === 'dumbbells' && itemData.active && !isDisabled && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-400">bis</span>
                      <input
                        type="number"
                        value={equipment.dumbbells.max_kg ?? 20}
                        onChange={e => setDumbbellMaxKg(Number(e.target.value))}
                        min={5} max={200} step={5}
                        className="w-16 bg-slate-700 text-slate-100 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                      <span className="text-xs text-slate-400">kg</span>
                    </div>
                  )}
                </div>
              )
            })}

            <div className="border-t border-slate-700/50 pt-1" />

            {/* Gym — special row */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => toggleEquipment('gym')}
                className={`w-5 h-5 rounded-md flex items-center justify-center border transition-colors shrink-0 ${
                  equipment.gym.active
                    ? 'bg-amber-500 border-amber-500'
                    : 'border-slate-600 bg-slate-700 hover:border-slate-500'
                }`}
                aria-label="Gym"
              >
                {equipment.gym.active && <Checkmark />}
              </button>
              <span className="text-sm text-slate-200 font-medium flex-1">Gym (alles verfügbar)</span>
              {equipment.gym.active && (
                <span className="text-xs text-amber-400">alle aktiviert</span>
              )}
            </div>
          </div>
        </SectionCard>

        {/* ── Ästhetik-Ziele (nur wenn "Nackt gut ausschauen" aktiv) ── */}
        {showAesthetic && (
          <SectionCard title="Körperziele (Priorität)">
            <p className="text-xs text-slate-500 mb-4">
              Ziehe die Muskelgruppen in deine gewünschte Priorität — oben = wichtigster Fokus für den Coach.
            </p>

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedGroups.map(g => g.key)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-2 mb-4">
                  {orderedGroups.map((group, idx) => (
                    <SortableMuscleItem
                      key={group.key}
                      id={group.key}
                      label={group.label}
                      rank={idx + 1}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            <div>
              <label className="text-xs text-slate-400 mb-1 block">
                Besonderheiten (z.B. Muskelimbalancen)
              </label>
              <textarea
                value={aestheticGoals.notes}
                onChange={e => setAestheticGoals(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="z.B. Linker Bizeps schwächer als rechter — ausgleichen"
                rows={2}
                className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
              />
            </div>
          </SectionCard>
        )}

      </div>
    </div>
  )
}
