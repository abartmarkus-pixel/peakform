import { supabase, type Activity, type Athlete } from './supabase'
import { toLocalWeekdayDateTimeStr, relativeDayLabel } from './dateUtils'
import {
  getValidAccessToken,
  fetchActivityStreams,
  fetchActivityLaps,
  fetchActivityDetail,
  type StravaLap,
  type StravaSplitMetric,
} from './strava'
import {
  buildCoachSystemPrompt,
  LAUF_COACH_PROMPT,
  RAD_COACH_PROMPT,
  KRAFT_COACH_PROMPT,
} from './coachPrompt'
import { buildCoachContext, buildSpecialistContext } from './coachContext'

// ── types (shared with ActivityDetail.tsx display logic) ──────────────────────

type ExerciseSet = {
  setNumber: number
  weight?: number
  reps: number
}

export type Exercise = {
  name: string
  sets: ExerciseSet[]
  totalVolume: number
  totalReps: number
}

export type ChartPoint = {
  t: number
  hr?: number
  alt?: number
  speed?: number
  watts?: number
  cadence?: number
}

export type ComputedStats = {
  maxWatts?: number
  avgSpeed?: number
  maxSpeed?: number
  avgCadence?: number
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function parseHevyDescription(description: string): Exercise[] {
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

export function buildChartData(streams: Record<string, unknown>): ChartPoint[] {
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

export function computeStats(data: ChartPoint[]): ComputedStats {
  if (data.length === 0) return {}

  const watts = data.map(d => d.watts).filter((w): w is number => w !== undefined && w > 0)
  const speed = data.map(d => d.speed).filter((s): s is number => s !== undefined)
  const cad = data.map(d => d.cadence).filter((c): c is number => c !== undefined && c > 0)

  return {
    maxWatts: watts.length ? Math.max(...watts) : undefined,
    avgSpeed: speed.length ? +mean(speed).toFixed(1) : undefined,
    maxSpeed: speed.length ? +Math.max(...speed).toFixed(1) : undefined,
    avgCadence: cad.length ? Math.round(mean(cad)) : undefined,
  }
}

export function formatDuration(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
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

// Fire-and-forget: extracts a recovery restriction from an analysis text into
// coach_decisions. Used both right after a fresh analysis and as an on-load
// backfill check for analyses that predate this extraction step.
export function triggerRecoveryExtraction(analysisText: string, athleteId: string, activityId: string) {
  buildCoachSystemPrompt(athleteId)
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
      if (restriction.has_restriction && restriction.description) {
        await supabase.from('coach_decisions').insert({
          athlete_id:          athleteId,
          decision_type:       'recovery_required',
          decision_summary:    restriction.description.split(/[.!?]/)[0]?.trim() ?? restriction.description,
          reasoning:           restriction.description + (restriction.restriction_until ? ` (bis ${restriction.restriction_until})` : ''),
          related_plan_id:     null,
          related_activity_id: activityId,
        })
      }
      // Mark checked regardless of outcome so ActivityDetail.tsx's on-load
      // check doesn't re-trigger this call on every future page load.
      await supabase.from('activities').update({ recovery_checked: true }).eq('id', activityId)
    })
    .catch(() => { /* silent — recovery extraction is best-effort; leaves
      recovery_checked false so it's retried on the next load */ })
}

// A claim older than this is considered abandoned (e.g. tab closed or network
// dropped mid-analysis) and can be re-claimed — comfortably above how long a
// single Claude analysis call actually takes, so a still-running claim is
// never pre-empted.
const ANALYSIS_CLAIM_STALE_MS = 2 * 60 * 1000

// Atomically claims an activity for automatic background analysis by writing
// analysis_claimed_at in one conditional UPDATE. Postgres applies the WHERE
// check and the write as a single atomic operation per row, so when two
// automatic sweeps race for the same unanalyzed activity (React StrictMode's
// dev-mode double-mount, or Dashboard and WeeklyPlan syncing around the same
// time), only one UPDATE actually matches — the loser gets an empty result
// and skips it, instead of both calling analyzeActivity() and paying for two
// Claude calls. Not used by the manual "Neu analysieren" button, which should
// always run regardless of any in-flight claim.
export async function claimActivityForAnalysis(activityId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - ANALYSIS_CLAIM_STALE_MS).toISOString()
  const { data } = await supabase
    .from('activities')
    .update({ analysis_claimed_at: new Date().toISOString() })
    .eq('id', activityId)
    .is('claude_analysis', null)
    .or(`analysis_claimed_at.is.null,analysis_claimed_at.lt.${staleBefore}`)
    .select('id')
  return (data?.length ?? 0) > 0
}

// Runs the full Claude analysis for an activity: loads/caches whatever raw
// Strava data the prompt needs (streams for watt/elevation stats, laps,
// description for Hevy exercises), builds the specialist-routed prompt,
// saves claude_analysis, and triggers recovery extraction. Mirrors exactly
// what ActivityDetail.tsx's manual "Analysieren" button used to do inline —
// this is the single implementation both the button and the background
// auto-analysis (post-sync) call into.
export async function analyzeActivity(
  activity: Activity,
  athleteId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: athleteData } = await supabase
      .from('athletes')
      .select('*')
      .eq('id', athleteId)
      .single()
    if (!athleteData) return { success: false, error: 'Athlete not found' }
    const athlete = athleteData as Athlete

    const token = await getValidAccessToken(athlete)
    const isRun = ['Run', 'VirtualRun', 'TrailRun'].includes(activity.type)

    const [streamsRaw, lapsData, splitsMetricData, description] = await Promise.all([
      activity.streams_json
        ? Promise.resolve(activity.streams_json)
        : fetchActivityStreams(token, activity.strava_id).then(async (s) => {
            await supabase.from('activities').update({ streams_json: s }).eq('strava_id', activity.strava_id).eq('athlete_id', athleteId)
            return s
          }).catch(() => ({} as Record<string, unknown>)),
      activity.laps_json
        ? Promise.resolve(activity.laps_json as unknown as StravaLap[])
        : fetchActivityLaps(token, activity.strava_id).then(async (l) => {
            if (l.length > 0) await supabase.from('activities').update({ laps_json: l }).eq('strava_id', activity.strava_id).eq('athlete_id', athleteId)
            return l
          }).catch(() => [] as StravaLap[]),
      isRun
        ? activity.splits_metric_json
          ? Promise.resolve(activity.splits_metric_json as unknown as StravaSplitMetric[])
          : fetchActivityDetail(token, activity.strava_id).then(async (d) => {
              const sm = d.splits_metric ?? []
              if (sm.length > 0) await supabase.from('activities').update({ splits_metric_json: sm }).eq('strava_id', activity.strava_id).eq('athlete_id', athleteId)
              return sm
            }).catch(() => [] as StravaSplitMetric[])
        : Promise.resolve([] as StravaSplitMetric[]),
      activity.type === 'WeightTraining'
        ? activity.description
          ? Promise.resolve(activity.description)
          : fetchActivityDetail(token, activity.strava_id).then(async (d) => {
              const desc = ('description' in d && d.description) ? String(d.description) : null
              if (desc) await supabase.from('activities').update({ description: desc }).eq('strava_id', activity.strava_id).eq('athlete_id', athleteId)
              return desc
            }).catch(() => null)
        : Promise.resolve(activity.description ?? null),
    ])

    const exercises = description ? parseHevyDescription(description) : []
    const chartData = buildChartData(streamsRaw as Record<string, unknown>)
    const stats = computeStats(chartData)
    const laps = lapsData as StravaLap[]
    const splits = splitsMetricData as StravaSplitMetric[]

    const { specialist, sport } = getSpecialistPrompt(activity.type)

    const [basePrompt, generalContext, specialistContext] = await Promise.all([
      buildCoachSystemPrompt(athleteId, sport),
      buildCoachContext(athleteId, undefined, sport),
      sport ? buildSpecialistContext(athleteId, sport) : Promise.resolve(null),
    ])

    const system = specialist ? basePrompt + '\n\n' + specialist : basePrompt
    const contextBlock = [generalContext, specialistContext].filter(Boolean).join('\n\n')

    const activityBlock = `Analysiere diese Trainingsaktivität${athlete.name ? ` von ${athlete.name}` : ''}:

Name: ${activity.name}
Typ: ${activity.type}
Datum: ${toLocalWeekdayDateTimeStr(activity.date)} (${relativeDayLabel(activity.date)})
Distanz: ${activity.distance_m ? (activity.distance_m / 1000).toFixed(2) + ' km' : 'k.A.'}
Dauer: ${activity.duration_s ? Math.round(activity.duration_s / 60) + ' min' : 'k.A.'}
Ø Herzfrequenz: ${activity.avg_hr ?? 'k.A.'} bpm
Max. Herzfrequenz: ${activity.max_hr ?? 'k.A.'} bpm
${activity.np_watts ? `Normalized Power: ${activity.np_watts} W` : ''}
${activity.avg_watts ? `Ø Watt: ${activity.avg_watts} W` : ''}
${stats.maxWatts ? `Max Watt: ${stats.maxWatts} W` : ''}
${activity.elevation_m ? `Höhenmeter: ${activity.elevation_m} m` : ''}
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
${splits.length > 1 ? `
Kilometer-Splits (${splits.length} gesamt):
${splits.map(s => {
  const parts = [`  km ${s.split}: ${formatDuration(s.elapsed_time)}`]
  if (s.distance > 0) parts.push(`${(s.distance / 1000).toFixed(2)} km`)
  if (s.average_heartrate != null) parts.push(`Ø ${Math.round(s.average_heartrate)} bpm`)
  return parts.join(' | ')
}).join('\n')}` : ''}

Schreibe eine kompakte Trainingsanalyse auf Deutsch (ca. 200 Wörter). Formatierungsregeln:
- Verwende NUR diese Markdown-Elemente: **fett** für Schlüsselbegriffe, Bindestriche für Aufzählungen
- Keine Tabellen, keine Emojis, keine Trennlinien, keine Unterüberschriften
- Gliedere mit nummerierten Fließtext-Abschnitten

Struktur:
${exercises.length > 0
  ? '1. **Volumen & Intensität** – Gesamtbelastung, stärkste Übungen\n2. **Übungsanalyse** – Satzqualität, Progression, auffällige Werte\n3. **Stärken** – was gut lief\n4. **Empfehlung** – nächste Einheit'
  : (laps.length > 1 || splits.length > 1)
    ? '1. **Intensitätsbewertung** – Gesamtbelastung und Intensitätsbereiche\n2. **Rundenanalyse** – Progression, Gleichmäßigkeit, Ausreißer\n3. **Stärken** – was gut lief\n4. **Empfehlung** – nächste Einheit'
    : '1. **Intensitätsbewertung** – Gesamtbelastung und Intensitätsbereiche\n2. **Stärken** – was gut lief\n3. **Verbesserungspotenzial** – was optimiert werden kann\n4. **Empfehlung** – nächste Einheit'}`

    const prompt = contextBlock + '\n\n' + activityBlock

    const res = await fetch('/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, system }),
    })
    if (!res.ok) return { success: false, error: 'Claude API Fehler' }
    const json = await res.json() as { text: string }
    const text = json.text

    await supabase.from('activities').update({ claude_analysis: text, analysis_claimed_at: null }).eq('strava_id', activity.strava_id)

    triggerRecoveryExtraction(text, athleteId, activity.id)

    return { success: true }
  } catch (e) {
    console.error(e)
    try {
      // Release the claim so a future sync can retry this activity; best-effort —
      // claude_analysis is still null either way, so nothing is lost if this fails too.
      await supabase.from('activities').update({ analysis_claimed_at: null }).eq('id', activity.id)
    } catch { /* best effort */ }
    return { success: false, error: e instanceof Error ? e.message : 'Analyse fehlgeschlagen' }
  }
}
