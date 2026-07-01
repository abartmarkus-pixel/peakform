import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { IconChevronLeft } from '../lib/icons'
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
  buildCoachSystemPrompt,
  LAUF_COACH_PROMPT,
  RAD_COACH_PROMPT,
  KRAFT_COACH_PROMPT,
} from '../lib/coachPrompt'
import { buildCoachContext, buildSpecialistContext } from '../lib/coachContext'
import { supabase, type Activity, type Athlete } from '../lib/supabase'
import { AppHeader } from '../components/AppHeader'
import { renderMarkdown } from '../lib/markdown'

// ── types ────────────────────────────────────────────────────────────────────

type ExerciseSet = {
  setNumber: number
  weight?: number
  reps: number
}

type Exercise = {
  name: string
  sets: ExerciseSet[]
  totalVolume: number
  totalReps: number
}

type ChartPoint = {
  t: number
  hr?: number
  alt?: number
  speed?: number
  watts?: number
  cadence?: number
}

type RunSplit = {
  km: number | string
  duration: string
  pace: string
  avgHr: number | null
}

type ComputedStats = {
  avgWatts?: number
  maxWatts?: number
  avgSpeed?: number
  maxSpeed?: number
  elevationGain?: number
  avgCadence?: number
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

function parseHevyDescription(description: string): Exercise[] {
  const exercises: Exercise[] = []
  const lines = description.split('\n').map(l => l.trim()).filter(Boolean)
  let current: Exercise | null = null

  for (const line of lines) {
    if (line.toLowerCase().startsWith('logged with')) continue

    const withWeight = line.match(/^Set (\d+):\s*([\d.,]+)\s*kg\s*[x×]\s*(\d+)/i)
    const bodyweight = line.match(/^Set (\d+):\s*(\d+)\s*Wiederholungen/i)

    if (withWeight && current) {
      const weight = parseFloat(withWeight[2].replace(',', '.'))
      const reps = parseInt(withWeight[3])
      current.sets.push({ setNumber: parseInt(withWeight[1]), weight, reps })
      current.totalVolume += weight * reps
      current.totalReps += reps
    } else if (bodyweight && current) {
      const reps = parseInt(bodyweight[2])
      current.sets.push({ setNumber: parseInt(bodyweight[1]), reps })
      current.totalReps += reps
    } else if (!line.match(/^Set \d+:/i)) {
      if (current && current.sets.length > 0) exercises.push(current)
      current = { name: line, sets: [], totalVolume: 0, totalReps: 0 }
    }
  }

  if (current && current.sets.length > 0) exercises.push(current)
  return exercises
}

function mean(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function buildChartData(streams: Record<string, unknown>): ChartPoint[] {
  type Stream = { data: number[] }
  const time = (streams.time as Stream)?.data ?? []
  const hr = (streams.heartrate as Stream)?.data
  const alt = (streams.altitude as Stream)?.data
  const vel = (streams.velocity_smooth as Stream)?.data
  const watts = (streams.watts as Stream)?.data
  const cad = (streams.cadence as Stream)?.data

  return time.map((t, i) => ({
    t,
    hr: hr?.[i],
    alt: alt?.[i],
    speed: vel ? +(vel[i] * 3.6).toFixed(1) : undefined,
    watts: watts?.[i],
    cadence: cad?.[i],
  }))
}

function computeStats(data: ChartPoint[]): ComputedStats {
  if (data.length === 0) return {}

  const watts = data.map(d => d.watts).filter((w): w is number => w !== undefined && w > 0)
  const speed = data.map(d => d.speed).filter((s): s is number => s !== undefined)
  const cad = data.map(d => d.cadence).filter((c): c is number => c !== undefined && c > 0)
  const alt = data.map(d => d.alt).filter((a): a is number => a !== undefined)

  let elevGain = 0
  for (let i = 1; i < alt.length; i++) {
    const diff = alt[i] - alt[i - 1]
    if (diff > 0) elevGain += diff
  }

  return {
    avgWatts: watts.length ? Math.round(mean(watts)) : undefined,
    maxWatts: watts.length ? Math.max(...watts) : undefined,
    avgSpeed: speed.length ? +mean(speed).toFixed(1) : undefined,
    maxSpeed: speed.length ? +Math.max(...speed).toFixed(1) : undefined,
    elevationGain: alt.length ? Math.round(elevGain) : undefined,
    avgCadence: cad.length ? Math.round(mean(cad)) : undefined,
  }
}

function formatDuration(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

function speedToPace(speedKmh: number): string {
  const paceMinKm = 60 / speedKmh
  const min = Math.floor(paceMinKm)
  const sec = Math.round((paceMinKm - min) * 60)
  return `${min}:${String(sec).padStart(2, '0')} min/km`
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
  const [athleteName, setAthleteName] = useState<string | null>(null)
  const [runSplits, setRunSplits] = useState<RunSplit[]>([])
  const [analysing, setAnalysing] = useState(false)
  const [analysis, setAnalysis] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        setAthleteName(athlete.name ?? null)

        const { data: actData } = await supabase
          .from('activities')
          .select('*')
          .eq('strava_id', Number(id))
          .single()
        if (!actData) throw new Error('Activity not found')
        const act = actData as Activity
        setActivity(act)
        setAnalysis(act.claude_analysis)

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

  function triggerRecoveryExtraction(analysisText: string, aId: string, actId: string) {
    buildCoachSystemPrompt(aId)
      .then(systemPrompt =>
        fetch('/api/analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: `Extrahiere aus dieser Trainingsanalyse eine konkrete Erholungsempfehlung als JSON:\n{"has_restriction": boolean, "restriction_until": "YYYY-MM-DD or null", "description": "string"}\nNur JSON, kein Text davor oder danach.\n\nAnalyse:\n${analysisText}`,
            system: systemPrompt,
            max_tokens: 150,
          }),
        })
      )
      .then(r => r.json())
      .then(async (json: { text: string }) => {
        const match = json.text.match(/\{[\s\S]*\}/)
        if (!match) return
        const restriction = JSON.parse(match[0]) as {
          has_restriction: boolean
          restriction_until: string | null
          description: string
        }
        if (!restriction.has_restriction || !restriction.description) return
        await supabase.from('coach_decisions').insert({
          athlete_id:          aId,
          decision_type:       'recovery_required',
          decision_summary:    restriction.description.split(/[.!?]/)[0]?.trim() ?? restriction.description,
          reasoning:           restriction.description + (restriction.restriction_until ? ` (bis ${restriction.restriction_until})` : ''),
          related_plan_id:     null,
          related_activity_id: actId,
        })
      })
      .catch(() => { /* silent — recovery extraction is best-effort */ })
  }

  function getSpecialistPrompt(type: string): {
    specialist: string | null
    sport: 'running' | 'cycling' | 'strength' | null
  } {
    if (['Run', 'VirtualRun', 'TrailRun'].includes(type))
      return { specialist: LAUF_COACH_PROMPT, sport: 'running' }
    if (['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide'].includes(type))
      return { specialist: RAD_COACH_PROMPT, sport: 'cycling' }
    if (['WeightTraining', 'Workout'].includes(type))
      return { specialist: KRAFT_COACH_PROMPT, sport: 'strength' }
    return { specialist: null, sport: null }
  }

  async function runAnalysis() {
    if (!activity || !athleteId) return
    setAnalysing(true)
    try {
      const { specialist, sport } = getSpecialistPrompt(activity.type)

      const [basePrompt, generalContext, specialistContext] = await Promise.all([
        buildCoachSystemPrompt(athleteId, sport),
        buildCoachContext(athleteId, undefined, sport),
        sport ? buildSpecialistContext(athleteId, sport) : Promise.resolve(null),
      ])

      const system = specialist ? basePrompt + '\n\n' + specialist : basePrompt

      const contextBlock = [generalContext, specialistContext].filter(Boolean).join('\n\n')

      const activityBlock = `Analysiere diese Trainingsaktivität${athleteName ? ` von ${athleteName}` : ''}:

Name: ${activity.name}
Typ: ${activity.type}
Datum: ${new Date(activity.date).toLocaleDateString('de-DE')}
Distanz: ${activity.distance_m ? (activity.distance_m / 1000).toFixed(2) + ' km' : 'k.A.'}
Dauer: ${activity.duration_s ? Math.round(activity.duration_s / 60) + ' min' : 'k.A.'}
Ø Herzfrequenz: ${activity.avg_hr ?? 'k.A.'} bpm
Max. Herzfrequenz: ${activity.max_hr ?? 'k.A.'} bpm
${activity.np_watts ? `Normalized Power: ${activity.np_watts} W` : ''}
${stats.avgWatts ? `Ø Watt: ${stats.avgWatts} W` : ''}
${stats.maxWatts ? `Max Watt: ${stats.maxWatts} W` : ''}
${stats.elevationGain ? `Höhenmeter: ${stats.elevationGain} m` : ''}
${exercises.length > 0 ? `
Übungen:
${exercises.map(ex => {
  const sets = ex.sets.map(s =>
    s.weight != null ? `${s.weight} kg × ${s.reps}` : `${s.reps} Wdh`
  ).join(', ')
  return `  ${ex.name}: ${sets}${ex.totalVolume > 0 ? ` (${ex.totalVolume} kg Volumen)` : ''}`
}).join('\n')}
Gesamtvolumen: ${exercises.reduce((s, ex) => s + ex.totalVolume, 0).toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg` : ''}
${laps.length > 1 ? `
Runden (${laps.length} gesamt):
${laps.map(lap => {
  const parts = [`  Runde ${lap.lap_index}: ${formatDuration(lap.elapsed_time)}`]
  if (lap.distance > 0) parts.push(`${(lap.distance / 1000).toFixed(2)} km`)
  if (lap.average_watts != null) parts.push(`Ø ${Math.round(lap.average_watts)} W`)
  if (lap.average_heartrate != null) parts.push(`Ø ${Math.round(lap.average_heartrate)} bpm`)
  if (lap.average_cadence != null) parts.push(`Ø ${Math.round(lap.average_cadence)} rpm`)
  return parts.join(' | ')
}).join('\n')}` : ''}

Schreibe eine kompakte Trainingsanalyse auf Deutsch (ca. 200 Wörter). Formatierungsregeln:
- Verwende NUR diese Markdown-Elemente: **fett** für Schlüsselbegriffe, Bindestriche für Aufzählungen
- Keine Tabellen, keine Emojis, keine Trennlinien, keine Unterüberschriften
- Gliedere mit nummerierten Fließtext-Abschnitten

Struktur:
${exercises.length > 0
  ? '1. **Volumen & Intensität** – Gesamtbelastung, stärkste Übungen\n2. **Übungsanalyse** – Satzqualität, Progression, auffällige Werte\n3. **Stärken** – was gut lief\n4. **Empfehlung** – nächste Einheit'
  : laps.length > 1
    ? '1. **Intensitätsbewertung** – Gesamtbelastung und Intensitätsbereiche\n2. **Rundenanalyse** – Progression, Gleichmäßigkeit, Ausreißer\n3. **Stärken** – was gut lief\n4. **Empfehlung** – nächste Einheit'
    : '1. **Intensitätsbewertung** – Gesamtbelastung und Intensitätsbereiche\n2. **Stärken** – was gut lief\n3. **Verbesserungspotenzial** – was optimiert werden kann\n4. **Empfehlung** – nächste Einheit'}`

      const prompt = contextBlock + '\n\n' + activityBlock

      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, system }),
      })
      if (!res.ok) throw new Error('Claude API Fehler')
      const json = await res.json() as { text: string }
      const text = json.text

      setAnalysis(text)
      await supabase.from('activities').update({ claude_analysis: text }).eq('strava_id', Number(id))

      // Extract recovery restriction into coach_decisions (fire-and-forget, non-blocking)
      if (athleteId && activity) {
        triggerRecoveryExtraction(text, athleteId, activity.id)
      }
    } catch (e) {
      console.error(e)
      setError('Analyse fehlgeschlagen.')
    } finally {
      setAnalysing(false)
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
        })}
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

      {/* ── Analyse-Button ─────────────────────────────────────── */}
      <div className="mb-6">
        <button
          onClick={runAnalysis}
          disabled={analysing}
          className="bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors flex items-center gap-2"
        >
          {analysing && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {analysing ? 'Analysiere…' : analysis ? 'Neu analysieren' : 'Analysieren'}
        </button>
      </div>

      {/* ── KI-Analyse ─────────────────────────────────────────── */}
      {analysis && (
        <div className="bg-slate-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-brand-400 uppercase tracking-wider mb-3">KI-Analyse</h2>
          <div className="space-y-1">{renderMarkdown(analysis)}</div>
        </div>
      )}
    </div>
    </>
  )
}
