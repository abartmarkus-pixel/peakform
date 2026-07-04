import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconRunning, IconCycling, IconStrength,
  IconChevronDown, IconWarning,
  SPORT_DISPLAY,
} from '../lib/icons'
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
import { AppHeader } from '../components/AppHeader'
import { useFeatures } from '../lib/features'

// ── constants ──────────────────────────────────────────────────────────────

const SPORT_OPTIONS = [
  { key: 'cycling',  Icon: IconCycling,  color: SPORT_DISPLAY.cycling.color,  label: 'Radfahren'    },
  { key: 'running',  Icon: IconRunning,  color: SPORT_DISPLAY.running.color,  label: 'Laufen'       },
  { key: 'strength', Icon: IconStrength, color: SPORT_DISPLAY.strength.color, label: 'Krafttraining' },
]

const SPORT_LABELS: Record<string, string> = {
  cycling: 'Radfahren',
  running: 'Laufen',
  strength: 'Krafttraining',
}

const BODY_GOALS = [
  'Event',
  'Muskelaufbau',
  'Gewicht reduzieren',
]

const PERSONA_STYLES = [
  { key: 'motivierend', label: 'Motivierend' },
  { key: 'analytisch',  label: 'Analytisch' },
  { key: 'direkt',      label: 'Direkt' },
  { key: 'empathisch',  label: 'Empathisch' },
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

function AccordionSection({
  title, subtitle, open, onToggle, children,
}: {
  title: string; subtitle?: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const prevOpenRef = useRef(open)

  useEffect(() => {
    if (open && !prevOpenRef.current && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevOpenRef.current = open
  }, [open])

  return (
    <div ref={sectionRef} className="bg-slate-800 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3 min-h-[3rem] text-left gap-3"
      >
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider shrink-0">{title}</h2>
        {!open && subtitle && (
          <p className="text-xs text-slate-500 flex-1 text-right truncate">{subtitle}</p>
        )}
        <IconChevronDown
          size={16}
          className={`text-slate-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        style={{
          maxHeight: open ? '2000px' : '0',
          overflow: 'hidden',
          transition: 'max-height 300ms ease-out',
        }}
      >
        <div className="px-5 pb-5">
          {children}
        </div>
      </div>
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
          className="bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        {unit && <span className="text-slate-400 text-sm shrink-0">{unit}</span>}
      </div>
    </div>
  )
}

function Stepper({ value, onDec, onInc, disableDec, disableInc, titleInc }: {
  value: number; onDec: () => void; onInc: () => void
  disableDec?: boolean; disableInc?: boolean; titleInc?: string
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
        title={disableInc ? titleInc : undefined}
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

function UpdatedAt({ updatedAt, staleDays }: { updatedAt: string | null; staleDays: number }) {
  if (!updatedAt) return null
  const date = new Date(updatedAt)
  const daysSince = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  const formatted = new Intl.DateTimeFormat('de-AT', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
  if (daysSince > staleDays) {
    return <p className="text-xs text-amber-400 mt-1 flex items-center gap-1"><IconWarning size={11} /> Zuletzt aktualisiert: {formatted} — Retest empfohlen</p>
  }
  return <p className="text-xs text-slate-500 mt-1">Zuletzt aktualisiert: {formatted}</p>
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
  const [athlete, setAthlete]     = useState<Athlete | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const initialized               = useRef(false)
  const debounce                  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // form state
  const [name,               setName]              = useState('')
  const [gender,             setGender]            = useState<'male' | 'female' | 'diverse' | null>(null)
  const [birthYear,          setBirthYear]          = useState('')
  const [ftpWatts,           setFtpWatts]          = useState('')
  const [maxHr,              setMaxHr]             = useState('')
  const [restingHr,          setRestingHr]         = useState('')
  const [weightKg,           setWeightKg]          = useState('')
  const [best5kInput,        setBest5kInput]        = useState('')
  const [best5kError,        setBest5kError]        = useState<string | null>(null)
  const [trainingDays,       setTrainingDays]       = useState('')
  const [sportConfigs,       setSportConfigs]       = useState<SportConfig[]>([])
  const [focusedSport,       setFocusedSport]       = useState<string | null>(null)
  const [bodyGoals,          setBodyGoals]          = useState<string[]>([])
  const [personaStyle,       setPersonaStyle]       = useState('')
  const [personaFocus,       setPersonaFocus]       = useState('')
  const [equipment,          setEquipment]          = useState<EquipmentConfig>(DEFAULT_EQUIPMENT)
  const [aestheticGoals,     setAestheticGoals]     = useState<AestheticGoals>(DEFAULT_AESTHETIC)
  const [seasonPhaseOverride, setSeasonPhaseOverride] = useState<'readaptation' | 'base' | 'race' | 'taper' | null>(null)
  const [primaryEventDate,   setPrimaryEventDate]   = useState<string | null>(null)

  // _updated_at state
  const [ftpUpdatedAt,    setFtpUpdatedAt]    = useState<string | null>(null)
  const [maxHrUpdatedAt,  setMaxHrUpdatedAt]  = useState<string | null>(null)
  const [weightUpdatedAt, setWeightUpdatedAt] = useState<string | null>(null)
  const [best5kUpdatedAt, setBest5kUpdatedAt] = useState<string | null>(null)

  // track original DB values to detect changes for _updated_at
  const origFtp    = useRef('')
  const origMaxHr  = useRef('')
  const origWeight = useRef('')
  const origBest5k = useRef<number | null>(null)

  // accordion open states — ALLGEMEIN + TRAINING default open
  const [generalOpen,     setGeneralOpen]     = useState(true)
  const [trainingOpen,    setTrainingOpen]     = useState(true)
  const [performanceOpen, setPerformanceOpen]  = useState(false)
  const [goalCoachOpen,   setGoalCoachOpen]    = useState(false)
  const [phaseOpen,       setPhaseOpen]        = useState(false)
  const [strengthOpen,    setStrengthOpen]     = useState(false)


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
      setGender(a.gender ?? null)
      setBirthYear(a.birth_year?.toString() ?? '')
      setFtpWatts(a.ftp_watts?.toString() ?? '')
      setMaxHr(a.max_hr?.toString() ?? '')
      setRestingHr(a.resting_hr?.toString() ?? '')
      setWeightKg(a.weight_kg?.toString() ?? '')
      if (a.best_5k_seconds) {
        const m = Math.floor(a.best_5k_seconds / 60)
        const s = a.best_5k_seconds % 60
        setBest5kInput(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
      }
      setFtpUpdatedAt(a.ftp_updated_at ?? null)
      setMaxHrUpdatedAt(a.max_hr_updated_at ?? null)
      setWeightUpdatedAt(a.weight_updated_at ?? null)
      setBest5kUpdatedAt(a.best_5k_updated_at ?? null)
      origFtp.current    = a.ftp_watts?.toString() ?? ''
      origMaxHr.current  = a.max_hr?.toString() ?? ''
      origWeight.current = a.weight_kg?.toString() ?? ''
      origBest5k.current = a.best_5k_seconds ?? null
      setTrainingDays(a.training_days_per_week?.toString() ?? '')

      const raw = a.sport_types as unknown
      const isNewFormat = Array.isArray(raw) && raw.length > 0 &&
        typeof (raw as unknown[])[0] === 'object' && 'days' in ((raw as unknown[])[0] as object)
      setSportConfigs(isNewFormat ? (raw as SportConfig[]) : [])

      const rawBodyGoals = a.body_goals ?? []
      const migratedBodyGoals = rawBodyGoals.includes('Nackt gut ausschauen')
        ? rawBodyGoals.filter(g => g !== 'Nackt gut ausschauen')
            .concat(rawBodyGoals.length === 1 ? ['Muskelaufbau'] : [])
        : rawBodyGoals
      setBodyGoals(migratedBodyGoals)

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

  // ── derived values — declared before auto-save useEffect ────────────────

  const trainingDaysNum  = trainingDays ? parseInt(trainingDays) : 0
  const totalDays        = sportConfigs.reduce((sum, s) => sum + s.days, 0)
  const hasSportViolation = trainingDaysNum > 0 && totalDays > trainingDaysNum

  // debounced auto-save — fires 800ms after any field change
  useEffect(() => {
    if (!initialized.current || !athlete) return
    if (debounce.current) clearTimeout(debounce.current)

    if (hasSportViolation) {
      setSaveState('idle')
      return
    }

    setSaveState('saving')
    debounce.current = setTimeout(async () => {
      const now = new Date().toISOString()
      const newFtp    = ftpWatts  ? parseInt(ftpWatts)    : null
      const newMaxHr  = maxHr     ? parseInt(maxHr)       : null
      const newWeight = weightKg  ? parseFloat(weightKg)  : null

      let newBest5k: number | null = null
      if (best5kInput.trim()) {
        const m5k = best5kInput.match(/^(\d{1,2}):(\d{2})$/)
        if (m5k) {
          const mins = parseInt(m5k[1])
          const secs = parseInt(m5k[2])
          if (mins >= 10 && mins <= 59 && secs <= 59) newBest5k = mins * 60 + secs
        }
      }

      const ftpChanged    = ftpWatts  !== origFtp.current
      const maxHrChanged  = maxHr     !== origMaxHr.current
      const weightChanged = weightKg  !== origWeight.current
      const best5kChanged = newBest5k !== origBest5k.current

      const updatePayload: Record<string, unknown> = {
        name:                   name.trim() || null,
        gender:                 gender,
        birth_year:             birthYear ? parseInt(birthYear) : null,
        ftp_watts:              newFtp,
        max_hr:                 newMaxHr,
        resting_hr:             restingHr ? parseInt(restingHr) : null,
        weight_kg:              newWeight,
        best_5k_seconds:        newBest5k,
        training_days_per_week: trainingDays ? parseInt(trainingDays) : null,
        sport_types:            sportConfigs.length ? sportConfigs : null,
        body_goals:             bodyGoals.length ? bodyGoals : null,
        coach_persona:          (personaStyle || personaFocus)
                                  ? { style: personaStyle, focus: personaFocus }
                                  : null,
        equipment,
        aesthetic_goals:        aestheticGoals,
        season_phase_override:  seasonPhaseOverride,
      }

      if (ftpChanged    && newFtp    !== null) updatePayload.ftp_updated_at    = now
      if (maxHrChanged  && newMaxHr  !== null) updatePayload.max_hr_updated_at  = now
      if (weightChanged && newWeight !== null) updatePayload.weight_updated_at  = now
      if (best5kChanged && newBest5k !== null) updatePayload.best_5k_updated_at = now

      await supabase.from('athletes').update(updatePayload).eq('id', athlete.id)

      if (ftpChanged    && newFtp    !== null) setFtpUpdatedAt(now)
      if (maxHrChanged  && newMaxHr  !== null) setMaxHrUpdatedAt(now)
      if (weightChanged && newWeight !== null) setWeightUpdatedAt(now)
      if (best5kChanged && newBest5k !== null) setBest5kUpdatedAt(now)

      origFtp.current    = ftpWatts
      origMaxHr.current  = maxHr
      origWeight.current = weightKg
      origBest5k.current = newBest5k

      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2000)
    }, 800)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, gender, birthYear, ftpWatts, maxHr, restingHr, weightKg, best5kInput, trainingDays, sportConfigs, hasSportViolation, bodyGoals, personaStyle, personaFocus, equipment, aestheticGoals, seasonPhaseOverride])

  // ── Tanaka direct save ──────────────────────────────────────────────────

  async function applyTanakaMaxHR() {
    if (!birthYear || !athlete) return
    const age = new Date().getFullYear() - parseInt(birthYear)
    const estimated = Math.round(208 - (0.7 * age))
    const estimatedStr = estimated.toString()

    if (debounce.current) clearTimeout(debounce.current)
    setMaxHr(estimatedStr)

    const now = new Date().toISOString()
    setSaveState('saving')
    await supabase.from('athletes').update({
      max_hr: estimated,
      max_hr_updated_at: now,
    }).eq('id', athlete.id)

    origMaxHr.current = estimatedStr
    setMaxHrUpdatedAt(now)
    setSaveState('saved')
    setTimeout(() => setSaveState('idle'), 2000)
  }

  // ── sport helpers ───────────────────────────────────────────────────────

  function toggleSport(key: string) {
    const isCurrentlyActive = sportConfigs.some(s => s.type === key)
    setFocusedSport(prev => prev === key ? null : key)
    setSportConfigs(prev => {
      if (prev.find(s => s.type === key)) return prev
      const currentSum = prev.reduce((s, c) => s + c.days, 0)
      if (trainingDaysNum > 0 && currentSum >= trainingDaysNum) return prev
      return [...prev, { type: key, days: 1 }]
    })
    if (key === 'strength' && !isCurrentlyActive) setStrengthOpen(true)
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
      if (key === 'gym') return { ...prev, gym: { active: !prev.gym.active } }
      if (prev.gym.active) return prev
      const item = prev[key] as { active: boolean; max_kg?: number }
      return { ...prev, [key]: { ...item, active: !item.active } }
    })
  }

  function setDumbbellMaxKg(val: number) {
    setEquipment(prev => ({ ...prev, dumbbells: { ...prev.dumbbells, max_kg: val } }))
  }

  // ── aesthetic goals helpers ─────────────────────────────────────────────

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

  const features      = useFeatures(athlete)
  const showAesthetic = bodyGoals.includes('Muskelaufbau') || bodyGoals.includes('Gewicht reduzieren')
  const hasStrength   = sportConfigs.some(s => s.type === 'strength') && features.strength

  // ── subtitle computations ───────────────────────────────────────────────

  const generalSubtitle = name.trim() || '—'

  const trainingSubtitle = (() => {
    const parts: string[] = []
    if (trainingDays) parts.push(`${trainingDays} Tage/Woche`)
    if (sportConfigs.length > 0) parts.push(sportConfigs.map(s => SPORT_LABELS[s.type] ?? s.type).join(', '))
    return parts.join(' · ') || '—'
  })()

  const performanceSubtitle = (() => {
    const parts: string[] = []
    if (ftpWatts && sportConfigs.some(s => s.type === 'cycling')) parts.push(`FTP ${ftpWatts}W`)
    if (maxHr) parts.push(`Max HF ${maxHr}`)
    if (weightKg) parts.push(`${weightKg}kg`)
    if (best5kInput && !best5kError && sportConfigs.some(s => s.type === 'running')) parts.push(`5k ${best5kInput}`)
    return parts.join(' · ') || 'Noch nicht konfiguriert'
  })()

  const goalCoachSubtitle = (() => {
    const parts: string[] = []
    if (bodyGoals.length > 0) parts.push(bodyGoals.join(', '))
    if (personaStyle) parts.push(`Coach: ${personaStyle.charAt(0).toUpperCase() + personaStyle.slice(1)}`)
    return parts.join(' · ') || 'Noch nicht konfiguriert'
  })()

  const phaseSubtitle = (() => {
    const weeksUntilEvent = primaryEventDate
      ? Math.round((new Date(primaryEventDate).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000))
      : 99
    const autoPhase = calculateSeasonPhase(weeksUntilEvent, null)
    if (seasonPhaseOverride) {
      const overridePhase = calculateSeasonPhase(weeksUntilEvent, seasonPhaseOverride)
      return `${overridePhase.label} (manuell gesetzt) ⚠`
    }
    return `${autoPhase.label} (automatisch)`
  })()

  const strengthSubtitle = (() => {
    const equipParts: string[] = []
    if (equipment.gym.active) {
      equipParts.push('Gym (alles verfügbar)')
    } else {
      if (equipment.dumbbells.active) equipParts.push(`Kurzhanteln${equipment.dumbbells.max_kg ? ` ${equipment.dumbbells.max_kg}kg` : ''}`)
      if (equipment.bands.active)     equipParts.push('Bänder')
      if (equipment.bodyweight.active) equipParts.push('Körpergewicht')
      if (equipment.pullup_bar.active) equipParts.push('Klimmzugstange')
    }
    const parts: string[] = []
    if (equipParts.length) parts.push(equipParts.join(', '))
    if (showAesthetic && orderedGroups.length > 0) {
      parts.push(`${orderedGroups.slice(0, 3).map(g => g.label).join(', ')} (Priorität)`)
    }
    return parts.join(' + ') || 'Noch nicht konfiguriert'
  })()

  // ── render ──────────────────────────────────────────────────────────────

  return (
    <>
      <AppHeader />
      <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">

      {/* Fixed save status */}
      <div className={`fixed top-4 right-4 z-50 text-xs transition-opacity duration-300 pointer-events-none ${
        saveState !== 'idle' ? 'opacity-100' : 'opacity-0'
      }`}>
        <span className={saveState === 'saved' ? 'text-brand-400' : 'text-slate-500'}>
          {saveState === 'saved' ? '✓ Gespeichert' : 'Speichert…'}
        </span>
      </div>

      <div className="flex flex-col gap-4">

        {/* ── 1. ALLGEMEIN ───────────────────────────────────── */}
        <AccordionSection
          title="Allgemein"
          subtitle={generalSubtitle}
          open={generalOpen}
          onToggle={() => setGeneralOpen(o => !o)}
        >
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Dein Vorname"
                className="bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
              />
            </div>

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
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
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
                className="bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
              />
              <p className="text-xs text-slate-500 mt-1">Wird für Altersberechnung und Max HF Schätzung verwendet</p>
            </div>
          </div>
        </AccordionSection>

        {/* ── 2. TRAINING ────────────────────────────────────── */}
        <AccordionSection
          title="Training"
          subtitle={trainingSubtitle}
          open={trainingOpen}
          onToggle={() => setTrainingOpen(o => !o)}
        >
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

          <div>
            <label className="text-xs text-slate-400 mb-2 block">Sportarten</label>
            <div className="flex flex-wrap gap-2">
              {SPORT_OPTIONS.filter(opt =>
                (opt.key !== 'cycling'  || features.cycling) &&
                (opt.key !== 'strength' || features.strength)
              ).map(({ key, Icon, color, label }) => {
                const isActive = sportConfigs.some(s => s.type === key)
                return (
                  <button
                    key={key}
                    onClick={() => toggleSport(key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-brand-500/20 text-brand-400 ring-1 ring-brand-500'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    <Icon size={14} color={isActive ? undefined : '#94a3b8'} style={isActive ? { color } : undefined} />
                    {label}
                  </button>
                )
              })}
            </div>

            {/* Akkordeon-Stepper */}
            {(() => {
              const config = focusedSport ? sportConfigs.find(s => s.type === focusedSport) : null
              return (
                <div style={{ maxHeight: config ? '72px' : '0', overflow: 'hidden', transition: 'max-height 200ms ease-out' }}>
                  {config && (
                    <div className="mt-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Stepper
                          value={config.days}
                          onDec={() => {
                            if (config.days <= 1) {
                              setSportConfigs(prev => prev.filter(s => s.type !== focusedSport))
                              setFocusedSport(null)
                            } else {
                              updateSportConfig(focusedSport!, { days: config.days - 1 })
                            }
                          }}
                          onInc={() => updateSportConfig(focusedSport!, { days: config.days + 1 })}
                          disableDec={false}
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
                <IconWarning size={11} /> Deine Sporttage ({totalDays}) übersteigen die Trainingstage ({trainingDaysNum}) — bitte anpassen
              </p>
            )}
          </div>
        </AccordionSection>

        {/* ── 3. LEISTUNGSDATEN ──────────────────────────────── */}
        <AccordionSection
          title="Leistungsdaten"
          subtitle={performanceSubtitle}
          open={performanceOpen}
          onToggle={() => setPerformanceOpen(o => !o)}
        >
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <NumberField label="Max HF" value={maxHr} onChange={setMaxHr} unit="bpm" placeholder="185" />
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
              <UpdatedAt updatedAt={maxHrUpdatedAt} staleDays={365} />
              <p className="text-xs text-slate-500 mt-1">Gemessener Wert empfohlen. Ohne Wert: Tanaka-Formel (208 − 0.7 × Alter) als Schätzung.</p>
            </div>
            <div>
              <NumberField label="Ruheherzfrequenz" value={restingHr} onChange={setRestingHr} unit="bpm" placeholder="z.B. 52" />
              <p className="text-xs text-slate-500 mt-1">Morgens vor dem Aufstehen messen</p>
            </div>
            <div>
              <NumberField label="Gewicht" value={weightKg} onChange={setWeightKg} unit="kg" placeholder="70" />
              <UpdatedAt updatedAt={weightUpdatedAt} staleDays={30} />
            </div>
            {sportConfigs.some(s => s.type === 'cycling') && (
              <div>
                <NumberField label="FTP" value={ftpWatts} onChange={setFtpWatts} unit="W" placeholder="250" />
                <UpdatedAt updatedAt={ftpUpdatedAt} staleDays={60} />
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
                  className="bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base w-full focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                {best5kError
                  ? <p className="text-xs text-red-400 mt-1">{best5kError}</p>
                  : <p className="text-xs text-slate-500 mt-1">Wird für Pace-Berechnungen verwendet</p>
                }
                <UpdatedAt updatedAt={best5kUpdatedAt} staleDays={90} />
              </div>
            )}
          </div>
        </AccordionSection>

        {/* ── 4. ZIEL & COACH ────────────────────────────────── */}
        <AccordionSection
          title="Ziel & Coach"
          subtitle={goalCoachSubtitle}
          open={goalCoachOpen}
          onToggle={() => setGoalCoachOpen(o => !o)}
        >
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

          <div>
            <label className="text-xs text-slate-400 mb-1 block">
              Worauf soll der Coach besonders achten?
            </label>
            <textarea
              value={personaFocus}
              onChange={e => setPersonaFocus(e.target.value)}
              placeholder="z.B. Ich neige zu Übertraining, bitte auf Regeneration achten…"
              rows={3}
              className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
            />
          </div>
        </AccordionSection>

        {/* ── 5. TRAININGSPHASE ──────────────────────────────── */}
        <AccordionSection
          title="Trainingsphase"
          subtitle={phaseSubtitle}
          open={phaseOpen}
          onToggle={() => setPhaseOpen(o => !o)}
        >
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
                {seasonPhaseOverride ? (
                  <p className="text-xs text-amber-400/80">
                    Manuell überschrieben — aktiv bis du wieder "Auto" wählst. Sinnvoll nach Krankheit oder Verletzung.
                  </p>
                ) : (
                  <p className="text-xs text-slate-600">
                    Überschreibe die automatische Phase wenn du nach Krankheit oder Verletzung zurückgeworfen wurdest.
                  </p>
                )}
              </>
            )
          })()}
        </AccordionSection>

        {/* ── 6. KRAFTTRAINING (nur wenn strength aktiv) ─────── */}
        {hasStrength && (
          <AccordionSection
            title="Krafttraining"
            subtitle={strengthSubtitle}
            open={strengthOpen}
            onToggle={() => setStrengthOpen(o => !o)}
          >
            {/* Teil A: Equipment */}
            <div className={showAesthetic ? 'mb-6' : ''}>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Equipment</p>
              <div className="flex flex-col gap-3">
                {EQUIPMENT_ITEMS.map(item => {
                  const itemData  = equipment[item.key] as { active: boolean; max_kg?: number }
                  const isGymActive = equipment.gym.active
                  const isActive  = isGymActive || itemData.active
                  return (
                    <div key={item.key} className={`flex items-center gap-3 ${isGymActive ? 'opacity-50' : ''}`}>
                      <button
                        onClick={() => toggleEquipment(item.key)}
                        disabled={isGymActive}
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
                      {item.key === 'dumbbells' && itemData.active && !isGymActive && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-400">bis</span>
                          <input
                            type="number"
                            value={equipment.dumbbells.max_kg ?? 20}
                            onChange={e => setDumbbellMaxKg(Number(e.target.value))}
                            min={5} max={200} step={5}
                            className="w-16 bg-slate-700 text-slate-100 rounded-lg px-2 py-1 text-base text-center focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                          <span className="text-xs text-slate-400">kg</span>
                        </div>
                      )}
                    </div>
                  )
                })}

                <div className="border-t border-slate-700/50 pt-1" />

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
                  {equipment.gym.active && <span className="text-xs text-amber-400">alle aktiviert</span>}
                </div>
              </div>
            </div>

            {/* Teil B: Körperziele (nur wenn Muskelaufbau oder Gewicht reduzieren aktiv) */}
            {showAesthetic && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Körperziele (Priorität)</p>
                <p className="text-xs text-slate-500 mb-4">
                  Ziehe die Muskelgruppen in deine gewünschte Priorität — oben = wichtigster Fokus für den Coach.
                </p>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={orderedGroups.map(g => g.key)} strategy={verticalListSortingStrategy}>
                    <div className="flex flex-col gap-2 mb-4">
                      {orderedGroups.map((group, idx) => (
                        <SortableMuscleItem key={group.key} id={group.key} label={group.label} rank={idx + 1} />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Besonderheiten (z.B. Muskelimbalancen)</label>
                  <textarea
                    value={aestheticGoals.notes}
                    onChange={e => setAestheticGoals(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="z.B. Linker Bizeps schwächer als rechter — ausgleichen"
                    rows={2}
                    className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
                  />
                </div>
              </div>
            )}
          </AccordionSection>
        )}

      </div>
    </div>
    </>
  )
}
