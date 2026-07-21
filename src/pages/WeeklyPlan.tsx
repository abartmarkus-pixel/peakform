import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type WeeklyPlan, type Activity, type SportConfig } from '../lib/supabase'
import { buildCoachContext } from '../lib/coachContext'
import { buildCoachSystemPrompt } from '../lib/coachPrompt'
import { getValidAccessToken, fetchRecentActivities, syncActivitiesToSupabase } from '../lib/strava'
import { analyzeActivity, claimActivityForAnalysis, parseHevyDescription } from '../lib/activityAnalysis'
import {
  IconRunning, IconCycling, IconStrength, IconRest, IconOther,
  IconChevronLeft, IconChevronRight, IconChevronUp, IconChevronDown,
  IconCheck, IconMissed, IconWarning, IconPlan,
  IconGrip,
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
  // Nur gesetzt bei manuell erzeugten Ruhetagen (via markAsRestDay) — trägt den
  // ursprünglichen Taginhalt für "Aktivität wiederherstellen" mit; JSONB speichert
  // es klaglos mit, übersteht also Reload und Versionswechsel.
  _restoreFrom?: DayPlan
  // Nur gesetzt, wenn eine an einem anderen Tag vorgezogen durchgeführte Aktivität
  // diesen Tag erfüllt (Kontext-Vorschlag "Vorziehen erkannt", siehe Schritt 3).
  // Der Tag selbst bleibt inhaltlich unverändert (type/description etc.).
  _fulfilledBy?: { date: string; stravaId: number }
}

type PlanJson = {
  summary: string
  days: Record<string, DayPlan>
}

type ReviewJson = {
  review: string
}

type MatchStatus = 'completed' | 'missed' | 'pending' | 'extra'

type DayMatch = {
  status: MatchStatus
  activity?: Activity
  // Nur bei Trainingstagen gesetzt (nicht bei Ruhetagen, die haben ihr eigenes
  // 'extra'-Status-Sonderverhalten): zusätzliche Aktivität am selben Kalendertag,
  // deren Sportart nicht zum geplanten dayPlan.type passt — unabhängig vom
  // regulären Status (completed/missed/pending).
  extraActivity?: Activity
}

// Vorschlag "Vorziehen erkannt": eine extraActivity an fromDay passt zur noch
// ausstehenden Sportart an toDay in derselben Woche.
type PickupSuggestion = {
  fromDay: string
  toDay: string
  activity: Activity
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
const DAY_FULL: Record<string, string> = {
  Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag',
  Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag',
}


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

// Parst ein "YYYY-MM-DD"-Datum explizit in Lokalzeit-Komponenten (nicht via
// `new Date(dateStr)`, das UTC-Mitternacht annimmt — siehe toDateStr-Konvention).
function formatFulfilledDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' })
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

// Ersetzt einen Trainingstag durch einen Ruhetag, behält den ursprünglichen
// Taginhalt aber eingebettet für spätere Wiederherstellung.
function markAsRestDay(originalDayPlan: DayPlan): DayPlan {
  return {
    type: 'Ruhetag',
    description: 'Manuell freigehalten',
    _restoreFrom: originalDayPlan,
  }
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

  // Vorgezogen erledigt (Schritt 3/4): Tag gilt als completed, auch wenn am
  // eigentlichen Kalendertag selbst keine passende Aktivität liegt — activity
  // wird über dieselbe Activity-Lookup-Logik wie sonst aus der stravaId aufgelöst.
  if (dayPlan._fulfilledBy) {
    const fulfillingActivity = activities.find(a => a.strava_id === dayPlan._fulfilledBy!.stravaId)
    return { status: 'completed', activity: fulfillingActivity }
  }

  if (REST_KEYWORDS.some(k => dayPlan.type.toLowerCase().includes(k))) {
    const extra = activities.find(isOnDate)
    return extra ? { status: 'extra', activity: extra } : { status: 'pending' }
  }

  const matchingTypes = SPORT_MATCH[dayPlan.type.toLowerCase()] ?? []

  const matched = activities.find(a => isOnDate(a) && matchingTypes.includes(a.type))
  const extraActivity = activities.find(a => isOnDate(a) && a !== matched && !matchingTypes.includes(a.type))

  if (matched) return { status: 'completed', activity: matched, extraActivity }
  if (d < today) return { status: 'missed', extraActivity }
  return { status: 'pending', extraActivity }
}

// ── sub-components ─────────────────────────────────────────────────────────

type DayCardProps = {
  day: string; idx: number; monday: Date; plan: DayPlan | undefined
  match?: DayMatch; onPress?: () => void
  onOpenMenu?: (day: string) => void
  dragAttributes?: DraggableAttributes
  dragListeners?: DraggableSyntheticListeners
  dragDisabled?: boolean
}

// Long-Press (800ms, 8px Bewegungstoleranz) auf die Karte öffnet das Kontextmenü.
// Reagiert nur außerhalb des Drag-Griffs (der hat eigene, separate Listener), daher
// keine Kollision mit dem dnd-kit-Sensor. Bewegung über die Toleranz hinaus bricht
// den Timer ab, damit normales Scrollen nicht als Long-Press missverstanden wird.
// 800ms statt ursprünglich 500ms, da kurzes Antippen/Halten beim Greifen des
// Drag-Griffs oder beim Scrollen sonst zu leicht als Long-Press erkannt wurde.
const LONG_PRESS_DURATION_MS = 800
const LONG_PRESS_TOLERANCE_PX = 8

function DayCard({ day, idx, monday, plan, match, onPress, onOpenMenu, dragAttributes, dragListeners, dragDisabled }: DayCardProps) {
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

  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const longPressFired = useRef(false)

  function clearPressTimer() {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
    pressStart.current = null
  }

  function handlePointerDown(e: React.PointerEvent) {
    pressStart.current = { x: e.clientX, y: e.clientY }
    longPressFired.current = false
    pressTimer.current = setTimeout(() => {
      longPressFired.current = true
      onOpenMenu?.(day)
    }, LONG_PRESS_DURATION_MS)
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!pressStart.current) return
    const dx = Math.abs(e.clientX - pressStart.current.x)
    const dy = Math.abs(e.clientY - pressStart.current.y)
    if (dx > LONG_PRESS_TOLERANCE_PX || dy > LONG_PRESS_TOLERANCE_PX) clearPressTimer()
  }

  function handleCardClick() {
    if (longPressFired.current) { longPressFired.current = false; return }
    onPress?.()
  }

  return (
    <div
      className={`rounded-xl p-3.5 ${isRest ? 'bg-slate-800/50' : 'bg-slate-800'} ${borderClass} ${isClickable ? 'cursor-pointer active:bg-slate-700' : ''} ${onOpenMenu ? 'select-none' : ''}`}
      style={onOpenMenu ? { WebkitTouchCallout: 'none' } : undefined}
      data-swipe-ignore={onOpenMenu ? true : undefined}
      onClick={isClickable ? handleCardClick : undefined}
      onPointerDown={onOpenMenu ? handlePointerDown : undefined}
      onPointerMove={onOpenMenu ? handlePointerMove : undefined}
      onPointerUp={onOpenMenu ? clearPressTimer : undefined}
      onPointerCancel={onOpenMenu ? clearPressTimer : undefined}
      onPointerLeave={onOpenMenu ? clearPressTimer : undefined}
      onContextMenu={onOpenMenu ? e => e.preventDefault() : undefined}
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
          {match?.extraActivity && (
            <span className="text-[10px] font-semibold text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded-full">
              +1
            </span>
          )}
          {dragDisabled ? (
            <span
              className="p-1.5 -m-1.5 text-slate-500 opacity-40 cursor-not-allowed"
              aria-hidden="true"
            >
              <IconGrip size={14} />
            </span>
          ) : dragAttributes && dragListeners && (
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
          {plan?._fulfilledBy && (
            <p className="text-xs text-slate-500 mt-1">
              Vorgezogen am {formatFulfilledDate(plan._fulfilledBy.date)}
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
          {match?.extraActivity && (
            <p className="text-xs text-blue-400/70 mt-1.5 truncate flex items-center gap-1">
              <IconOther size={10} className="text-blue-400 shrink-0" />
              Außerdem: {match.extraActivity.name}
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
  const { day, dragDisabled } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: day, disabled: dragDisabled })
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
      <DayCard {...props} dragAttributes={dragDisabled ? undefined : attributes} dragListeners={dragDisabled ? undefined : listeners} />
    </div>
  )
}

// Aufklappbare Review-Ergebnis-Karte — zeigt Nutzer-Notizen + Coach-Bewertung
// eines abgeschlossenen Wochenreviews. Lokaler expanded-State statt Prop, damit
// ein neues Mount (z.B. via key={weekStr} beim Wochenwechsel) immer wieder
// ausgeklappt startet, ohne dass die Elternkomponente einen State verwalten muss.
function WeeklyReviewCard({ reviewNotes, userInput }: { reviewNotes: string; userInput: string | null }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="bg-slate-800 rounded-xl p-4 mb-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="text-sm font-semibold text-slate-200">Wochenreview</span>
        {expanded ? <IconChevronUp size={12} className="text-slate-400" /> : <IconChevronDown size={12} className="text-slate-400" />}
      </button>
      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {userInput && (
            <div>
              <p className="text-xs text-slate-500 mb-1">Deine Notizen:</p>
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{userInput}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-slate-500 mb-1">Coach-Bewertung:</p>
            <p className="text-sm text-slate-300 leading-relaxed">{reviewNotes}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function WeeklyPlan() {
  const navigate = useNavigate()
  const [athlete, setAthlete]         = useState<Athlete | null>(null)
  const [monday, setMonday]           = useState<Date>(() => {
    const saved = sessionStorage.getItem('weeklyplan_monday')
    if (saved) {
      const [y, m, d] = saved.split('-').map(Number)
      return getISOMonday(new Date(y, m - 1, d))
    }
    return getISOMonday(new Date())
  })
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
  const [pendingManualPlan, setPendingManualPlan] = useState<PlanJson | null>(null)
  const [pendingManualChangeReason, setPendingManualChangeReason] = useState<string | null>(null)
  const [manualToast, setManualToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const previousManualPlanJson = useRef<PlanJson | null>(null)
  // Schlüssel (stravaId-toDay) des zuletzt per "Nein danke" abgewiesenen
  // Vorziehen-Vorschlags — verhindert erneutes Anzeigen desselben Vorschlags.
  const [dismissedPickupKey, setDismissedPickupKey] = useState<string | null>(null)
  // review
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [reviewing, setReviewing]     = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const isCurrentWeek = toDateStr(monday) === toDateStr(getISOMonday(new Date()))
  const isPastWeek = monday < getISOMonday(new Date())
  const weekStr = toDateStr(monday)

  // Gewählte Woche in sessionStorage spiegeln — überlebt damit das
  // Unmount/Remount von WeeklyPlan beim Navigieren zu /activity/:id und zurück
  // (analog zum dashboard_filter-Pattern in Dashboard.tsx).
  useEffect(() => {
    sessionStorage.setItem('weeklyplan_monday', toDateStr(monday))
  }, [monday])

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
    setReviewFeedback('')
    setManualPlanJson(null)
    setPendingManualConflict(null)
    setPendingManualChangeReason(null)
    setDismissedPickupKey(null)

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
        // Skip if the background sweep from syncActivitiesToSupabase (a few
        // lines above) already claimed this activity — avoids a duplicate
        // Claude call for the same activity.
        if (!(await claimActivityForAnalysis(act.id))) continue

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

  // Speichert die Review-Bewertung als neue Version der BEWERTETEN Woche (weekStr)
  // selbst — plan_json bleibt unverändert (NOT-NULL-Spalte, daher vom bisherigen
  // plan übernommen), nur review_notes/review_user_input kommen neu hinzu.
  async function saveReviewData(reviewText: string) {
    if (!athlete) return
    if (!plan?.plan_json) {
      setReviewError('Für diese Woche existiert noch kein Plan — ein Review kann erst nach "Plan generieren" gespeichert werden.')
      return
    }

    const { data: existing } = await supabase
      .from('weekly_plans')
      .select('version')
      .eq('athlete_id', athlete.id)
      .eq('week_start', weekStr)
      .order('version', { ascending: false })
      .limit(1)
    const nextVersion = (existing?.[0]?.version ?? 0) + 1

    const { data: newPlan } = await supabase
      .from('weekly_plans')
      .insert({
        athlete_id:         athlete.id,
        week_start:         weekStr,
        version:            nextVersion,
        plan_json:          plan.plan_json,
        review_notes:       reviewText,
        review_user_input:  reviewFeedback.trim() || null,
        change_reason:      'Wochenreview durchgeführt',
      })
      .select()
      .single()

    await supabase.from('coach_decisions').insert({
      athlete_id:       athlete.id,
      decision_type:    'weekly_review',
      decision_summary: `Wochenreview KW ${weekStr} durchgeführt`,
      reasoning:        reviewText,
      related_plan_id:  (newPlan as WeeklyPlan)?.id ?? null,
    })

    setPlan(newPlan as WeeklyPlan)
  }

  async function startReview() {
    if (!athlete) return
    setReviewing(true)
    setReviewError(null)

    try {
      await closeOutstandingAnalyses()

      const [context, systemPrompt] = await Promise.all([
        buildCoachContext(athlete.id),
        buildCoachSystemPrompt(athlete.id),
      ])

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

      const prompt = `${context}

---

Erstelle ein Wochenreview für die Woche ${formatWeekRange(monday)}.

Tatsächlich absolvierte Aktivitäten diese Woche:
${actsText}
${currentPlanJson ? `\nGeplant war: ${currentPlanJson.summary}` : ''}

Feedback des Athleten:
${reviewFeedback.trim() || 'Kein Feedback angegeben.'}

Erstelle eine direkte Wochenbewertung (3-4 Sätze): Belastungssteuerung, Ausführung vs. Plan, was gut lief, was nicht.

Antworte AUSSCHLIESSLICH mit diesem JSON (kein Text davor/danach, kein Markdown):
{
  "review": "Deine Wochenbewertung (3-4 Sätze, direkt und konkret, auf Deutsch)"
}`

      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, max_tokens: 600, system: systemPrompt }),
      })
      if (!res.ok) throw new Error('API Fehler')
      const { text } = await res.json() as { text: string }

      const parsed = parseReviewJson(text)
      await saveReviewData(parsed.review)
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
      setPendingManualPlan(updatedPlan)
      setPendingManualChangeReason(changeReason)
    } else {
      commitManualChange(updatedPlan, changeReason, false)
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

  // Einziger Aufrufweg zum Speichern: der zu speichernde Plan kommt immer als
  // Parameter herein — nie aus dem manualPlanJson-State gelesen. Der State wird
  // per setManualPlanJson() nur asynchron aktualisiert; würde commitManualChange
  // ihn stattdessen selbst auslesen, bekäme der Direkt-Aufruf aus applyManualEdit()
  // (synchron, im selben Tick) noch den alten Wert aus der Closure des laufenden
  // Renders (Stale-Closure-Bug — betraf früher jede konfliktfreie manuelle Änderung).
  async function commitManualChange(updatedPlan: PlanJson, changeReason: string, hasViolation: boolean) {
    setPendingManualConflict(null)
    setPendingManualPlan(null)
    setPendingManualChangeReason(null)
    try {
      await saveManualPlanChange(updatedPlan, changeReason, hasViolation)
      setManualToast({ type: 'success', message: 'Plan aktualisiert ✓' })
    } catch (e) {
      console.error(e)
      setManualToast({ type: 'error', message: 'Speichern fehlgeschlagen. Bitte erneut versuchen.' })
    }
  }

  function cancelManualEdit() {
    setManualPlanJson(previousManualPlanJson.current)
    setPendingManualConflict(null)
    setPendingManualPlan(null)
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
    const current = displayPlanJson.days[day]
    if (!current) return
    const updated = { ...displayPlanJson, days: { ...displayPlanJson.days } }
    updated.days[day] = markAsRestDay(current)
    applyManualEdit(updated, `${day} als Ruhetag markiert`)
    closeContextMenu()
  }

  function handleRestoreDay(day: string) {
    if (!displayPlanJson) return
    const current = displayPlanJson.days[day]
    if (!current?._restoreFrom) return
    const updated = { ...displayPlanJson, days: { ...displayPlanJson.days } }
    updated.days[day] = current._restoreFrom
    applyManualEdit(updated, `${day}: Aktivität wiederhergestellt`)
    closeContextMenu()
  }

  function handleMoveDay(dayA: string, dayB: string) {
    if (!displayPlanJson) return
    applyManualEdit(swapDays(displayPlanJson, dayA, dayB), `Manuell verschoben: ${dayA} ↔ ${dayB}`)
    closeContextMenu()
  }

  // Entfernt _fulfilledBy wieder — der Tag zeigt danach seinen ursprünglichen
  // Status (pending/missed je nach Kalenderdatum), da matchActivityToDay() dann
  // wieder normal gegen den eigentlichen Kalendertag matcht.
  function handleUnlinkFulfilled(day: string) {
    if (!displayPlanJson) return
    const current = displayPlanJson.days[day]
    if (!current?._fulfilledBy) return
    const updated = { ...displayPlanJson, days: { ...displayPlanJson.days } }
    const { _fulfilledBy: _omit, ...rest } = current
    updated.days[day] = rest
    applyManualEdit(updated, `${day}: Verknüpfung aufgehoben`)
    closeContextMenu()
  }

  // Ein zentraler Match-Durchlauf pro Tag — wird für Wochen-Kennzahlen, die
  // DayCard-Anzeige und die Vorziehen-Erkennung (Schritt 2) gemeinsam genutzt.
  const dayMatches = useMemo(() => {
    const result: Record<string, DayMatch> = {}
    if (!displayPlanJson) return result
    DAYS.forEach((day, idx) => {
      const dayPlan = displayPlanJson.days?.[day]
      if (!dayPlan) return
      const date = new Date(monday); date.setDate(date.getDate() + idx)
      result[day] = matchActivityToDay(date, dayPlan, weekActivities)
    })
    return result
  }, [displayPlanJson, weekActivities, monday])

  // Vorziehen-Erkennung: eine extraActivity an fromDay, deren Sportart zum noch
  // ausstehenden (pending) Plan eines anderen Tages toDay passt.
  const pickupSuggestion = useMemo<PickupSuggestion | null>(() => {
    if (!displayPlanJson) return null
    for (const fromDay of DAYS) {
      const extra = dayMatches[fromDay]?.extraActivity
      if (!extra) continue
      for (const toDay of DAYS) {
        if (toDay === fromDay) continue
        if (dayMatches[toDay]?.status !== 'pending') continue
        const toPlan = displayPlanJson.days[toDay]
        if (!toPlan) continue
        const matchingTypes = SPORT_MATCH[toPlan.type.toLowerCase()] ?? []
        if (matchingTypes.includes(extra.type)) {
          return { fromDay, toDay, activity: extra }
        }
      }
    }
    return null
  }, [displayPlanJson, dayMatches])

  const pickupKey = pickupSuggestion ? `${pickupSuggestion.activity.strava_id}-${pickupSuggestion.toDay}` : null
  const showPickupBanner = !!pickupSuggestion && pickupKey !== dismissedPickupKey
  const pickupToPlan = pickupSuggestion ? displayPlanJson?.days[pickupSuggestion.toDay] : undefined
  const pickupIsToday = pickupSuggestion
    ? new Date(pickupSuggestion.activity.date).toDateString() === new Date().toDateString()
    : false

  function handleDismissPickup() {
    if (pickupKey) setDismissedPickupKey(pickupKey)
  }

  // Verknüpft den Zieltag mit der vorgezogenen Aktivität, ohne dessen Inhalt
  // (type/description/...) zu verändern — Persistierung über denselben
  // applyManualEdit()/saveManualPlanChange()-Mechanismus wie Swap/Ruhetag.
  function handleConfirmPickup() {
    if (!pickupSuggestion || !displayPlanJson) return
    const { fromDay, toDay, activity } = pickupSuggestion
    const targetPlan = displayPlanJson.days[toDay]
    if (!targetPlan) return
    const updated = { ...displayPlanJson, days: { ...displayPlanJson.days } }
    updated.days[toDay] = {
      ...targetPlan,
      _fulfilledBy: { date: toDateStr(new Date(activity.date)), stravaId: activity.strava_id },
    }
    applyManualEdit(updated, `${targetPlan.type} von ${toDay} auf ${fromDay} vorgezogen`)
    if (pickupKey) setDismissedPickupKey(pickupKey)
  }

  const weekStats = useMemo(() => {
    if (!displayPlanJson) return null

    let totalCount = 0
    let completedCount = 0
    DAYS.forEach(day => {
      const dayPlan = displayPlanJson.days?.[day]
      if (!dayPlan || REST_KEYWORDS.some(k => dayPlan.type.toLowerCase().includes(k))) return
      totalCount++
      if (dayMatches[day]?.status === 'completed') completedCount++
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
  }, [displayPlanJson, weekActivities, dayMatches])

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

      {/* Vorziehen erkannt: dezenter, dismissable Hinweis (Schritt 2) */}
      {showPickupBanner && pickupSuggestion && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 mb-4">
          <p className="text-blue-300 text-sm mb-3">
            Du hast dein {pickupToPlan?.type ?? ''} für {DAY_FULL[pickupSuggestion.toDay]} bereits{' '}
            {pickupIsToday ? 'heute' : `am ${DAY_FULL[pickupSuggestion.fromDay]}`} gemacht — als erfüllt markieren?
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirmPickup}
              className="flex-1 py-2.5 text-sm font-semibold text-white bg-blue-500 hover:bg-blue-600 rounded-xl transition-colors"
            >
              Verknüpfen
            </button>
            <button
              onClick={handleDismissPickup}
              className="flex-1 py-2.5 text-sm font-semibold text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-xl transition-colors"
            >
              Nein danke
            </button>
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
                const match = dayMatches[day]
                return (
                  <SortableDayCard
                    key={day}
                    day={day}
                    idx={idx}
                    monday={monday}
                    plan={dayPlan}
                    match={match}
                    onPress={match?.activity ? () => navigate(`/activity/${match.activity!.strava_id}`, { state: { from: '/plan' } }) : undefined}
                    onOpenMenu={isPastWeek ? undefined : handleOpenMenu}
                    dragDisabled={isPastWeek}
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
              onClick={() => pendingManualPlan && pendingManualChangeReason && commitManualChange(pendingManualPlan, pendingManualChangeReason, true)}
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

      {/* Generate button — für abgelaufene Wochen entfällt die Möglichkeit,
          (neu) zu generieren, ersatzlos; nur ohne Plan gibt es dafür einen
          neutralen Hinweistext, da der Plan sonst ohnehin schon sichtbar ist. */}
      {isPastWeek ? (
        !plan && (
          <p className="text-center text-sm text-slate-500 py-3">
            Für diese Woche wurde kein Plan erstellt
          </p>
        )
      ) : (
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
      )}

      {/* ── Wochenreview (nur für aktuelle + vergangene Wochen) ── */}
      {!loadingPlan && monday <= getISOMonday(new Date()) && (
        <div className="mt-8 pt-6 border-t border-slate-700/50">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-1">
            Wochenreview
          </h2>

          {/* review_notes liegt jetzt direkt auf dem Plan DIESER Woche (der
              bewerteten Woche) — ein einziger Check ersetzt die frühere
              Fall-A/Fall-B-Unterscheidung. */}
          {plan?.review_notes ? (
            <WeeklyReviewCard key={`week-${weekStr}`} reviewNotes={plan.review_notes} userInput={plan.review_user_input} />
          ) : (
            <>
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

              {/* Feedback-Textarea + Review-Button */}
              <textarea
                value={reviewFeedback}
                onChange={e => setReviewFeedback(e.target.value)}
                placeholder="Wie war deine Woche? Befinden, Besonderheiten, Herausforderungen…"
                rows={3}
                className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500 mb-3"
              />
              {reviewError && <p className="text-red-400 text-xs mb-2">{reviewError}</p>}
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
            </>
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
                {displayPlanJson.days[contextMenuDay]?._restoreFrom ? (
                  <button
                    onClick={() => handleRestoreDay(contextMenuDay)}
                    className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                  >
                    Aktivität wiederherstellen
                  </button>
                ) : (
                  <button
                    onClick={() => handleMarkAsRest(contextMenuDay)}
                    className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                  >
                    Als Ruhetag markieren
                  </button>
                )}
                <button
                  onClick={() => setMoveSubmenuOpen(true)}
                  className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                >
                  Verschieben nach...
                </button>
                {displayPlanJson.days[contextMenuDay]?._fulfilledBy && (
                  <button
                    onClick={() => handleUnlinkFulfilled(contextMenuDay)}
                    className="w-full text-left py-2.5 px-3 rounded-xl text-sm text-slate-200 bg-slate-700 hover:bg-slate-600 transition-colors"
                  >
                    Verknüpfung aufheben
                  </button>
                )}
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
