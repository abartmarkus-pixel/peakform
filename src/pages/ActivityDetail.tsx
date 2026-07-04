import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { IconChevronLeft, IconRoast, IconCommentOutline, IconCommentFilled } from '../lib/icons'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { fetchActivityStreams, fetchActivityLaps, fetchActivityDetail, getValidAccessToken, type StravaLap, type StravaSplitMetric } from '../lib/strava'
import {
  analyzeActivity,
  triggerRecoveryExtraction,
  parseHevyDescription,
  buildChartData,
  computeStats,
  formatDuration,
  type Exercise,
  type ChartPoint,
  type ComputedStats,
} from '../lib/activityAnalysis'
import { supabase, type Activity, type Athlete, type CoachDecision } from '../lib/supabase'
import { AppHeader } from '../components/AppHeader'
import { renderMarkdown } from '../lib/markdown'
import { buildRoastPrompt, type SportFocus } from '../lib/funModePrompts'

// ── types ────────────────────────────────────────────────────────────────────

type RunSplit = {
  km: number | string
  duration: string
  pace: string
  avgHr: number | null
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MUSCLE_LABELS: [string, string][] = [
  ['incline bench press',         'Brust'],
  ['decline bench press',         'Brust'],
  ['close grip bench press',      'Trizeps'],
  ['bench press',                 'Brust'],
  ['chest fly',                   'Brust'],
  ['cable fly',                   'Brust'],
  ['push up',                     'Brust'],
  ['wide pull up',                'Rücken'],
  ['pull up',                     'Rücken'],
  ['chin up',                     'Rücken'],
  ['lat pulldown',                'Rücken'],
  ['bent over row',               'Rücken'],
  ['barbell row',                 'Rücken'],
  ['pendlay row',                 'Rücken'],
  ['cable row',                   'Rücken'],
  ['seated row',                  'Rücken'],
  ['t-bar row',                   'Rücken'],
  ['upright row',                 'Trapez'],
  ['row',                         'Rücken'],
  ['overhead press',              'Schulter'],
  ['military press',              'Schulter'],
  ['shoulder press',              'Schulter'],
  ['face pull',                   'Schulter'],
  ['lateral raise',               'Schulter'],
  ['front raise',                 'Schulter'],
  ['shrug',                       'Trapez'],
  ['seated incline curl',         'Bizeps'],
  ['preacher curl',               'Bizeps'],
  ['incline curl',                'Bizeps'],
  ['hammer curl',                 'Bizeps'],
  ['concentration curl',          'Bizeps'],
  ['cable curl',                  'Bizeps'],
  ['ez bar curl',                 'Bizeps'],
  ['bicep curl',                  'Bizeps'],
  ['biceps curl',                 'Bizeps'],
  ['curl',                        'Bizeps'],
  ['single arm tricep extension', 'Trizeps'],
  ['overhead tricep extension',   'Trizeps'],
  ['cable tricep extension',      'Trizeps'],
  ['tricep extension',            'Trizeps'],
  ['triceps extension',           'Trizeps'],
  ['skull crusher',               'Trizeps'],
  ['skullcrusher',                'Trizeps'],
  ['tricep pushdown',             'Trizeps'],
  ['tricep dip',                  'Trizeps'],
  ['hanging knee raise',          'Core'],
  ['hanging leg raise',           'Core'],
  ['knee raise',                  'Core'],
  ['leg raise',                   'Core'],
  ['ab wheel',                    'Core'],
  ['russian twist',               'Core'],
  ['cable crunch',                'Core'],
  ['crunch',                      'Core'],
  ['sit up',                      'Core'],
  ['plank',                       'Core'],
  ['bulgarian split squat',       'Beine'],
  ['split squat',                 'Beine'],
  ['goblet squat',                'Beine'],
  ['front squat',                 'Beine'],
  ['squat',                       'Beine'],
  ['leg press',                   'Beine'],
  ['lunge',                       'Beine'],
  ['leg extension',               'Quadrizeps'],
  ['leg curl',                    'Hamstrings'],
  ['romanian deadlift',           'Hamstrings'],
  ['rdl',                         'Hamstrings'],
  ['deadlift',                    'Hamstrings'],
  ['hip thrust',                  'Gesäß'],
  ['glute bridge',                'Gesäß'],
  ['standing calf raise',         'Waden'],
  ['seated calf raise',           'Waden'],
  ['calf raise',                  'Waden'],
]

function primaryMuscleLabel(name: string): string | null {
  const lower = name.toLowerCase()
  for (const [kw, label] of MUSCLE_LABELS) {
    if (lower.includes(kw)) return label
  }
  return null
}

function speedToPace(speedKmh: number): string {
  const paceMinKm = 60 / speedKmh
  const min = Math.floor(paceMinKm)
  const sec = Math.round((paceMinKm - min) * 60)
  return `${min}:${String(sec).padStart(2, '0')} min/km`
}

// Gleiches Mapping wie getSpecialistPrompt() in activityAnalysis.ts (Coach-Routing).
function sportFromActivityType(type: string): SportFocus {
  if (['Run', 'VirtualRun', 'TrailRun'].includes(type)) return 'running'
  if (['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide'].includes(type)) return 'cycling'
  if (['WeightTraining', 'Workout'].includes(type)) return 'strength'
  return null
}

function formatPace(secPerKm: number): string {
  const min = Math.floor(secPerKm / 60)
  const sec = Math.round(secPerKm % 60)
  return `${min}:${String(sec).padStart(2, '0')} min/km`
}

function splitsFromMetric(splitsMetric: StravaSplitMetric[]): RunSplit[] {
  return splitsMetric.map((s, i) => {
    const isPartial = s.distance < 900
    return {
      km: isPartial ? `${(s.distance / 1000).toFixed(2)} km` : `km ${i + 1}`,
      duration: formatDuration(s.moving_time),
      pace: isPartial ? '—' : formatPace(s.moving_time / (s.distance / 1000)),
      avgHr: s.average_heartrate != null ? Math.round(s.average_heartrate) : null,
    }
  })
}

// ── Roast Me (komplett isoliert vom Coach-Kontext) ─────────────────────────

function buildRoastStatsText(activity: Activity, sport: SportFocus, stats: ComputedStats, exercises: Exercise[]): string {
  const lines = [
    `Aktivität: ${activity.name}`,
    `Sportart: ${activity.type}`,
    `Datum: ${new Date(activity.date).toLocaleDateString('de-DE')}`,
    `Dauer: ${activity.duration_s != null ? formatDuration(activity.duration_s) : '—'}`,
  ]

  if (sport === 'running') {
    if (activity.distance_m) lines.push(`Distanz: ${(activity.distance_m / 1000).toFixed(2)} km`)
    if (activity.distance_m && activity.duration_s) {
      lines.push(`Ø Pace: ${speedToPace((activity.distance_m / 1000) / (activity.duration_s / 3600))}`)
    }
    if (activity.avg_hr != null) lines.push(`Ø HF: ${Math.round(activity.avg_hr)} bpm`)
    if (activity.max_hr != null) lines.push(`Max HF: ${Math.round(activity.max_hr)} bpm`)
    if (stats.avgCadence != null) lines.push(`Ø Kadenz: ${stats.avgCadence * 2} spm`)
  } else if (sport === 'cycling') {
    if (activity.distance_m) lines.push(`Distanz: ${(activity.distance_m / 1000).toFixed(2)} km`)
    if (activity.np_watts) lines.push(`NP: ${activity.np_watts} W`)
    if (stats.avgWatts != null) lines.push(`Ø Watt: ${stats.avgWatts} W`)
    if (stats.avgCadence != null) lines.push(`Ø Trittfrequenz: ${stats.avgCadence} rpm`)
    if (activity.avg_hr != null) lines.push(`Ø HF: ${Math.round(activity.avg_hr)} bpm`)
    if (activity.max_hr != null) lines.push(`Max HF: ${Math.round(activity.max_hr)} bpm`)
  } else if (sport === 'strength') {
    const totalVolume = exercises.reduce((sum, ex) => sum + ex.totalVolume, 0)
    if (totalVolume > 0) lines.push(`Gesamtvolumen: ${Math.round(totalVolume)} kg`)
    for (const ex of exercises) {
      const muscle = primaryMuscleLabel(ex.name)
      const setsText = ex.sets
        .map(s => s.weight != null ? `${s.weight}kg×${s.reps}` : `${s.reps} Wdh`)
        .join(', ')
      lines.push(`${ex.name}${muscle ? ` (${muscle})` : ''}: ${setsText}`)
    }
  } else {
    if (activity.distance_m) lines.push(`Distanz: ${(activity.distance_m / 1000).toFixed(2)} km`)
    if (activity.avg_hr != null) lines.push(`Ø HF: ${Math.round(activity.avg_hr)} bpm`)
    if (activity.max_hr != null) lines.push(`Max HF: ${Math.round(activity.max_hr)} bpm`)
  }

  return lines.join('\n')
}

async function getRoastAnalysis(
  activity: Activity,
  athlete: { name: string },
  stats: ComputedStats,
  exercises: Exercise[],
  userFeedback?: string
): Promise<string> {
  const sport = sportFromActivityType(activity.type)
  const statsText = buildRoastStatsText(activity, sport, stats, exercises)

  const response = await fetch('/api/analyse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: buildRoastPrompt({ name: athlete.name, sport, userFeedback }),
      prompt: statsText,
      max_tokens: 500,
    }),
  })
  if (!response.ok) throw new Error('Claude API Fehler')
  const data = await response.json() as { text: string }
  return data.text
}

// ── sub-components ────────────────────────────────────────────────────────────

type StatCardProps = { label: string; value: string }
function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="bg-slate-700/50 rounded-xl p-3 flex flex-col gap-0.5">
      <span className="text-xs text-slate-400 uppercase tracking-wider">{label}</span>
      <span className="text-lg font-bold text-slate-100">{value}</span>
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function ActivityDetail() {
  const { id } = useParams<{ id: string }>()
  const [activity, setActivity] = useState<Activity | null>(null)
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [stats, setStats] = useState<ComputedStats>({})
  const [laps, setLaps] = useState<StravaLap[]>([])
  const [exercises, setExercises] = useState<Exercise[]>([])
  const [athleteId, setAthleteId] = useState<string | null>(null)
  const [athleteName, setAthleteName] = useState('')
  const [runSplits, setRunSplits] = useState<RunSplit[]>([])
  const [analysing, setAnalysing] = useState(false)
  const [analysis, setAnalysis] = useState<string | null>(null)
  const [awaitingBackgroundAnalysis, setAwaitingBackgroundAnalysis] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [roastLoading, setRoastLoading] = useState(false)
  const [roastResult, setRoastResult] = useState<string | null>(null)
  const [roastError, setRoastError] = useState<string | null>(null)
  const roastResultRef = useRef<HTMLDivElement>(null)
  // mid-week feedback
  const [feedback, setFeedback] = useState<{ id: string; reasoning: string } | null>(null)
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSaving, setFeedbackSaving] = useState(false)
  const [feedbackToast, setFeedbackToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!id || !stravaId) return

    ;(async () => {
      try {
        const { data: athleteData } = await supabase
          .from('athletes')
          .select('*')
          .eq('strava_athlete_id', Number(stravaId))
          .single()
        if (!athleteData) throw new Error('Athlete not found')
        const athlete = athleteData as Athlete
        setAthleteId(athlete.id)
        setAthleteName(athlete.name ?? '')

        const { data: actData } = await supabase
          .from('activities')
          .select('*')
          .eq('strava_id', Number(id))
          .single()
        if (!actData) throw new Error('Activity not found')
        const act = actData as Activity
        setActivity(act)
        setAnalysis(act.claude_analysis)
        // Activity was just imported and the fire-and-forget background
        // analysis (triggered by syncActivitiesToSupabase) may still be
        // running — poll for it instead of showing an empty state.
        if (!act.claude_analysis) setAwaitingBackgroundAnalysis(true)

        const { data: fbData } = await supabase
          .from('coach_decisions')
          .select('id, reasoning')
          .eq('athlete_id', athlete.id)
          .eq('decision_type', 'midweek_feedback')
          .eq('related_activity_id', act.id)
          .maybeSingle()
        if (fbData) setFeedback({ id: fbData.id, reasoning: fbData.reasoning ?? '' })

        // If analysis exists but recovery extraction may not have run yet, check and trigger
        if (act.claude_analysis) {
          const { count } = await supabase
            .from('coach_decisions')
            .select('id', { count: 'exact', head: true })
            .eq('athlete_id', athlete.id)
            .eq('related_activity_id', act.id)
            .eq('decision_type', 'recovery_required')
          if ((count ?? 0) === 0) {
            triggerRecoveryExtraction(act.claude_analysis, athlete.id, act.id)
          }
        }

        const token = await getValidAccessToken(athlete)
        const actIsRun = ['Run', 'VirtualRun', 'TrailRun'].includes(act.type)
        const [streamsRaw, lapsData, splitsMetric, description] = await Promise.all([
          act.streams_json
            ? Promise.resolve(act.streams_json)
            : fetchActivityStreams(token, Number(id)).then(async (s) => {
                await supabase.from('activities').update({ streams_json: s }).eq('strava_id', Number(id))
                return s
              }),
          act.laps_json
            ? Promise.resolve(act.laps_json as unknown as StravaLap[])
            : fetchActivityLaps(token, Number(id)).then(async (l) => {
                if (l.length > 0) await supabase.from('activities').update({ laps_json: l }).eq('strava_id', Number(id))
                return l
              }).catch(() => []),
          actIsRun
            ? act.splits_metric_json
              ? Promise.resolve(act.splits_metric_json as StravaSplitMetric[])
              : fetchActivityDetail(token, Number(id))
                  .then(async (d) => {
                    const sm = d.splits_metric ?? []
                    if (sm.length > 0) await supabase.from('activities').update({ splits_metric_json: sm }).eq('strava_id', Number(id))
                    return sm
                  })
                  .catch(() => [] as StravaSplitMetric[])
            : Promise.resolve([] as StravaSplitMetric[]),
          act.type === 'WeightTraining'
            ? act.description
              ? Promise.resolve(act.description)
              : fetchActivityDetail(token, Number(id))
                  .then(async (d) => {
                    const desc = ('description' in d && d.description) ? String(d.description) : null
                    if (desc) await supabase.from('activities').update({ description: desc }).eq('strava_id', Number(id))
                    return desc
                  })
                  .catch(() => null)
            : Promise.resolve(null),
        ])

        if (description) {
          setExercises(parseHevyDescription(description))
        }

        const data = buildChartData(streamsRaw as Record<string, unknown>)
        setChartData(data)
        setStats(computeStats(data))
        setLaps(lapsData)

        if (actIsRun && splitsMetric.length > 0) {
          setRunSplits(splitsFromMetric(splitsMetric))
        }
      } catch (e) {
        console.error(e)
        setError('Aktivität konnte nicht geladen werden.')
      } finally {
        setLoading(false)
      }
    })()
  }, [id])

  // Polls for a background analysis result: every 3s, max 10 attempts, then
  // gives up and falls back to the normal "Neu analysieren" button state.
  useEffect(() => {
    if (!id || !awaitingBackgroundAnalysis) return
    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      const { data } = await supabase
        .from('activities')
        .select('claude_analysis')
        .eq('strava_id', Number(id))
        .single()
      if (data?.claude_analysis) {
        setAnalysis(data.claude_analysis)
        setAwaitingBackgroundAnalysis(false)
      } else if (attempts >= 10) {
        setAwaitingBackgroundAnalysis(false)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [id, awaitingBackgroundAnalysis])

  async function runAnalysis() {
    if (!activity || !athleteId) return
    setAnalysing(true)
    setAwaitingBackgroundAnalysis(false)
    try {
      const result = await analyzeActivity(activity, athleteId)
      if (!result.success) throw new Error(result.error ?? 'Analyse fehlgeschlagen')

      const { data } = await supabase
        .from('activities')
        .select('claude_analysis')
        .eq('strava_id', Number(id))
        .single()
      setAnalysis(data?.claude_analysis ?? null)
    } catch (e) {
      console.error(e)
      setError('Analyse fehlgeschlagen.')
    } finally {
      setAnalysing(false)
    }
  }

  useEffect(() => {
    if (roastResult && roastResultRef.current) {
      roastResultRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [roastResult])

  async function handleRoastClick() {
    if (!activity) return
    setRoastLoading(true)
    setRoastError(null)
    try {
      const text = await getRoastAnalysis(activity, { name: athleteName }, stats, exercises, feedback?.reasoning)
      setRoastResult(text)
    } catch (e) {
      console.error(e)
      setRoastError('Roast fehlgeschlagen.')
      setRoastResult(null)
    } finally {
      setRoastLoading(false)
    }
  }

  function openFeedbackModal() {
    setFeedbackText(feedback?.reasoning ?? '')
    setFeedbackModalOpen(true)
  }

  async function saveFeedback() {
    if (!activity || !athleteId) return
    const text = feedbackText.trim()
    if (!text) return
    setFeedbackSaving(true)

    try {
      if (feedback) {
        const { error } = await supabase
          .from('coach_decisions')
          .update({ decision_summary: text.slice(0, 100), reasoning: text })
          .eq('id', feedback.id)
        if (error) throw error
        setFeedback({ id: feedback.id, reasoning: text })
      } else {
        const { data, error } = await supabase
          .from('coach_decisions')
          .insert({
            athlete_id:          athleteId,
            decision_type:       'midweek_feedback',
            decision_summary:    text.slice(0, 100),
            reasoning:           text,
            related_activity_id: activity.id,
          })
          .select()
          .single()
        if (error) throw error
        setFeedback({ id: (data as CoachDecision).id, reasoning: text })
      }
      setFeedbackModalOpen(false)
      setFeedbackToast({ type: 'success', message: 'Danke — wird beim nächsten Plan berücksichtigt ✓' })
      setTimeout(() => setFeedbackToast(null), 2500)
    } catch (e) {
      console.error(e)
      setFeedbackToast({ type: 'error', message: 'Feedback konnte nicht gespeichert werden' })
      setTimeout(() => setFeedbackToast(null), 2500)
    } finally {
      setFeedbackSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const isRide = activity?.type === 'Ride' || activity?.type === 'VirtualRide'
  const isRun = ['Run', 'VirtualRun', 'TrailRun'].includes(activity?.type ?? '')
  const isWeightTraining = activity?.type === 'WeightTraining'
  const hasHr = chartData.some(d => d.hr !== undefined)
  const hasAlt = !isWeightTraining && chartData.some(d => d.alt !== undefined)
  const hasWatts = chartData.some(d => d.watts !== undefined)

  return (
    <>
      <AppHeader />
      <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">
      <Link to="/dashboard" className="inline-flex items-center gap-1 text-brand-500 hover:text-brand-400 text-sm mb-4">
        <IconChevronLeft size={14} /> Zurück
      </Link>

      <h1 className="text-xl font-bold text-slate-100 mb-1">{activity?.name}</h1>
      <p className="text-slate-400 text-sm mb-5">
        {activity && new Date(activity.date).toLocaleDateString('de-DE', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        })} · {activity && new Date(activity.date).toLocaleTimeString('de-DE', {
          hour: '2-digit', minute: '2-digit',
        })} Uhr
      </p>

      {error && <p className="text-red-400 mb-4">{error}</p>}

      {/* ── Stats Grid ─────────────────────────────────────────── */}
      {isRun ? (
        <div className="grid grid-cols-3 gap-2 mb-6">
          {activity?.distance_m != null && activity.distance_m > 0 && (
            <StatCard label="Distanz" value={`${(activity.distance_m / 1000).toFixed(2)} km`} />
          )}
          {activity?.duration_s != null && (
            <StatCard label="Dauer" value={formatDuration(activity.duration_s)} />
          )}
          {stats.avgSpeed != null && (
            <StatCard label="Ø Pace" value={speedToPace(stats.avgSpeed)} />
          )}
          {activity?.avg_hr != null && (
            <StatCard label="Ø HF" value={`${Math.round(activity.avg_hr)} bpm`} />
          )}
          {activity?.max_hr != null && (
            <StatCard label="Max HF" value={`${Math.round(activity.max_hr)} bpm`} />
          )}
          {stats.avgCadence != null && (
            <StatCard label="Ø Kadenz" value={`${stats.avgCadence * 2} spm`} />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 mb-6">
          {activity?.duration_s != null && (
            <StatCard label="Dauer" value={formatDuration(activity.duration_s)} />
          )}
          {activity?.avg_hr != null && (
            <StatCard label="Ø HF" value={`${Math.round(activity.avg_hr)} bpm`} />
          )}
          {isWeightTraining && exercises.length > 0 && (() => {
            const total = exercises.reduce((s, ex) => s + ex.totalVolume, 0)
            return total > 0
              ? <StatCard label="Volumen" value={`${total.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg`} />
              : null
          })()}
          {!isWeightTraining && activity?.distance_m != null && activity.distance_m > 0 && (
            <StatCard label="Distanz" value={`${(activity.distance_m / 1000).toFixed(2)} km`} />
          )}
          {!isWeightTraining && stats.elevationGain != null && (
            <StatCard label="Höhenmeter" value={`${stats.elevationGain} m`} />
          )}
          {isRide && stats.avgSpeed != null && (
            <StatCard label="Ø Tempo" value={`${stats.avgSpeed} km/h`} />
          )}
          {isRide && stats.maxSpeed != null && (
            <StatCard label="Max Tempo" value={`${stats.maxSpeed} km/h`} />
          )}
          {!isWeightTraining && activity?.max_hr != null && (
            <StatCard label="Max HF" value={`${Math.round(activity.max_hr)} bpm`} />
          )}
          {!isWeightTraining && activity?.np_watts != null && (
            <StatCard label="Norm. Power" value={`${Math.round(activity.np_watts)} W`} />
          )}
          {isRide && stats.avgWatts != null && (
            <StatCard label="Ø Watt" value={`${stats.avgWatts} W`} />
          )}
          {isRide && stats.maxWatts != null && (
            <StatCard label="Max Watt" value={`${stats.maxWatts} W`} />
          )}
          {isRide && stats.avgCadence != null && (
            <StatCard label="Ø Trittfreq." value={`${stats.avgCadence} rpm`} />
          )}
        </div>
      )}

      {/* ── Übungstabelle (WeightTraining) ────────────────────── */}
      {isWeightTraining && exercises.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Übungen</h2>
          <div className="flex flex-col gap-2">
            {exercises.map((ex, i) => (
              <div key={i} className="bg-slate-800 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2.5">
                  <span className="font-semibold text-slate-100 text-sm leading-tight pr-2">{ex.name}</span>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {ex.totalVolume > 0
                      ? <span className="text-xs font-semibold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
                          {ex.totalVolume.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg
                        </span>
                      : <span className="text-xs text-slate-500">Körpergewicht</span>
                    }
                    {primaryMuscleLabel(ex.name) && (
                      <span className="text-xs font-medium text-sky-400 bg-sky-400/10 px-2 py-0.5 rounded-full">
                        {primaryMuscleLabel(ex.name)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ex.sets.map((set, j) => (
                    <span key={j} className="bg-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-300 font-medium">
                      {set.weight != null
                        ? `${set.weight % 1 === 0 ? set.weight : set.weight} kg × ${set.reps}`
                        : `${set.reps} Wdh`}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Gesamtvolumen */}
          {(() => {
            const total = exercises.reduce((sum, ex) => sum + ex.totalVolume, 0)
            return total > 0 ? (
              <div className="mt-3 bg-brand-500/10 border border-brand-500/20 rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-slate-400">Gesamtvolumen</span>
                <span className="text-xl font-bold text-brand-400">
                  {total.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg
                </span>
              </div>
            ) : null
          })()}

        </div>
      )}

      {/* ── Watt-Chart ─────────────────────────────────────────── */}
      {hasWatts && !isRun && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">Watt</h2>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="wGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="t" hide />
              <YAxis domain={[0, 'auto']} stroke="#64748b" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8 }}
                labelFormatter={(v) => `${Math.round(Number(v) / 60)} min`}
                formatter={(v: unknown) => [`${v} W`, 'Watt']}
              />
              <Area type="monotone" dataKey="watts" stroke="#f59e0b" fill="url(#wGrad)" dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── HF-Chart ───────────────────────────────────────────── */}
      {hasHr && !isWeightTraining && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">Herzfrequenz</h2>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="hrGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="t" hide />
              <YAxis domain={['auto', 'auto']} stroke="#64748b" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8 }}
                labelFormatter={(v) => `${Math.round(Number(v) / 60)} min`}
                formatter={(v: unknown) => [`${v} bpm`, 'HF']}
              />
              <Area type="monotone" dataKey="hr" stroke="#ef4444" fill="url(#hrGrad)" dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}


      {/* ── Höhenprofil ────────────────────────────────────────── */}
      {hasAlt && !isRun && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">Höhenprofil</h2>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1D9E75" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#1D9E75" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="t" hide />
              <YAxis domain={['auto', 'auto']} stroke="#64748b" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8 }}
                labelFormatter={(v) => `${Math.round(Number(v) / 60)} min`}
                formatter={(v: unknown) => [`${v} m`, 'Höhe']}
              />
              <Area type="monotone" dataKey="alt" stroke="#1D9E75" fill="url(#altGrad)" dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Kilometer-Splits (nur Lauf) ────────────────────────── */}
      {isRun && runSplits.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">Kilometer-Splits</h2>
          <div className="bg-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase border-b border-slate-700">
                  <th className="px-4 py-2.5 text-left">KM</th>
                  <th className="px-4 py-2.5 text-left">ZEIT</th>
                  <th className="px-4 py-2.5 text-left">PACE</th>
                  <th className="px-4 py-2.5 text-left">Ø HF</th>
                </tr>
              </thead>
              <tbody>
                {runSplits.map((split, i) => (
                  <tr key={i} className={`border-b border-slate-700/40 last:border-0 ${i % 2 === 1 ? 'bg-slate-700/20' : ''}`}>
                    <td className="px-4 py-2.5 text-slate-300">
                      {typeof split.km === 'number' ? `km ${split.km}` : split.km}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">{split.duration}</td>
                    <td className="px-4 py-2.5 text-slate-300">{split.pace}</td>
                    <td className="px-4 py-2.5 text-slate-300">
                      {split.avgHr != null ? `${split.avgHr} bpm` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Rundentabelle (nicht Lauf) ─────────────────────────── */}
      {!isRun && laps.length > 1 && (
        <div className="mb-6 overflow-x-auto">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">Runden</h2>
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-xs text-slate-500 uppercase border-b border-slate-700">
                <th className="pb-2 pr-3">#</th>
                <th className="pb-2 pr-3">Dauer</th>
                {laps[0].distance > 0 && <th className="pb-2 pr-3">Distanz</th>}
                {laps[0].average_watts != null && <th className="pb-2 pr-3">Ø Watt</th>}
                {laps[0].average_heartrate != null && <th className="pb-2 pr-3">Ø HF</th>}
                {laps[0].average_cadence != null && <th className="pb-2">Ø RPM</th>}
              </tr>
            </thead>
            <tbody>
              {laps.map((lap) => (
                <tr key={lap.lap_index} className="border-b border-slate-800 text-slate-300">
                  <td className="py-2 pr-3 text-slate-500">{lap.lap_index}</td>
                  <td className="py-2 pr-3">{formatDuration(lap.elapsed_time)}</td>
                  {lap.distance > 0 && (
                    <td className="py-2 pr-3">{(lap.distance / 1000).toFixed(2)} km</td>
                  )}
                  {lap.average_watts != null && (
                    <td className="py-2 pr-3 font-medium text-amber-400">{Math.round(lap.average_watts)} W</td>
                  )}
                  {lap.average_heartrate != null && (
                    <td className="py-2 pr-3">{Math.round(lap.average_heartrate)} bpm</td>
                  )}
                  {lap.average_cadence != null && (
                    <td className="py-2">{Math.round(lap.average_cadence)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Analyse-Button + Feedback ─────────────────────────── */}
      <div className="mb-6 flex justify-between gap-3">
        <button
          onClick={runAnalysis}
          disabled={analysing}
          className="bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors flex items-center gap-2"
        >
          {analysing && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {analysing ? 'Analysiere…' : 'Neu analysieren'}
        </button>

        {analysis && (
          <button
            onClick={openFeedbackModal}
            className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-base font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            {feedback
              ? <IconCommentFilled size={16} className="text-brand-400" />
              : <IconCommentOutline size={16} />}
            {feedback ? 'Feedback bearbeiten' : 'Feedback geben'}
          </button>
        )}
      </div>

      {/* ── Hintergrund-Analyse läuft ──────────────────────────── */}
      {!analysis && awaitingBackgroundAnalysis && !analysing && (
        <div className="bg-slate-800 rounded-xl p-4 flex items-center gap-3 text-sm text-slate-400">
          <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          Analyse läuft im Hintergrund…
        </div>
      )}

      {/* ── KI-Analyse ─────────────────────────────────────────── */}
      {analysis && (
        <div className="bg-slate-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-brand-400 uppercase tracking-wider mb-3">KI-Analyse</h2>
          <div className="space-y-1">{renderMarkdown(analysis)}</div>
        </div>
      )}

      {/* ── Roast Me ─────────────────────────────────────────────── */}
      {analysis && (
        <div className="mt-4">
          <div className="flex justify-center">
            <button
              onClick={handleRoastClick}
              disabled={roastLoading}
              className="w-1/2 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-base font-semibold text-white bg-gradient-to-r from-orange-600 to-red-600 hover:shadow-lg hover:shadow-orange-500/50 active:shadow-orange-500/50 transition-shadow disabled:opacity-50"
            >
              {roastLoading
                ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <IconRoast size={16} />}
              Roast Me
              {!roastLoading && <IconRoast size={16} />}
            </button>
          </div>

          {roastError && <p className="text-red-400 text-sm mt-3">{roastError}</p>}

          {roastResult && !roastLoading && (
            <div ref={roastResultRef} className="mt-3 bg-gradient-to-br from-red-950/40 to-orange-950/30 border border-orange-500/40 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider mb-3">
                🔥 Geröstet 🔥
              </h3>
              <div className="space-y-1">{renderMarkdown(roastResult)}</div>
            </div>
          )}
        </div>
      )}

      {/* ── Mid-Week Feedback Modal ────────────────────────── */}
      {feedbackModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget && !feedbackSaving) setFeedbackModalOpen(false) }}
        >
          <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-lg flex flex-col gap-4">
            <h2 className="text-lg font-bold text-slate-100">Feedback zu {activity?.name}</h2>
            <textarea
              value={feedbackText}
              onChange={e => setFeedbackText(e.target.value)}
              placeholder="z.B. Pace war zu schnell für die HF-Vorgabe, Knie hat gezogen, fühlte sich super an…"
              rows={4}
              autoFocus
              className="w-full bg-slate-900 text-slate-100 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
            />
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setFeedbackModalOpen(false)}
                disabled={feedbackSaving}
                className="flex-1 py-2.5 rounded-xl text-sm text-slate-400 bg-slate-700 hover:bg-slate-600 transition-colors disabled:opacity-50"
              >
                Abbrechen
              </button>
              <button
                onClick={saveFeedback}
                disabled={feedbackSaving || !feedbackText.trim()}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {feedbackSaving && (
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                )}
                Speichern
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mid-Week Feedback Toast ────────────────────────── */}
      {feedbackToast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg max-w-[90vw] text-center text-white ${
          feedbackToast.type === 'success' ? 'bg-brand-500' : 'bg-red-500'
        }`}>
          {feedbackToast.message}
        </div>
      )}
    </div>
    </>
  )
}
