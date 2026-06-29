import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type WeeklyPlan, type Activity, type SportConfig } from '../lib/supabase'
import { buildCoachContext } from '../lib/coachContext'
import { buildCoachSystemPrompt } from '../lib/coachPrompt'
import { getValidAccessToken, fetchRecentActivities } from '../lib/strava'

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

type MatchStatus = 'completed' | 'missed' | 'pending'

type DayMatch = {
  status: MatchStatus
  activity?: Activity
}

// ── constants ──────────────────────────────────────────────────────────────

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

const TYPE_ICON: Record<string, string> = {
  Ruhetag: '💤', Erholung: '💤', Regeneration: '💤',
  Ride: '🚴', Radfahren: '🚴', Cycling: '🚴',
  Run: '🏃', Laufen: '🏃', Running: '🏃',
  Kraft: '🏋️', WeightTraining: '🏋️', Krafttraining: '🏋️',
  Schwimmen: '🏊', Swimming: '🏊',
  Hike: '🥾', Wandern: '🥾',
  Lockerung: '🚶', Spaziergang: '🚶',
  Triathlon: '🏅',
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

// ── helpers ────────────────────────────────────────────────────────────────

function mondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  d.setHours(0, 0, 0, 0)
  return d
}

function addWeeks(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n * 7)
  return d
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function weekLabel(monday: Date): string {
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  return `${monday.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })} – ${sunday.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: 'numeric' })}`
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

function typeIcon(type: string): string {
  return TYPE_ICON[type] ?? '🏅'
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

  if (REST_KEYWORDS.some(k => dayPlan.type.toLowerCase().includes(k))) {
    return { status: 'pending' }
  }

  const matchingTypes = SPORT_MATCH[dayPlan.type.toLowerCase()] ?? []

  const matched = activities.find(a => {
    const actDate = new Date(a.date); actDate.setHours(0, 0, 0, 0)
    return actDate.getTime() === d.getTime() && matchingTypes.includes(a.type)
  })

  if (matched) return { status: 'completed', activity: matched }
  if (d < today) return { status: 'missed' }
  return { status: 'pending' }
}

// ── sub-components ─────────────────────────────────────────────────────────

function DayCard({ day, idx, monday, plan, match, onPress }: {
  day: string; idx: number; monday: Date; plan: DayPlan | undefined
  match?: DayMatch; onPress?: () => void
}) {
  const isRest = !plan || REST_KEYWORDS.some(k => plan.type.toLowerCase().includes(k))
  const isKraft = plan ? SPORT_KEYWORDS.strength.some(k => plan.type.toLowerCase().includes(k)) : false
  const workoutLabel = isKraft && plan?.description
    ? (plan.description.match(/^Workout (III|II|I)$/i)?.[0] ?? null)
    : null

  const borderClass =
    match?.status === 'completed' ? 'border-l-[3px] border-l-brand-500' :
    match?.status === 'missed'    ? 'border-l-[3px] border-l-amber-500' : ''
  const isClickable = match?.status === 'completed' && !!onPress

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
            <span className="text-brand-400 text-xs font-bold leading-none">✓</span>
          )}
          {match?.status === 'missed' && (
            <span className="text-amber-400 text-xs font-bold leading-none">✗</span>
          )}
        </div>
      </div>

      {plan ? (
        <>
          <div className={`flex items-center gap-1.5 ${isKraft ? '' : 'mb-1.5'}`}>
            <span>{typeIcon(plan.type)}</span>
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
            <p className="text-xs text-brand-400/70 mt-1.5 truncate">
              ✓ {match.activity.name}
              {match.activity.duration_s ? ` · ${Math.round(match.activity.duration_s / 60)} min` : ''}
            </p>
          )}
          {match?.status === 'missed' && !isRest && (
            <p className="text-xs text-amber-400/70 mt-1.5">✗ Nicht absolviert</p>
          )}
        </>
      ) : (
        <p className="text-sm text-slate-600">—</p>
      )}
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export default function WeeklyPlan() {
  const navigate = useNavigate()
  const [athlete, setAthlete]         = useState<Athlete | null>(null)
  const [monday, setMonday]           = useState<Date>(mondayOf(new Date()))
  const [plan, setPlan]               = useState<WeeklyPlan | null>(null)
  const [weekActivities, setWeekActivities] = useState<Activity[]>([])
  const [generating, setGenerating]   = useState(false)
  const [loadingPlan, setLoadingPlan] = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [pendingPlanJson, setPendingPlanJson] = useState<PlanJson | null>(null)
  const [violation, setViolation]     = useState<string[]>([])
  // review
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [reviewing, setReviewing]     = useState(false)
  const [reviewResult, setReviewResult] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [pendingReviewData, setPendingReviewData] = useState<ReviewJson | null>(null)
  const [reviewViolationList, setReviewViolationList] = useState<string[]>([])

  const isCurrentWeek = toDateStr(monday) === toDateStr(mondayOf(new Date()))
  const weekStr = toDateStr(monday)

  // load athlete once
  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }
    supabase
      .from('athletes')
      .select('*')
      .eq('strava_athlete_id', Number(stravaId))
      .single()
      .then(({ data }) => setAthlete(data as Athlete))
  }, [navigate])

  // load plan + week activities whenever week changes (with Strava mini-sync)
  useEffect(() => {
    if (!athlete) return
    setLoadingPlan(true)
    setPlan(null)
    setWeekActivities([])
    setReviewResult(null)
    setReviewFeedback('')

    const sunday = toDateStr(addWeeks(monday, 1))

    ;(async () => {
      // Mini-sync: pull latest 10 activities from Strava → upsert to Supabase
      try {
        const token = await getValidAccessToken(athlete)
        const acts = await fetchRecentActivities(token)
        await supabase.from('activities').upsert(
          acts.map(a => ({
            athlete_id: athlete.id,
            strava_id:  a.id,
            name:       a.name,
            type:       a.type,
            date:       a.start_date,
            distance_m: a.distance ?? null,
            duration_s: a.moving_time ?? null,
            avg_hr:     a.average_heartrate ?? null,
            max_hr:     a.max_heartrate ?? null,
            np_watts:   a.weighted_average_watts ?? null,
          })),
          { onConflict: 'strava_id' }
        )
      } catch { /* sync failure doesn't block UI */ }

      const [planRes, actsRes] = await Promise.all([
        supabase
          .from('weekly_plans')
          .select('*')
          .eq('athlete_id', athlete.id)
          .eq('week_start', weekStr)
          .order('version', { ascending: false })
          .limit(1),
        supabase
          .from('activities')
          .select('*')
          .eq('athlete_id', athlete.id)
          .gte('date', weekStr)
          .lt('date', sunday)
          .order('date', { ascending: true }),
      ])
      setPlan(planRes.data?.[0] as WeeklyPlan ?? null)
      setWeekActivities((actsRes.data ?? []) as Activity[])
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

  async function generatePlan() {
    if (!athlete) return
    setGenerating(true)
    setError(null)
    setPendingPlanJson(null)
    setViolation([])

    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [context, systemPrompt, { data: recoveryRows }] = await Promise.all([
        buildCoachContext(athlete.id),
        buildCoachSystemPrompt(athlete.id),
        supabase
          .from('coach_decisions')
          .select('decision_summary, reasoning, created_at')
          .eq('athlete_id', athlete.id)
          .eq('decision_type', 'recovery_required')
          .gte('created_at', sevenDaysAgo)
          .order('created_at', { ascending: false }),
      ])

      const monday8 = monday.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
      const sunday8 = new Date(monday.getTime() + 6 * 86400000)
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
              `- ${new Date(d.created_at).toLocaleDateString('de-DE')}: ${d.reasoning ?? d.decision_summary}`
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
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [context, systemPrompt, { data: recoveryRows }] = await Promise.all([
        buildCoachContext(athlete.id),
        buildCoachSystemPrompt(athlete.id),
        supabase
          .from('coach_decisions')
          .select('decision_summary, reasoning, created_at')
          .eq('athlete_id', athlete.id)
          .eq('decision_type', 'recovery_required')
          .gte('created_at', sevenDaysAgo)
          .order('created_at', { ascending: false }),
      ])

      const reviewRecoverySection = recoveryRows?.length
        ? `\nAKTUELLE ERHOLUNGS-EINSCHRÄNKUNGEN (höchste Priorität — überschreiben alle anderen Regeln):\n${
            recoveryRows.map(d =>
              `- ${new Date(d.created_at).toLocaleDateString('de-DE')}: ${d.reasoning ?? d.decision_summary}`
            ).join('\n')
          }\n`
        : ''

      const nextMonday = addWeeks(monday, 1)
      const nextSunday = new Date(nextMonday.getTime() + 6 * 86400000)

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

Erstelle ein Wochenreview für die Woche ${weekLabel(monday)}.

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
    }
  }

  const planJson = plan?.plan_json as PlanJson | null
  const displayPlanJson = pendingPlanJson ?? planJson

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto pb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link to="/dashboard" className="text-brand-500 hover:underline text-sm">← Zurück</Link>
        {plan && (
          <span className="text-xs text-slate-500">Version {plan.version}</span>
        )}
      </div>

      <h1 className="text-2xl font-bold text-slate-100 mb-4">Wochenplan</h1>

      {/* Week navigation */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => setMonday(m => addWeeks(m, -1))}
          className="w-9 h-9 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors"
        >
          ‹
        </button>
        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-slate-200">{weekLabel(monday)}</p>
          {isCurrentWeek && <p className="text-xs text-brand-400">Aktuelle Woche</p>}
        </div>
        <button
          onClick={() => setMonday(m => addWeeks(m, 1))}
          className="w-9 h-9 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors"
        >
          ›
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {/* Plan summary */}
      {displayPlanJson?.summary && (
        <div className="bg-brand-500/10 border border-brand-500/20 rounded-xl px-4 py-3 mb-4">
          <p className="text-sm text-slate-300 leading-relaxed">{displayPlanJson.summary}</p>
        </div>
      )}

      {/* Day cards */}
      {loadingPlan ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : displayPlanJson ? (
        <div className="flex flex-col gap-2 mb-6">
          {DAYS.map((day, idx) => {
            const dayPlan = displayPlanJson.days?.[day]
            const date = new Date(monday); date.setDate(date.getDate() + idx)
            const match = dayPlan ? matchActivityToDay(date, dayPlan, weekActivities) : undefined
            return (
              <DayCard
                key={day}
                day={day}
                idx={idx}
                monday={monday}
                plan={dayPlan}
                match={match}
                onPress={match?.activity ? () => navigate(`/activity/${match.activity!.id}`) : undefined}
              />
            )
          })}
        </div>
      ) : (
        <div className="text-center py-12 text-slate-500 mb-6">
          <p className="text-4xl mb-3">📅</p>
          <p className="text-sm">Noch kein Plan für diese Woche.</p>
        </div>
      )}

      {/* Constraint violation banner */}
      {violation.length > 0 && pendingPlanJson && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4">
          <p className="text-amber-400 text-sm font-semibold mb-1">
            ⚠ Der Coach-Plan weicht von deinen Einstellungen ab:
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
        {generating ? 'Generiere Plan…' : plan ? 'Plan neu generieren' : 'Plan für diese Woche generieren'}
      </button>

      {/* ── Wochenreview (nur für aktuelle + vergangene Wochen) ── */}
      {!loadingPlan && monday <= mondayOf(new Date()) && (
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
                className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500 mb-3"
              />
              {reviewError && <p className="text-red-400 text-xs mb-2">{reviewError}</p>}
              {reviewViolationList.length > 0 && pendingReviewData ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                  <p className="text-amber-400 text-sm font-semibold mb-1">
                    ⚠ Review-Plan weicht von deinen Einstellungen ab:
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
                  {reviewing ? 'Review läuft…' : 'Wochenreview starten'}
                </button>
              )}
            </>
          )}

          {/* Review-Ergebnis */}
          {reviewResult && (
            <div className="bg-slate-800 rounded-xl p-4 flex flex-col gap-3">
              <p className="text-sm text-slate-300 leading-relaxed">{reviewResult}</p>
              <div className="flex items-center gap-2 pt-1 border-t border-slate-700">
                <span className="text-brand-400 text-xs">✓</span>
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
    </div>
  )
}
