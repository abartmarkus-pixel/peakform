import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type WeeklyPlan, type Activity, type SportConfig } from '../lib/supabase'
import { buildCoachContext } from '../lib/coachContext'
import { buildCoachSystemPrompt } from '../lib/coachPrompt'
import { getValidAccessToken, fetchRecentActivities, syncActivitiesToSupabase } from '../lib/strava'
import { analyzeActivity, parseHevyDescription } from '../lib/activityAnalysis'
import {
  IconRunning, IconCycling, IconStrength, IconRest, IconOther,
  IconChevronLeft, IconChevronRight,
  IconCheck, IconMissed, IconWarning, IconPlan,
  IconGrip, IconMore,
  SPORT_DISPLAY,
} from '../lib/icons'
import { AppHeader } from '../components/AppHeader'
import { useFeatures } from '../lib/features'
import { getISOMonday, getISOSunday, formatWeekRange } from '../lib/dateUtils'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ── types ──────────────────────────────────────────────────────────────────

type DayPlan = {
  type: string
  duration_min?: number
  distance_km?: number
  intensity?: string
  description: string
}

type PlanJson = {
  summary: string
  days: Record<string, DayPlan>
}

type ReviewJson = {
  review: string
  coach_decision_reason: string
  next_week_plan: PlanJson
}

type MatchStatus = 'completed' | 'missed' | 'pending' | 'extra'

type DayMatch = {
  status: MatchStatus
  activity?: Activity
}

// PostgREST returns the embedded resource as an object for a many-to-one
// relationship, but our loose (ungenerated) Supabase types can't express
// that — handle both shapes defensively.
function embeddedActivityDate(row: { activities?: unknown }): string | null {
  const a = row.activities as { date: string } | { date: string }[] | null | undefined
  if (!a) return null
  return (Array.isArray(a) ? a[0]?.date : a.date) ?? null
}

// ── constants ──────────────────────────────────────────────────────────────

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']


// ── constraint validation ──────────────────────────────────────────────────

const REST_KEYWORDS = ['ruhetag', 'erholung', 'regeneration']
const SPORT_KEYWORDS: Record<string, string[]> = {
  cycling:  ['ride', 'radfahren', 'cycling'],
  running:  ['run', 'laufen', 'running'],
  strength: ['kraft', 'weighttraining', 'krafttraining'],
}
const SPORT_LABEL: Record<string, string> = {
  cycling: 'Radfahren', running: 'Laufen', strength: 'Krafttraining',
}

function validateConstraints(planJson: PlanJson, sportConfigs: SportConfig[], trainingDaysRequired: number): string[] {
  if (trainingDaysRequired === 0) return []
  const dayValues = Object.values(planJson.days)

  const trainingCount = dayValues.filter(d =>
    !REST_KEYWORDS.some(k => d.type.toLowerCase().includes(k))
  ).length

  const counts: Record<string, number> = {}
  for (const d of dayValues) {
    const t = d.type.toLowerCase()
    for (const [key, keywords] of Object.entries(SPORT_KEYWORDS)) {
      if (keywords.some(k => t.includes(k))) { counts[key] = (counts[key] ?? 0) + 1; break }
    }
  }

  const issues: string[] = []
  if (trainingCount !== trainingDaysRequired) {
    issues.push(`${trainingCount} von ${trainingDaysRequired} Trainingstagen im Plan`)
  }
  for (const sc of sportConfigs) {
    const actual = counts[sc.type] ?? 0
    if (actual !== sc.days) {
      issues.push(`${SPORT_LABEL[sc.type] ?? sc.type}: ${actual} statt ${sc.days} Tage`)
    }
  }
  return issues
}

// ── manual-edit conflict check (client-seitig, kein Claude-Call) ───────────
// "intensiv" folgt denselben sportwissenschaftlichen Regeln, die der Coach
// beim Planen bekommt (siehe generatePlan()-Prompt, Regeln 3-4): Z3+-Ausdauer
// UND schweres Krafttraining zählen beide als intensiv.

function isRestDay(d: DayPlan): boolean {
  return REST_KEYWORDS.some(k => d.type.toLowerCase().includes(k))
}

function isKraftDay(d: DayPlan): boolean {
  return SPORT_KEYWORDS.strength.some(k => d.type.toLowerCase().includes(k))
}

function isIntensiveEndurance(d: DayPlan): boolean {
  return !isRestDay(d) && !isKraftDay(d) && /^Z[3-5]/i.test(d.intensity ?? '')
}

function isIntensiveDay(d: DayPlan): boolean {
  if (isRestDay(d)) return false
  if (isKraftDay(d)) return true
  return /^Z[3-5]/i.test(d.intensity ?? '')
}

function checkPlanConflicts(days: Record<string, DayPlan>): string | null {
  for (let i = 0; i < DAYS.length - 1; i++) {
    const today = days[DAYS[i]]
    const tomorrow = days[DAYS[i + 1]]
    if (!today || !tomorrow) continue

    if (isKraftDay(today) && isIntensiveEndurance(tomorrow)) {
      return `Krafttraining am ${DAYS[i]} liegt jetzt direkt vor einer intensiven Einheit am ${DAYS[i + 1]}.`
    }
    if (isIntensiveDay(today) && isIntensiveDay(tomorrow)) {
      return `${DAYS[i]} und ${DAYS[i + 1]} sind jetzt beide intensiv — direkt hintereinander ohne Erholung.`
    }
  }
  return null
}

// ── helpers ────────────────────────────────────────────────────────────────

function addWeeks(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n * 7)
  return d
}

function toDateStr(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dayDate(monday: Date, idx: number): string {
  const d = new Date(monday)
  d.setDate(d.getDate() + idx)
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })
}

function parsePlanJson(text: string): PlanJson {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = match ? match[1] : text
  return JSON.parse(raw.trim()) as PlanJson
}

function parseReviewJson(text: string): ReviewJson {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = match ? match[1] : text
  return JSON.parse(raw.trim()) as ReviewJson
}

// Tauscht die Inhalte zweier Tage; die Wochentags-Schlüssel (Mo-So) bleiben fix.
function swapDays(planJson: PlanJson, dayA: string, dayB: string): PlanJson {
  const updated = { ...planJson, days: { ...planJson.days } }
  const temp = updated.days[dayA]
  updated.days[dayA] = updated.days[dayB]
  updated.days[dayB] = temp
  return updated
}

function TypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const t = type.toLowerCase()
  if (['ruhetag', 'erholung', 'regeneration'].some(k => t.includes(k)))
    return <IconRest size={size} color={SPORT_DISPLAY.rest.color} />
  if (['run', 'laufen', 'running'].some(k => t.includes(k)))
    return <IconRunning size={size} color={SPORT_DISPLAY.running.color} />
  if (['ride', 'radfahren', 'cycling'].some(k => t.includes(k)))
    return <IconCycling size={size} color={SPORT_DISPLAY.cycling.color} />
  if (['kraft', 'weighttraining', 'krafttraining'].some(k => t.includes(k)))
    return <IconStrength size={size} color={SPORT_DISPLAY.strength.color} />
  return <IconOther size={size} color={SPORT_DISPLAY.other.color} />
}

const SPORT_MATCH: Record<string, string[]> = {
  laufen:        ['Run', 'VirtualRun', 'TrailRun'],
  run:           ['Run', 'VirtualRun', 'TrailRun'],
  running:       ['Run', 'VirtualRun', 'TrailRun'],
  radfahren:     ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide'],
  ride:          ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide'],
  cycling:       ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide'],
  krafttraining: ['WeightTraining', 'Workout'],
  kraft:         ['WeightTraining', 'Workout'],
  weighttraining:['WeightTraining', 'Workout'],
}

function matchActivityToDay(
  date: Date,
  dayPlan: DayPlan,
  activities: Activity[]
): DayMatch {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(date); d.setHours(0, 0, 0, 0)

  const isOnDate = (a: Activity) => {
    const actDate = new Date(a.date); actDate.setHours(0, 0, 0, 0)
    return actDate.getTime() === d.getTime()
  }

  if (REST_KEYWORDS.some(k => dayPlan.type.toLowerCase().includes(k))) {
    const extra = activities.find(isOnDate)
    return extra ? { status: 'extra', activity: extra } : { status: 'pending' }
  }

  const matchingTypes = SPORT_MATCH[dayPlan.type.toLowerCase()] ?? []

  const matched = activities.find(a => isOnDate(a) && matchingTypes.includes(a.type))

  if (matched) return { status: 'completed', activity: matched }
  if (d < today) return { status: 'missed' }
  return { status: 'pending' }
}

// ── sub-components ─────────────────────────────────────────────────────────

type DayCardProps = {
  day: string; idx: number; monday: Date; plan: DayPlan | undefined
  match?: DayMatch; onPress?: () => void
  onOpenMenu?: (day: string) => void
  dragAttributes?: DraggableAttributes
  dragListeners?: DraggableSyntheticListeners
}

function DayCard({ day, idx, monday, plan, match, onPress, onOpenMenu, dragAttributes, dragListeners }: DayCardProps) {
  const isRest = !plan || REST_KEYWORDS.some(k => plan.type.toLowerCase().includes(k))
  const isKraft = plan ? SPORT_KEYWORDS.strength.some(k => plan.type.toLowerCase().includes(k)) : false
  const workoutLabel = isKraft && plan?.description
    ? (plan.description.match(/^Workout (III|II|I)$/i)?.[0] ?? null)
    : null

  const borderClass =
    match?.status === 'completed' ? 'border-l-[3px] border-l-brand-500' :
    match?.status === 'missed'    ? 'border-l-[3px] border-l-amber-500' :
    match?.status === 'extra'     ? 'border-l-[3px] border-l-blue-500' : ''
  const isClickable = (match?.status === 'completed' || match?.status === 'extra') && !!onPress

  return (
    <div
      className={`rounded-xl p-3.5 ${isRest ? 'bg-slate-800/50' : 'bg-slate-800'} ${borderClass} ${isClickable ? 'cursor-pointer active:bg-slate-700' : ''}`}
      onClick={isClickable ? onPress : undefined}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold text-slate-400 w-6">{day}</span>
          <span className="text-xs text-slate-600">{dayDate(monday, idx)}</span>
        </div>
        <div className="flex items-center gap-2">
          {plan && !isRest && (
            <span className="text-xs text-slate-500">
              {plan.duration_min ? `${plan.duration_min} min` : ''}
              {plan.distance_km && !['laufen', 'run', 'running'].includes(plan.type.toLowerCase())
                ? ` · ${plan.distance_km} km` : ''}
            </span>
          )}
          {match?.status === 'completed' && (
            <IconCheck size={12} className="text-brand-400" />
          )}
          {match?.status === 'missed' && (
            <IconMissed size={12} className="text-amber-400" />
          )}
          {match?.status === 'extra' && (
            <span className="text-[10px] font-semibold text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded-full">
              Extra
            </span>
          )}
          {onOpenMenu && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onOpenMenu(day) }}
              className="p-1.5 -m-1.5 text-slate-500 hover:text-slate-300"
              aria-label={`Optionen für ${day}`}
            >
              <IconMore size={14} />
            </button>
          )}
          {dragAttributes && dragListeners && (
            <button
              type="button"
              {...dragAttributes}
              {...dragListeners}
              className="touch-none cursor-grab active:cursor-grabbing p-1.5 -m-1.5 text-slate-500"
              aria-label={`${day} verschieben`}
            >
              <IconGrip size={14} />
            </button>
          )}
        </div>
      </div>

      {plan ? (
        <>
          <div className={`flex items-center gap-1.5 ${isKraft ? '' : 'mb-1.5'}`}>
            <TypeIcon type={plan.type} size={16} />
            <span className={`text-sm font-semibold ${isRest ? 'text-slate-500' : 'text-slate-100'}`}>
              {plan.type}
            </span>
            {workoutLabel && (
              <span className="text-xs font-semibold text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded-full">
                {workoutLabel}
              </span>
            )}
            {plan.intensity && (
              <span className="text-xs text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded-full">
                {plan.intensity}
              </span>
            )}
          </div>
          {!isKraft && (
            <p className={`text-xs leading-relaxed ${isRest ? 'text-slate-600' : 'text-slate-400'}`}>
              {plan.description}
            </p>
          )}
          {match?.status === 'completed' && match.activity && (
            <p className="text-xs text-brand-400/70 mt-1.5 truncate flex items-center gap-1">
              <IconCheck size={10} className="text-brand-400 shrink-0" />
              {match.activity.name}
              {match.activity.duration_s ? ` · ${Math.round(match.activity.duration_s / 60)} min` : ''}
            </p>
          )}
          {match?.status === 'missed' && !isRest && (
            <p className="text-xs text-amber-400/70 mt-1.5 flex items-center gap-1">
              <IconMissed size={10} className="text-amber-400 shrink-0" />
              Nicht absolviert
            </p>
          )}
          {match?.status === 'extra' && match.activity && (
            <p className="text-xs text-blue-400/70 mt-1.5 truncate flex items-center gap-1">
              <IconOther size={10} className="text-blue-400 shrink-0" />
              Zusätzlich trainiert: {match.activity.name}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-slate-600">—</p>
      )}
    </div>
  )
}

// Drag wird ausschließlich über den Griff-Button in DayCard ausgelöst (dragAttributes/
// dragListeners werden dorthin durchgereicht) — der Rest der Karte bleibt normal
// scrollbar/tappbar, kein touch-none auf dem Wrapper.
function SortableDayCard(props: DayCardProps) {
  const { day } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: day })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <DayCard {...props} dragAttributes={attributes} dragListeners={listeners} />
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function WeeklyPlan() {
  const navigate = useNavigate()
  const [athlete, setAthlete]         = useState<Athlete | null>(null)
  const [monday, setMonday]           = useState<Date>(getISOMonday(new Date()))
  const [plan, setPlan]               = useState<WeeklyPlan | null>(null)
  const [weekActivities, setWeekActivities] = useState<Activity[]>([])
  const [generating, setGenerating]   = useState(false)
  const [loadingPlan, setLoadingPlan] = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null)
  const [pendingPlanJson, setPendingPlanJson] = useState<PlanJson | null>(null)
  const [violation, setViolation]     = useState<string[]>([])
  const [manualPlanJson, setManualPlanJson] = useState<PlanJson | null>(null)
  const [contextMenuDay, setContextMenuDay] = useState<string | null>(null)
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false)
  const [pendingManualConflict, setPendingManualConflict] = useState<string | null>(null)
  const [pendingManualChangeReason, setPendingManualChangeReason] = useState<string | null>(null)
  const [manualToast, setManualToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const previousManualPlanJson = useRef<PlanJson | null>(null)
  // review
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [reviewing, setReviewing]     = useState(false)
  const [reviewResult, setReviewResult] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [pendingReviewData, setPendingReviewData] = useState<ReviewJson | null>(null)
  const [reviewViolationList, setReviewViolationList] = useState<string[]>([])

  const isCurrentWeek = toDateStr(monday) === toDateStr(getISOMonday(new Date()))
  const weekStr = toDateStr(monday)

  // dnd-kit sensors: delay+tolerance statt distance — verhindert, dass normales
  // vertikales Scrollen auf Mobile als Drag-Start interpretiert wird (der Griff-Button
  // in DayCard ist ohnehin die einzige Drag-Fläche, siehe SortableDayCard)
  const daySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    if (!manualToast) return
    const t = setTimeout(() => setManualToast(null), 2500)
    return () => clearTimeout(t)
  }, [manualToast])

  // load athlete once
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
        if (!useFeatures(a).weekly_plan) { navigate('/dashboard', { replace: true }); return }
        setAthlete(a)
      })
  }, [navigate])

  // load plan + week activities whenever week changes (with Strava mini-sync)
  useEffect(() => {
    if (!athlete) return
    setLoadingPlan(true)
    setPlan(null)
    setWeekActivities([])
    setReviewResult(null)
    setReviewFeedback('')
    setManualPlanJson(null)
    setPendingManualConflict(null)
    setPendingManualChangeReason(null)

    ;(async () => {
      // Mini-sync: pull latest 10 activities from Strava → upsert to Supabase
      try {
        const token = await getValidAccessToken(athlete)
        const acts = await fetchRecentActivities(token)
        await syncActivitiesToSupabase(acts, athlete.id)
      } catch { /* sync failure doesn't block UI */ }

      // Fallback: alte Einträge wurden mit UTC-Datum gespeichert (1 Tag früher)
      const weekStrFallback = toDateStr(new Date(monday.getTime() - 86400000))

      const [planRes, actsRes] = await Promise.all([
        supabase
          .from('weekly_plans')
          .select('*')
          .eq('athlete_id', athlete.id)
          .in('week_start', [weekStr, weekStrFallback])
          .order('version', { ascending: false })
          .limit(1),
        supabase
          .from('activities')
          .select('*')
          .eq('athlete_id', athlete.id)
          .gte('date', monday.toISOString())
          .lte('date', getISOSunday(monday).toISOString())
          .order('date', { ascending: true }),
      ])
      setPlan(planRes.data?.[0] as WeeklyPlan ?? null)
      const acts = (actsRes.data ?? []) as Activity[]
      setWeekActivities(acts)

      setLoadingPlan(false)
    })()
  }, [athlete, weekStr])

  async function savePlanJson(planJson: PlanJson, hasViolation: boolean) {
    if (!athlete) return
    const { data: existing } = await supabase
      .from('weekly_plans')
      .select('version')
      .eq('athlete_id', athlete.id)
      .eq('week_start', weekStr)
      .order('version', { ascending: false })
      .limit(1)
    const nextVersion = (existing?.[0]?.version ?? 0) + 1

    const { data: inserted } = await supabase
      .from('weekly_plans')
      .insert({
        athlete_id:    athlete.id,
        week_start:    weekStr,
        version:       nextVersion,
        plan_json:     planJson,
        change_reason: nextVersion === 1 ? 'Erstplan' : 'Manuell neu generiert',
        ...(hasViolation && { plan_constraint_violation: true }),
      })
      .select()
      .single()

    await supabase.from('coach_decisions').insert({
      athlete_id:       athlete.id,
      decision_type:    'plan_generated',
      decision_summary: `Wochenplan v${nextVersion} für KW ${weekStr} erstellt${hasViolation ? ' (Constraint-Abweichung)' : ''}`,
      reasoning:        planJson.summary,
      related_plan_id:  (inserted as WeeklyPlan)?.id ?? null,
    })

    setPlan(inserted as WeeklyPlan)
    setPendingPlanJson(null)
    setViolation([])
  }

  // Fallback in case the fire-and-forget background analysis (triggered by
  // syncActivitiesToSupabase) hasn't finished or failed for some activity of
  // the last 7 days: catches it up synchronously before plan/review use the
  // coach context, so [LETZTE AKTIVITÄTS-ANALYSE] is never stale.
  async function closeOutstandingAnalyses() {
    if (!athlete) return
    try {
      const sevenDaysAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const { data: stillUnanalyzed } = await supabase
        .from('activities')
        .select('*')
        .eq('athlete_id', athlete.id)
        .is('claude_analysis', null)
        .gte('date', sevenDaysAgoDate.toISOString())

      if (!stillUnanalyzed?.length) return

      setLoadingMessage(`Schließe ${stillUnanalyzed.length} ausstehende Analyse(n) ab…`)
      for (const act of stillUnanalyzed as Activity[]) {
        const result = await analyzeActivity(act, athlete.id)
        if (!result.success) {
          console.error(`Fallback analysis failed for activity ${act.strava_id}:`, result.error)
        }
      }
    } catch (e) {
      // This is a safety net, not the primary feature — a lookup failure here
      // must never block the actual plan/review generation that follows.
      console.error('Fallback analysis sweep failed:', e)
    } finally {
      setLoadingMessage(null)
    }
  }

  async function generatePlan() {
    if (!athlete) return
    setGenerating(true)
    setError(null)
    setPendingPlanJson(null)
    setViolation([])

    try {
      await closeOutstandingAnalyses()

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [context, systemPrompt, { data: recoveryRows }] = await Promise.all([
        buildCoachContext(athlete.id),
        buildCoachSystemPrompt(athlete.id),
        supabase
          .from('coach_decisions')
          .select('decision_summary, reasoning, created_at, activities!related_activity_id!inner(date)')
          .eq('athlete_id', athlete.id)
          .eq('decision_type', 'recovery_required')
          .gte('activities.date', sevenDaysAgo)
          .order('date', { referencedTable: 'activities', ascending: false }),
      ])

      const monday8 = monday.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
      const sunday8 = getISOSunday(monday)
        .toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })

      const sportConfigs = (athlete.sport_types as SportConfig[] | null) ?? []
      const trainingDays = athlete.training_days_per_week ?? 0
      if (trainingDays === 0) {
        setError('Bitte zuerst Trainingstage im Profil konfigurieren.')
        return
      }
      const calendarRestDays = 7 - trainingDays

      const sportConstraintLines = sportConfigs.map(s =>
        `- ${SPORT_LABEL[s.type] ?? s.type}: exakt ${s.days} ${s.days === 1 ? 'Tag' : 'Tage'}`
      ).join('\n')

      const selfCheckLines = sportConfigs.map(s =>
        `- ${SPORT_LABEL[s.type] ?? s.type}: exakt ${s.days} ${s.days === 1 ? 'Tag' : 'Tage'} geplant?`
      ).join('\n')

      const recoverySection = recoveryRows?.length
        ? `\nAKTUELLE ERHOLUNGS-EINSCHRÄNKUNGEN (höchste Priorität — überschreiben alle anderen Regeln):\n${
            recoveryRows.map(d =>
              `- ${new Date(embeddedActivityDate(d) ?? d.created_at).toLocaleDateString('de-DE')}: ${d.reasoning ?? d.decision_summary}`
            ).join('\n')
          }\n`
        : ''

      const prompt = `${context}

---

Erstelle den Wochenplan für die Woche vom ${monday8} bis ${sunday8}.

HARTE REGELN (nicht verhandelbar):
1. Gesamttage: Der Plan enthält exakt ${trainingDays} Trainingstage und ${calendarRestDays} Ruhetage (Mo–So = 7 Tage).
2. Sportarten-Verteilung (exakt einhalten):
${sportConstraintLines}
${recoverySection}
SPORTWISSENSCHAFTLICHE REIHENFOLGE-REGELN:
3. Nie zwei intensive Einheiten (Z3+, Tempolauf, schweres Krafttraining) an aufeinanderfolgenden Tagen.
4. Krafttraining nie am Tag vor einer intensiven Ausdauereinheit.
5. Krafttraining optimal: nach einem leichten Ausdauertag oder als eigenständiger Tag.
6. Nach 2-3 belastenden Tagen folgt ein aktiver Erholungstag (Z1/Z2) oder Ruhetag.

LAUFEINHEITEN — PFLICHT:
7. Für alle Einheiten mit type "Laufen" oder "Run": setze distance_km IMMER auf null. Gib NUR duration_min an. Die HF-Zone ist die einzige Vorgabe — die Distanz ergibt sich beim Training automatisch.

KRAFTTRAINING-ROTATION (zwingend):
8. Krafteinheiten rotieren IMMER in der Reihenfolge Workout I → Workout II → Workout III → Workout I → …
9. Das 'description'-Feld einer Kraft-Einheit enthält NUR exakt "Workout I", "Workout II" oder "Workout III" — keinen anderen Text.
10. Schaue im Coach-Kontext nach dem zuletzt geplanten Kraft-Workout und setze die Rotation fort. Nie zweimal hintereinander das gleiche Workout.

SELF-CHECK VOR AUSGABE — prüfe intern:
- Gesamttage: stimmt die Anzahl mit ${trainingDays} überein?
${selfCheckLines}
- Keine zwei intensiven Tage aufeinanderfolgend?
- Kein Krafttraining vor intensiver Ausdauer?
- Kraft-description exakt "Workout I", "Workout II" oder "Workout III" und korrekte Rotation?
Wenn eine Prüfung fehlschlägt, korrigiere den Plan BEVOR du ihn ausgibst.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt — kein Text davor oder danach, kein Markdown:
{
  "summary": "Einzeiliger Wochen-Überblick (max 120 Zeichen)",
  "days": {
    "Mo": { "type": "Ruhetag|Radfahren|Laufen|Kraft", "duration_min": 0, "distance_km": null, "intensity": null, "description": "Kurze Beschreibung (oder 'Workout I' bei Kraft)" },
    "Di": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Mi": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Do": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Fr": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Sa": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "So": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." }
  }
}`

      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, max_tokens: 2048, system: systemPrompt }),
      })
      if (!res.ok) throw new Error('API Fehler')
      const { text } = await res.json() as { text: string }
      const planJson = parsePlanJson(text)

      // Validate constraints
      const issues = validateConstraints(planJson, sportConfigs, trainingDays)
      if (issues.length > 0) {
        setPendingPlanJson(planJson)
        setViolation(issues)
        return
      }

      await savePlanJson(planJson, false)
    } catch (e) {
      console.error(e)
      setError('Plan-Generierung fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setGenerating(false)
      setLoadingMessage(null)
    }
  }

  async function saveReviewData(data: ReviewJson, hasViolation: boolean) {
    if (!athlete) return
    const nextMonday = addWeeks(monday, 1)
    const nextWeekStr = toDateStr(nextMonday)

    const { data: existingNext } = await supabase
      .from('weekly_plans')
      .select('version')
      .eq('athlete_id', athlete.id)
      .eq('week_start', nextWeekStr)
      .order('version', { ascending: false })
      .limit(1)
    const nextVersion = (existingNext?.[0]?.version ?? 0) + 1

    const { data: newPlan } = await supabase
      .from('weekly_plans')
      .insert({
        athlete_id:              athlete.id,
        week_start:              nextWeekStr,
        version:                 nextVersion,
        plan_json:               data.next_week_plan,
        review_notes:            data.review,
        change_reason:           `Review KW ${weekStr}: ${data.coach_decision_reason}`,
        ...(hasViolation && { plan_constraint_violation: true }),
      })
      .select()
      .single()

    await supabase.from('coach_decisions').insert({
      athlete_id:       athlete.id,
      decision_type:    'weekly_review',
      decision_summary: `Review KW ${weekStr} → Plan für KW ${nextWeekStr} v${nextVersion}`,
      reasoning:        data.coach_decision_reason,
      related_plan_id:  (newPlan as WeeklyPlan)?.id ?? null,
    })

    setReviewResult(data.review)
    setPendingReviewData(null)
    setReviewViolationList([])
  }

  async function startReview() {
    if (!athlete) return
    setReviewing(true)
    setReviewResult(null)
    setReviewError(null)
    setPendingReviewData(null)
    setReviewViolationList([])

    const sportConfigs = (athlete.sport_types as SportConfig[] | null) ?? []
    const trainingDaysRequired = athlete.training_days_per_week ?? 0
    const calendarRestDays = 7 - trainingDaysRequired
    const sportConstraintLines = sportConfigs.map(s =>
      `- ${SPORT_LABEL[s.type] ?? s.type}: exakt ${s.days} ${s.days === 1 ? 'Tag' : 'Tage'}`
    ).join('\n')
    const selfCheckLines = sportConfigs.map(s =>
      `- ${SPORT_LABEL[s.type] ?? s.type}: exakt ${s.days} ${s.days === 1 ? 'Tag' : 'Tage'} geplant?`
    ).join('\n')

    try {
      await closeOutstandingAnalyses()

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [context, systemPrompt, { data: recoveryRows }] = await Promise.all([
        buildCoachContext(athlete.id),
        buildCoachSystemPrompt(athlete.id),
        supabase
          .from('coach_decisions')
          .select('decision_summary, reasoning, created_at, activities!related_activity_id!inner(date)')
          .eq('athlete_id', athlete.id)
          .eq('decision_type', 'recovery_required')
          .gte('activities.date', sevenDaysAgo)
          .order('date', { referencedTable: 'activities', ascending: false }),
      ])

      const reviewRecoverySection = recoveryRows?.length
        ? `\nAKTUELLE ERHOLUNGS-EINSCHRÄNKUNGEN (höchste Priorität — überschreiben alle anderen Regeln):\n${
            recoveryRows.map(d =>
              `- ${new Date(embeddedActivityDate(d) ?? d.created_at).toLocaleDateString('de-DE')}: ${d.reasoning ?? d.decision_summary}`
            ).join('\n')
          }\n`
        : ''

      const nextMonday = addWeeks(monday, 1)
      const nextSunday = getISOSunday(nextMonday)

      const actsText = weekActivities.length > 0
        ? weekActivities.map(a =>
            `- ${new Date(a.date).toLocaleDateString('de-DE')}: ${a.name} (${a.type}` +
            (a.duration_s ? `, ${Math.round(a.duration_s / 60)} min` : '') +
            (a.distance_m && a.distance_m > 0 ? `, ${(a.distance_m / 1000).toFixed(1)} km` : '') +
            (a.avg_hr ? `, Ø ${Math.round(a.avg_hr)} bpm` : '') +
            (a.np_watts ? `, NP ${Math.round(a.np_watts)} W` : '') + ')'
          ).join('\n')
        : 'Keine Aktivitäten aufgezeichnet.'

      const currentPlanJson = plan?.plan_json as PlanJson | null

      const constraintSection = trainingDaysRequired > 0 ? `

HARTE REGELN für next_week_plan (nicht verhandelbar):
1. Gesamttage: Der Plan enthält exakt ${trainingDaysRequired} Trainingstage und ${calendarRestDays} Ruhetage (Mo–So = 7 Tage).
2. Sportarten-Verteilung (exakt einhalten):
${sportConstraintLines}
${reviewRecoverySection}
SELF-CHECK für next_week_plan vor Ausgabe — prüfe intern:
- Gesamttage: stimmt mit ${trainingDaysRequired} Trainingstagen überein?
${selfCheckLines}
- Keine zwei intensiven Tage aufeinanderfolgend?
- Kraft-description exakt "Workout I", "Workout II" oder "Workout III" und korrekte Rotation?
Wenn eine Prüfung fehlschlägt, korrigiere den Plan BEVOR du ihn ausgibst.` : ''

      const prompt = `${context}

---

Erstelle ein Wochenreview für die Woche ${formatWeekRange(monday)}.

Tatsächlich absolvierte Aktivitäten diese Woche:
${actsText}
${currentPlanJson ? `\nGeplant war: ${currentPlanJson.summary}` : ''}

Feedback des Athleten:
${reviewFeedback.trim() || 'Kein Feedback angegeben.'}
${constraintSection}

Erstelle nun:
1. Eine direkte Wochenbewertung (3-4 Sätze): Belastungssteuerung, Ausführung vs. Plan, was gut lief, was nicht
2. Den optimierten Trainingsplan für nächste Woche (${nextMonday.toLocaleDateString('de-DE')} – ${nextSunday.toLocaleDateString('de-DE')})
3. Eine kurze Begründung der Anpassungen

Antworte AUSSCHLIESSLICH mit diesem JSON (kein Text davor/danach, kein Markdown):
{
  "review": "Deine Wochenbewertung (3-4 Sätze, direkt und konkret, auf Deutsch)",
  "coach_decision_reason": "Begründung der wichtigsten Anpassungen für nächste Woche (1-2 Sätze)",
  "next_week_plan": {
    "summary": "Einzeiliger Überblick nächste Woche (max 120 Zeichen)",
    "days": {
      "Mo": { "type": "Ruhetag|Ride|Run|Kraft|Schwimmen|Hike|Lockerung", "duration_min": 0, "distance_km": null, "intensity": null, "description": "Kurze Beschreibung (bei Kraft NUR 'Workout I', 'Workout II' oder 'Workout III')" },
      "Di": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
      "Mi": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
      "Do": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
      "Fr": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
      "Sa": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
      "So": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." }
    }
  }
}

WICHTIG für Krafttraining: Das 'description'-Feld bei Kraft-Einheiten enthält NUR "Workout I", "Workout II" oder "Workout III" (Rotation fortsetzen, nie dasselbe wie die letzte Kraft-Einheit).
WICHTIG für Laufeinheiten: Bei type "Run" oder "Laufen" — distance_km IMMER null. Nur duration_min angeben.`

      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, max_tokens: 3000, system: systemPrompt }),
      })
      if (!res.ok) throw new Error('API Fehler')
      const { text } = await res.json() as { text: string }

      const parsed = parseReviewJson(text)
      const violations = trainingDaysRequired > 0
        ? validateConstraints(parsed.next_week_plan, sportConfigs, trainingDaysRequired)
        : []

      if (violations.length > 0) {
        setPendingReviewData(parsed)
        setReviewViolationList(violations)
        return
      }

      await saveReviewData(parsed, false)
    } catch (e) {
      console.error(e)
      setReviewError('Review fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setReviewing(false)
      setLoadingMessage(null)
    }
  }

  const planJson = plan?.plan_json as PlanJson | null
  const basePlanJson = pendingPlanJson ?? planJson
  const displayPlanJson = manualPlanJson ?? basePlanJson

  // Wendet eine manuelle Planänderung an und prüft sie sofort auf Konflikte.
  // Ohne Konflikt: sofort committen. Mit Konflikt: Änderung bleibt sichtbar,
  // aber "ungesichert" bis der Athlet "Trotzdem speichern" oder "Abbrechen" wählt.
  function applyManualEdit(updatedPlan: PlanJson, changeReason: string) {
    previousManualPlanJson.current = manualPlanJson
    setManualPlanJson(updatedPlan)
    const conflict = checkPlanConflicts(updatedPlan.days)
    if (conflict) {
      setPendingManualConflict(conflict)
      setPendingManualChangeReason(changeReason)
    } else {
      commitManualChange(changeReason)
    }
  }

  // Gleiche Versionierungs-Logik wie savePlanJson()/saveReviewData(): INSERT-only, version++
  async function saveManualPlanChange(updatedPlan: PlanJson, changeReason: string, hasViolation: boolean) {
    if (!athlete) return
    const { data: existing } = await supabase
      .from('weekly_plans')
      .select('version')
      .eq('athlete_id', athlete.id)
      .eq('week_start', weekStr)
      .order('version', { ascending: false })
      .limit(1)
    const nextVersion = (existing?.[0]?.version ?? 0) + 1

    const { data: inserted, error } = await supabase
      .from('weekly_plans')
      .insert({
        athlete_id:    athlete.id,
        week_start:    weekStr,
        version:       nextVersion,
        plan_json:     updatedPlan,
        change_reason: changeReason,
        ...(hasViolation && { plan_constraint_violation: true }),
      })
      .select()
      .single()
    if (error) throw error

    await supabase.from('coach_decisions').insert({
      athlete_id:       athlete.id,
      decision_type:    'manual_plan_edit',
      decision_summary: `Wochenplan v${nextVersion} für KW ${weekStr} manuell angepasst: ${changeReason}${hasViolation ? ' (Konflikt bestätigt)' : ''}`,
      related_plan_id:  (inserted as WeeklyPlan)?.id ?? null,
    })

    setPlan(inserted as WeeklyPlan)
    setManualPlanJson(null)
  }

  async function commitManualChange(changeReason: string) {
    const hasViolation = !!pendingManualConflict
    setPendingManualConflict(null)
    setPendingManualChangeReason(null)
    if (!manualPlanJson) return
    try {
      await saveManualPlanChange(manualPlanJson, changeReason, hasViolation)
      setManualToast({ type: 'success', message: 'Plan aktualisiert ✓' })
    } catch (e) {
      console.error(e)
      setManualToast({ type: 'error', message: 'Speichern fehlgeschlagen. Bitte erneut versuchen.' })
    }
  }

  function cancelManualEdit() {
    setManualPlanJson(previousManualPlanJson.current)
    setPendingManualConflict(null)
    setPendingManualChangeReason(null)
  }

  function handleDayDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !displayPlanJson) return
    const dayA = String(active.id)
    const dayB = String(over.id)
    applyManualEdit(swapDays(displayPlanJson, dayA, dayB), `Manuell verschoben: ${dayA} ↔ ${dayB}`)
  }

  function handleOpenMenu(day: string) {
    setContextMenuDay(day)
    setMoveSubmenuOpen(false)
  }

  function closeContextMenu() {
    setContextMenuDay(null)
    setMoveSubmenuOpen(false)
  }

  function handleMarkAsRest(day: string) {
    if (!displayPlanJson) return
    const updated = { ...displayPlanJson, days: { ...displayPlanJson.days } }
    updated.days[day] = { type: 'Ruhetag', duration_min: 0, distance_km: undefined, intensity: undefined, description: 'Manuell freigehalten' }
    applyManualEdit(updated, `${day} als Ruhetag markiert`)
    closeContextMenu()
  }

  function handleMoveDay(dayA: string, dayB: string) {
    if (!displayPlanJson) return
    applyManualEdit(swapDays(displayPlanJson, dayA, dayB), `Manuell verschoben: ${dayA} ↔ ${dayB}`)
    closeContextMenu()
  }

  const weekStats = useMemo(() => {
    if (!displayPlanJson) return null

    let totalCount = 0
    let completedCount = 0
    DAYS.forEach((day, idx) => {
      const dayPlan = displayPlanJson.days?.[day]
      if (!dayPlan || REST_KEYWORDS.some(k => dayPlan.type.toLowerCase().includes(k))) return
      totalCount++
      const date = new Date(monday); date.setDate(date.getDate() + idx)
      if (matchActivityToDay(date, dayPlan, weekActivities).status === 'completed') completedCount++
    })

    const runningKm = weekActivities
      .filter(a => SPORT_MATCH.running.includes(a.type))
      .reduce((sum, a) => sum + (a.distance_m ?? 0) / 1000, 0)
    const cyclingKm = weekActivities
      .filter(a => SPORT_MATCH.radfahren.includes(a.type))
      .reduce((sum, a) => sum + (a.distance_m ?? 0) / 1000, 0)
    const strengthKg = weekActivities
      .filter(a => SPORT_MATCH.krafttraining.includes(a.type) && a.description)
      .reduce((sum, a) => sum + parseHevyDescription(a.description!).reduce((v, ex) => v + ex.totalVolume, 0), 0)

    return { totalCount, completedCount, runningKm, cyclingKm, strengthKg }
  }, [displayPlanJson, weekActivities, monday])

  const showWeekStats = !!weekStats && (weekActivities.length > 0 || weekStats.completedCount > 0)

  return (
    <>
      <AppHeader />
      <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">

      {/* Week navigation */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => setMonday(m => getISOMonday(new Date(m.getTime() - 7 * 86400000)))}
          className="w-9 h-9 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors shrink-0"
        >
          <IconChevronLeft size={16} />
        </button>
        <div className="flex-1 text-center px-2">
          <p className="text-sm font-semibold text-slate-200">{formatWeekRange(monday)}</p>
          {isCurrentWeek && <p className="text-xs text-brand-400">Aktuelle Woche</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setMonday(m => getISOMonday(new Date(m.getTime() + 7 * 86400000)))}
            className="w-9 h-9 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors"
          >
            <IconChevronRight size={16} />
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {/* Plan summary */}
      {displayPlanJson?.summary && (
        <div className="bg-brand-500/10 border border-brand-500/20 rounded-xl px-4 py-3 mb-4">
          <p className="text-sm text-slate-300 leading-relaxed">{displayPlanJson.summary}</p>
        </div>
      )}

      {/* Wochen-Kennzahlen-Leiste */}
      {showWeekStats && weekStats && (
        <div className="bg-slate-800 border border-slate-700/50 rounded-xl px-4 py-3 mb-4">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-2 text-base text-slate-400">
              <IconRunning size={20} color={SPORT_DISPLAY.running.color} />
              {weekStats.runningKm.toFixed(1)} km
            </span>
            <span className="flex items-center gap-2 text-base text-slate-400">
              <IconCycling size={20} color={SPORT_DISPLAY.cycling.color} />
              {weekStats.cyclingKm.toFixed(1)} km
            </span>
            <span className="flex items-center gap-2 text-base text-slate-400">
              <IconStrength size={20} color={SPORT_DISPLAY.strength.color} />
              {weekStats.strengthKg.toLocaleString('de-DE', { maximumFractionDigits: 0 })} kg
            </span>
          </div>
        </div>
      )}

      {/* Day cards */}
      {loadingPlan ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : displayPlanJson ? (
        <DndContext sensors={daySensors} collisionDetection={closestCenter} onDragEnd={handleDayDragEnd}>
          <SortableContext items={DAYS} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2 mb-6">
              {DAYS.map((day, idx) => {
                const dayPlan = displayPlanJson.days?.[day]
                const date = new Date(monday); date.setDate(date.getDate() + idx)
                const match = dayPlan ? matchActivityToDay(date, dayPlan, weekActivities) : undefined
                return (
                  <SortableDayCard
                    key={day}
                    day={day}
                    idx={idx}
                    monday={monday}
                    plan={dayPlan}
                    match={match}
                    onPress={match?.activity ? () => navigate(`/activity/${match.activity!.strava_id}`) : undefined}
                    onOpenMenu={handleOpenMenu}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="text-center py-12 text-slate-500 mb-6">
          <IconPlan size={40} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm">Noch kein Plan für diese Woche.</p>
        </div>
      )}

      {/* Manuelle Planänderung: Konflikt-Warnung (nicht-blockierend) */}
      {pendingManualConflict && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4">
          <p className="text-amber-400 text-sm font-semibold mb-3 flex items-center gap-1.5">
            <IconWarning size={14} /> {pendingManualConflict}
          </p>
          <div className="flex gap-2">
            <button
              onClick={cancelManualEdit}
              className="flex-1 py-2.5 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-xl transition-colors"
            >
              Abbrechen
            </button>
            <button
              onClick={() => pendingManualChangeReason && commitManualChange(pendingManualChangeReason)}
              className="flex-1 py-2.5 text-sm font-semibold text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-xl transition-colors"
            >
              Trotzdem speichern
            </button>
          </div>
        </div>
      )}

      {/* Constraint violation banner */}
      {violation.length > 0 && pendingPlanJson && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4">
          <p className="text-amber-400 text-sm font-semibold mb-1 flex items-center gap-1.5">
            <IconWarning size={14} /> Der Coach-Plan weicht von deinen Einstellungen ab:
          </p>
          <ul className="text-xs text-amber-300/80 mb-3 space-y-0.5">
            {violation.map((d, i) => <li key={i}>• {d}</li>)}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={() => { setPendingPlanJson(null); setViolation([]); generatePlan() }}
              className="flex-1 py-2.5 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-xl transition-colors"
            >
              Neu generieren
            </button>
            <button
              onClick={() => savePlanJson(pendingPlanJson, true)}
              className="flex-1 py-2.5 text-sm font-semibold text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-xl transition-colors"
            >
              Trotzdem speichern
            </button>
          </div>
        </div>
      )}

      {/* Generate button */}
      <button
        onClick={generatePlan}
        disabled={generating}
        className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
          plan
            ? 'bg-slate-700 hover:bg-slate-600 text-slate-200'
            : 'bg-brand-500 hover:bg-brand-600 text-white'
        } disabled:opacity-50`}
      >
        {generating && (
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        )}
        {generating ? (loadingMessage ?? 'Generiere Plan…') : plan ? 'Plan neu generieren' : 'Plan für diese Woche generieren'}
      </button>

      {/* ── Wochenreview (nur für aktuelle + vergangene Wochen) ── */}
      {!loadingPlan && monday <= getISOMonday(new Date()) && (
        <div className="mt-8 pt-6 border-t border-slate-700/50">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-1">
            Wochenreview
          </h2>

          {/* Absolvierte Aktivitäten */}
          {weekActivities.length > 0 && (
            <div className="mb-4 flex flex-col gap-1.5">
              <p className="text-xs text-slate-500 mb-1">Absolvierte Aktivitäten</p>
              {weekActivities.map(a => (
                <div key={a.id} className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="text-slate-600">
                    {new Date(a.date).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })}
                  </span>
                  <span className="text-slate-300 font-medium truncate">{a.name}</span>
                  {a.duration_s && <span>{Math.round(a.duration_s / 60)} min</span>}
                  {a.distance_m && a.distance_m > 0 && <span>{(a.distance_m / 1000).toFixed(1)} km</span>}
                  {a.avg_hr && <span>Ø {Math.round(a.avg_hr)} bpm</span>}
                </div>
              ))}
            </div>
          )}

          {/* Feedback-Textarea + Review-Button / Violation-Banner */}
          {!reviewResult && (
            <>
              <textarea
                value={reviewFeedback}
                onChange={e => setReviewFeedback(e.target.value)}
                placeholder="Wie war deine Woche? Befinden, Besonderheiten, Herausforderungen…"
                rows={3}
                className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500 mb-3"
              />
              {reviewError && <p className="text-red-400 text-xs mb-2">{reviewError}</p>}
              {reviewViolationList.length > 0 && pendingReviewData ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                  <p className="text-amber-400 text-sm font-semibold mb-1 flex items-center gap-1.5">
                    <IconWarning size={14} /> Review-Plan weicht von deinen Einstellungen ab:
                  </p>
                  <ul className="text-xs text-amber-300/80 mb-3 space-y-0.5">
                    {reviewViolationList.map((d, i) => <li key={i}>• {d}</li>)}
                  </ul>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setPendingReviewData(null); setReviewViolationList([]); startReview() }}
                      className="flex-1 py-2.5 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-xl transition-colors"
                    >
                      Neu generieren
                    </button>
                    <button
                      onClick={() => saveReviewData(pendingReviewData, true)}
                      className="flex-1 py-2.5 text-sm font-semibold text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-xl transition-colors"
                    >
                      Trotzdem speichern
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={startReview}
                  disabled={reviewing}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {reviewing && (
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                  {reviewing ? (loadingMessage ?? 'Review läuft…') : 'Wochenreview starten'}
                </button>
              )}
            </>
          )}

          {/* Review-Ergebnis */}
          {reviewResult && (
            <div className="bg-slate-800 rounded-xl p-4 flex flex-col gap-3">
              <p className="text-sm text-slate-300 leading-relaxed">{reviewResult}</p>
              <div className="flex items-center gap-2 pt-1 border-t border-slate-700">
                <IconCheck size={12} className="text-brand-400 shrink-0" />
                <p className="text-xs text-slate-500">Plan für nächste Woche wurde generiert und gespeichert.</p>
              </div>
              <button
                onClick={() => { setReviewResult(null); setReviewFeedback('') }}
                className="text-xs text-slate-500 hover:text-slate-300 self-start"
              >
                Neues Review starten
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Day-Kontextmenü (über "•••"-Button) ─────────────── */}
      {contextMenuDay && displayPlanJson && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) closeContextMenu() }}
        >
          <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-lg flex flex-col gap-2">
            {!moveSubmenuOpen ? (
              <>
                <h2 className="text-sm font-semibold text-slate-400 mb-2">
                  {contextMenuDay} · {dayDate(monday, DAYS.indexOf(contextMenuDay))}
                </h2>
                <button
                  onClick={() => handleMarkAsRest(contextMenuDay)}
                  className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                >
                  Als Ruhetag markieren
                </button>
                <button
                  onClick={() => setMoveSubmenuOpen(true)}
                  className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                >
                  Verschieben nach...
                </button>
                <button
                  onClick={closeContextMenu}
                  className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                >
                  Details anzeigen
                </button>
                <button
                  onClick={closeContextMenu}
                  className="text-xs text-slate-500 hover:text-slate-300 mt-2 self-center"
                >
                  Abbrechen
                </button>
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold text-slate-400 mb-2">
                  {contextMenuDay} verschieben nach…
                </h2>
                {DAYS.filter(d => d !== contextMenuDay).map(d => (
                  <button
                    key={d}
                    onClick={() => handleMoveDay(contextMenuDay, d)}
                    className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors flex items-center justify-between"
                  >
                    <span>{d}</span>
                    <span className="text-xs text-slate-500">{dayDate(monday, DAYS.indexOf(d))}</span>
                  </button>
                ))}
                <button
                  onClick={() => setMoveSubmenuOpen(false)}
                  className="text-xs text-slate-500 hover:text-slate-300 mt-2 self-center"
                >
                  Zurück
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Toast: manuelle Planänderung gespeichert ────────── */}
      {manualToast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg max-w-[90vw] text-center text-white ${
          manualToast.type === 'success' ? 'bg-brand-500' : 'bg-red-500'
        }`}>
          {manualToast.message}
        </div>
      )}

    </div>
    </>
  )
}
