import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts'
import { supabase, type Athlete, type SeasonGoal, type Activity } from '../lib/supabase'
import { calculateFinishTimeProgression, resolveHRProfile, type FinishTimeProgressionPoint } from '../lib/coachContext'
import { addDays, formatRaceTime, getISOMonday, toDateStr } from '../lib/dateUtils'
import { DAYS, dayMatchesSport, isRestDay, type PlanJson } from '../lib/weeklyPlan'
import { IconChevronRight, IconRefresh, IconTrophy } from '../lib/icons'
import { COACH_STYLE_PROMPTS, DEFAULT_STYLE } from '../lib/coachPrompt'
import { renderMarkdown } from '../lib/markdown'

// Rückblick auf ein vergangenes Saisonziel (GoalDetail.tsx zeigt ihn statt Phasen-Grafik
// und Zielzeit-Schätzung, sobald event_date vorbei ist). Alle Zahlen fest berechnet,
// kein Claude-Call — das Coach-Fazit kommt als eigener Abschnitt dazu.

const RUN_TYPES = ['Run', 'VirtualRun', 'TrailRun']
const RIDE_TYPES = ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide']
const STRENGTH_TYPES = ['WeightTraining']

const PREP_DAYS = 84 // "Vorbereitung" = die 12 Wochen vor dem Renntag

// Gleiche Abdeckung wie die Progressions-Grafik in GoalDetail.tsx (8 Punkte à 14 Tage),
// nur mit dem Renntag statt heute als Endpunkt.
const PROGRESSION_POINTS = 8
const PROGRESSION_STEP_DAYS = 14
const PROGRESSION_FETCH_DAYS = (PROGRESSION_POINTS - 1) * PROGRESSION_STEP_DAYS + 180

type SportKey = 'running' | 'cycling'

function goalSportKey(sportType: string | null): SportKey | null {
  if (sportType === 'Laufen') return 'running'
  if (sportType === 'Radfahren') return 'cycling'
  return null
}

function activitySportKey(type: string): 'running' | 'cycling' | 'strength' | null {
  if (RUN_TYPES.includes(type)) return 'running'
  if (RIDE_TYPES.includes(type)) return 'cycling'
  if (STRENGTH_TYPES.includes(type)) return 'strength'
  return null
}

function formatPace(secPerKm: number): string {
  const s = Math.round(secPerKm)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function localDayStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export type PrepStats = {
  sportSessions: number
  sportKm: number
  sportHours: number
  longestKm: number
  allSessions: number
  plannedDays: number
  completedDays: number
  sickDays: number
}

export function GoalRecap({ athlete, goal }: { athlete: Athlete; goal: SeasonGoal }) {
  const navigate = useNavigate()
  const sport = goalSportKey(goal.sport_type)
  const raceStart = localDayStart(goal.event_date)

  const [loading, setLoading] = useState(true)
  const [raceActivity, setRaceActivity] = useState<Activity | null>(null)
  const [dayActivities, setDayActivities] = useState<Activity[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [prep, setPrep] = useState<PrepStats | null>(null)
  const [runs, setRuns] = useState<Activity[]>([])
  const [notes, setNotes] = useState(goal.recap_user_notes ?? '')
  const [summary, setSummary] = useState(goal.recap_summary)
  const [generating, setGenerating] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    ;(async () => {
      const raceEnd = addDays(raceStart, 1)
      const prepStart = addDays(raceStart, -PREP_DAYS)

      const [{ data: dayActs }, { data: prepActs }, { data: plans }, { data: illnesses }] = await Promise.all([
        supabase
          .from('activities')
          .select('*')
          .eq('athlete_id', athlete.id)
          .gte('date', raceStart.toISOString())
          .lt('date', raceEnd.toISOString())
          .order('date', { ascending: true }),
        supabase
          .from('activities')
          .select('date, type, distance_m, duration_s')
          .eq('athlete_id', athlete.id)
          .gte('date', prepStart.toISOString())
          .lt('date', raceStart.toISOString()),
        supabase
          .from('weekly_plans')
          .select('week_start, version, plan_json')
          .eq('athlete_id', athlete.id)
          .gte('week_start', toDateStr(getISOMonday(prepStart)))
          .lte('week_start', goal.event_date),
        supabase
          .from('illness_periods')
          .select('start_date, end_date')
          .eq('athlete_id', athlete.id)
          .lt('start_date', goal.event_date),
      ])

      // Rennaktivität: manuell gewählte hat Vorrang, sonst die längste passende vom Renntag
      const sameDay = (dayActs ?? []) as Activity[]
      setDayActivities(sameDay)
      let race: Activity | null = null
      if (goal.race_activity_id) {
        race = sameDay.find(a => a.id === goal.race_activity_id) ?? null
        if (!race) {
          const { data } = await supabase.from('activities').select('*').eq('id', goal.race_activity_id).maybeSingle()
          race = (data as Activity | null) ?? null
        }
      }
      if (!race) {
        const candidates = sport ? sameDay.filter(a => activitySportKey(a.type) === sport) : sameDay
        race = [...candidates].sort((a, b) => (b.duration_s ?? 0) - (a.duration_s ?? 0))[0] ?? null
      }
      setRaceActivity(race)

      setPrep(calculatePrepStats(
        (prepActs ?? []) as Activity[],
        (plans ?? []) as { week_start: string; version: number; plan_json: PlanJson }[],
        (illnesses ?? []) as { start_date: string; end_date: string | null }[],
        sport, prepStart, raceStart,
      ))

      if (sport === 'running' && goal.distance_km) {
        const { data: runs } = await supabase
          .from('activities')
          .select('id, date, distance_m, duration_s, avg_hr')
          .eq('athlete_id', athlete.id)
          .in('type', RUN_TYPES)
          .gte('date', addDays(raceStart, -PROGRESSION_FETCH_DAYS).toISOString())
          .lt('date', raceStart.toISOString())
          .order('date', { ascending: false })
        setRuns((runs ?? []) as Activity[])
      }

      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athlete.id, goal.id])

  // Prognose für die tatsächlich gelaufene Distanz (Strecken weichen oft vom
  // eingetragenen Zielwert ab, z.B. "8K" = 7,5 km), sonst für die Zieldistanz.
  // Neu berechnet, wenn eine andere Rennaktivität gewählt wird.
  const progression = useMemo<FinishTimeProgressionPoint[]>(() => {
    if (sport !== 'running' || !runs.length) return []
    const raceKm = raceActivity?.distance_m ? raceActivity.distance_m / 1000 : goal.distance_km
    if (!raceKm) return []
    const { effectiveMaxHR, restingHR } = resolveHRProfile(athlete)
    const evaluationDates: Date[] = []
    for (let i = PROGRESSION_POINTS - 1; i >= 0; i--) {
      evaluationDates.push(addDays(raceStart, -i * PROGRESSION_STEP_DAYS))
    }
    return calculateFinishTimeProgression(
      raceKm, effectiveMaxHR, restingHR, athlete.max_hr != null, athlete.strava_prs, runs, evaluationDates,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, raceActivity?.id])

  // Eigener Text: Auto-Save 800ms wie im Profil
  function changeNotes(value: string) {
    setNotes(value)
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(() => {
      void supabase.from('season_goals')
        .update({ recap_user_notes: value.trim() || null })
        .eq('id', goal.id).eq('athlete_id', athlete.id)
    }, 800)
  }

  async function generateSummary() {
    setGenerating(true)
    setSummaryError(null)
    try {
      const style = (athlete.coach_persona as Record<string, string> | null)?.style ?? DEFAULT_STYLE
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: buildRecapSystemPrompt(COACH_STYLE_PROMPTS[style] ?? COACH_STYLE_PROMPTS[DEFAULT_STYLE]),
          prompt: buildRecapPrompt(goal, raceActivity, prediction?.estimatedSeconds ?? null, prep, notes),
          max_tokens: 800,
        }),
      })
      if (!res.ok) throw new Error('Claude API Fehler')
      const { text } = await res.json() as { text: string }
      const at = new Date().toISOString()
      await supabase.from('season_goals')
        .update({ recap_user_notes: notes.trim() || null, recap_summary: text, recap_summary_at: at })
        .eq('id', goal.id).eq('athlete_id', athlete.id)
      setSummary(text)
    } catch {
      setSummaryError('Das Fazit konnte gerade nicht erstellt werden. Bitte später nochmal versuchen.')
    } finally {
      setGenerating(false)
    }
  }

  async function chooseRaceActivity(act: Activity) {
    setRaceActivity(act)
    setShowPicker(false)
    await supabase.from('season_goals').update({ race_activity_id: act.id }).eq('id', goal.id).eq('athlete_id', athlete.id)
  }

  if (loading) {
    return <div className="py-16 flex justify-center text-slate-500">Lädt…</div>
  }

  // Prognose = letzter Progressionspunkt, sofern er wirklich am Renntag liegt
  const lastPoint = progression[progression.length - 1]
  const prediction = lastPoint && new Date(lastPoint.date).getTime() === raceStart.getTime() ? lastPoint : null
  const raceSeconds = raceActivity?.duration_s ?? null
  // Y-Achse so wählen, dass auch die tatsächliche Rennzeit (gelbe Linie) sichtbar ist
  const chartSeconds = [...progression.map(p => p.estimatedSeconds), ...(raceSeconds != null ? [raceSeconds] : [])]
  const chartPad = chartSeconds.length ? Math.max(30, (Math.max(...chartSeconds) - Math.min(...chartSeconds)) * 0.1) : 0
  const chartDomain: [number, number] = chartSeconds.length
    ? [Math.floor(Math.min(...chartSeconds) - chartPad), Math.ceil(Math.max(...chartSeconds) + chartPad)]
    : [0, 0]

  return (
    <>
      {/* Ergebnis */}
      <div className="bg-slate-800 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-slate-400 uppercase tracking-wider">Dein Ergebnis</p>
          {dayActivities.length > 1 && (
            <button onClick={() => setShowPicker(true)} className="text-xs text-brand-500 hover:text-brand-400">
              Andere Aktivität wählen
            </button>
          )}
        </div>

        {raceActivity ? (
          <>
            <button
              onClick={() => navigate(`/activity/${raceActivity.strava_id}`, { state: { from: `/goals/${goal.id}` } })}
              className="w-full text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <IconTrophy size={16} className="text-yellow-400 shrink-0" />
                  <span className="text-slate-300 text-sm truncate">{raceActivity.name}</span>
                </div>
                <IconChevronRight size={12} className="text-slate-500 shrink-0" />
              </div>
              {raceSeconds != null && (
                <p className="text-3xl font-bold text-slate-100 mt-2">{formatRaceTime(raceSeconds)}</p>
              )}
            </button>
            <RaceStats activity={raceActivity} />

            {prediction && raceSeconds != null && (
              <PredictionComparison predictedSeconds={prediction.estimatedSeconds} actualSeconds={raceSeconds} />
            )}
          </>
        ) : (
          <div>
            <p className="text-slate-400 text-sm">Keine passende Strava-Aktivität vom Renntag gefunden.</p>
            {dayActivities.length > 0 && (
              <button onClick={() => setShowPicker(true)} className="text-sm text-brand-500 hover:text-brand-400 mt-2">
                Aktivität vom Renntag auswählen
              </button>
            )}
          </div>
        )}
      </div>

      {/* Vorbereitung */}
      {prep && <PrepCard prep={prep} sport={sport} />}

      {/* Zielzeit-Entwicklung bis zum Renntag */}
      {progression.length >= 2 && (
        <div className="bg-slate-800 rounded-2xl p-5 mb-4">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">Entwicklung der Zielzeit</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart
              data={progression.map(p => ({
                label: new Date(p.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
                fullDate: p.date,
                seconds: p.estimatedSeconds,
              }))}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="label" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis
                domain={chartDomain}
                reversed
                stroke="#64748b"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => formatRaceTime(v)}
                width={56}
              />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8 }}
                labelFormatter={(_, payload) => {
                  const fullDate = payload?.[0]?.payload?.fullDate
                  return fullDate ? new Date(fullDate).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
                }}
                formatter={(v: unknown) => [formatRaceTime(Number(v)), 'Prognose']}
              />
              {raceSeconds != null && (
                <ReferenceLine y={raceSeconds} stroke="#facc15" strokeDasharray="4 4" />
              )}
              <Line type="monotone" dataKey="seconds" stroke="#1D9E75" strokeWidth={2} dot={{ r: 3, fill: '#1D9E75' }} />
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-slate-500 mt-2">
            Grün = vorhergesagte Zielzeit im Verlauf der Vorbereitung{raceSeconds != null ? ', gelb = deine tatsächliche Rennzeit' : ''}. Oben = schneller.
          </p>
        </div>
      )}

      {/* Eigener Rückblick */}
      <div className="bg-slate-800 rounded-2xl p-5 mb-4">
        <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">Wie lief's für dich?</p>
        <textarea
          value={notes}
          onChange={e => changeNotes(e.target.value)}
          placeholder="Gefühl, Wetter, Strecke, Probleme… z.B. bewusst locker gelaufen, Seitenstechen ab km 5"
          rows={3}
          className="w-full bg-slate-700 text-slate-100 rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
        />
        <p className="text-xs text-slate-500 mt-1">Wird automatisch gespeichert und fließt ins Coach-Fazit ein.</p>
      </div>

      {/* Coach-Fazit */}
      <div className="bg-slate-800 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-slate-400 uppercase tracking-wider">Fazit vom Coach</p>
          {summary && !generating && (
            <button
              onClick={generateSummary}
              className="inline-flex items-center gap-1 text-xs text-brand-500 hover:text-brand-400"
            >
              <IconRefresh size={11} /> Neu erstellen
            </button>
          )}
        </div>
        {generating ? (
          <p className="text-slate-400 text-sm">Coach schreibt das Fazit…</p>
        ) : summary ? (
          <div className="space-y-1 break-words text-sm text-slate-300">{renderMarkdown(summary)}</div>
        ) : (
          <>
            <p className="text-slate-400 text-sm mb-3">
              Der Coach fasst Rennen und Vorbereitung zusammen. Trag am besten vorher oben ein, wie es für dich lief.
            </p>
            <button
              onClick={generateSummary}
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 transition-colors"
            >
              Fazit erstellen
            </button>
          </>
        )}
        {summaryError && <p className="text-sm text-red-400 mt-2">{summaryError}</p>}
      </div>

      {showPicker && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4"
          onClick={() => setShowPicker(false)}
        >
          <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <p className="text-slate-100 font-semibold mb-3">Welche Aktivität war das Rennen?</p>
            <ul className="flex flex-col gap-2">
              {dayActivities.map(a => (
                <li key={a.id}>
                  <button
                    onClick={() => chooseRaceActivity(a)}
                    className={`w-full text-left rounded-xl px-3 py-2 text-sm transition-colors ${
                      a.id === raceActivity?.id ? 'bg-brand-500/20 text-brand-400' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                    }`}
                  >
                    <span className="block truncate">{a.name}</span>
                    <span className="text-xs text-slate-400">
                      {a.duration_s != null ? formatRaceTime(a.duration_s) : '—'}
                      {a.distance_m ? ` · ${(a.distance_m / 1000).toFixed(1)} km` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() => setShowPicker(false)}
              className="mt-4 w-full text-center text-sm text-brand-500 hover:text-brand-400 py-2"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Teilansichten ─────────────────────────────────────────────────────────

function RaceStats({ activity }: { activity: Activity }) {
  const km = activity.distance_m ? activity.distance_m / 1000 : null
  const isRun = RUN_TYPES.includes(activity.type)
  const isRide = RIDE_TYPES.includes(activity.type)
  const watts = activity.np_watts ?? activity.avg_watts
  const stats: { label: string; value: string }[] = []
  if (km) stats.push({ label: 'Distanz', value: `${km.toFixed(2)} km` })
  if (isRun && km && activity.duration_s) stats.push({ label: 'Tempo', value: `${formatPace(activity.duration_s / km)} /km` })
  if (isRide && km && activity.duration_s) stats.push({ label: 'Ø Tempo', value: `${(km / (activity.duration_s / 3600)).toFixed(1)} km/h` })
  if (isRide && watts) stats.push({ label: activity.device_watts === false ? 'Watt (geschätzt)' : activity.np_watts ? 'NP' : 'Ø Watt', value: `${Math.round(watts)} W` })
  if (activity.avg_hr) stats.push({ label: 'Ø Puls', value: `${Math.round(activity.avg_hr)} bpm` })
  if (activity.elevation_m) stats.push({ label: 'Höhenmeter', value: `${Math.round(activity.elevation_m)} hm` })
  if (!stats.length) return null
  return (
    <div className="grid grid-cols-2 gap-3 mt-4">
      {stats.map(s => (
        <div key={s.label}>
          <p className="text-xs text-slate-500">{s.label}</p>
          <p className="text-slate-100 font-semibold">{s.value}</p>
        </div>
      ))}
    </div>
  )
}

function PredictionComparison({ predictedSeconds, actualSeconds }: { predictedSeconds: number; actualSeconds: number }) {
  const diff = actualSeconds - predictedSeconds
  const pct = Math.abs(diff) / predictedSeconds * 100
  const faster = diff < 0
  const close = pct < 1
  return (
    <div className="mt-4 pt-4 border-t border-slate-700">
      <p className="text-xs text-slate-500">Prognose am Renntag</p>
      <p className="text-slate-300 text-sm mt-0.5">
        Vorhergesagt {formatRaceTime(predictedSeconds)} → gelaufen {formatRaceTime(actualSeconds)}
      </p>
      <p className={`text-sm font-semibold mt-1 ${close ? 'text-slate-200' : faster ? 'text-brand-400' : 'text-amber-400'}`}>
        {close
          ? 'Fast genau wie vorhergesagt'
          : `${formatRaceTime(Math.abs(diff))} ${faster ? 'schneller' : 'langsamer'} als vorhergesagt (${pct.toFixed(1)} %)`}
      </p>
    </div>
  )
}

function PrepCard({ prep, sport }: { prep: PrepStats; sport: SportKey | null }) {
  const sportLabel = sport === 'running' ? 'Läufe' : sport === 'cycling' ? 'Ausfahrten' : null
  const adherencePct = prep.plannedDays > 0 ? Math.round(prep.completedDays / prep.plannedDays * 100) : null
  const rows: { label: string; value: string }[] = []
  if (sportLabel) {
    rows.push({ label: sportLabel, value: String(prep.sportSessions) })
    rows.push({ label: 'Kilometer', value: `${Math.round(prep.sportKm)} km` })
    rows.push({ label: 'Stunden', value: `${prep.sportHours.toFixed(1)} h` })
    rows.push({ label: sport === 'running' ? 'Längster Lauf' : 'Längste Ausfahrt', value: `${prep.longestKm.toFixed(1)} km` })
  }
  rows.push({ label: 'Einheiten gesamt', value: String(prep.allSessions) })
  if (adherencePct != null) rows.push({ label: 'Plantreue', value: `${prep.completedDays} von ${prep.plannedDays} (${adherencePct} %)` })
  if (prep.sickDays > 0) rows.push({ label: 'Krankheitstage', value: String(prep.sickDays) })

  return (
    <div className="bg-slate-800 rounded-2xl p-5 mb-4">
      <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">Deine Vorbereitung · 12 Wochen</p>
      <div className="grid grid-cols-2 gap-3">
        {rows.map(r => (
          <div key={r.label}>
            <p className="text-xs text-slate-500">{r.label}</p>
            <p className="text-slate-100 font-semibold">{r.value}</p>
          </div>
        ))}
      </div>
      {adherencePct != null && (
        <p className="text-xs text-slate-500 mt-3">
          Plantreue = geplante Trainingstage, an denen du eine Einheit der passenden Sportart absolviert hast.
        </p>
      )}
    </div>
  )
}

// ── Coach-Fazit ──────────────────────────────────────────────────────────

// Bewusst NICHT buildCoachSystemPrompt(): der enthält das aktuelle A-Ziel und die
// Saisonphase — das Fazit soll aber nur auf dieses eine vergangene Ziel schauen,
// ohne Ausblick auf kommende Ziele (Nutzerwunsch, v.a. bei anderer Sportart).
function buildRecapSystemPrompt(stylePrompt: string): string {
  return `Du bist ein erfahrener Ausdauer-Trainer und schreibst das Fazit zu einem abgeschlossenen Wettkampf deines Athleten.

${stylePrompt}

Inhalt:
- Bewerte das Rennergebnis und die Vorbereitung anhand der gelieferten Zahlen.
- Benenne, was gut lief und was weniger gut lief.
- Berücksichtige die eigene Einschätzung des Athleten, falls vorhanden. Sie hat Vorrang vor deiner Interpretation der Zahlen (z.B. bewusst locker gelaufen → langsamere Zeit ist kein Leistungsproblem).
- Weicht die Rennzeit stark von der Prognose ab und der Athlet nennt keinen Grund, ordne das vorsichtig ein, ohne einen Grund zu erfinden.

Strikte Grenzen:
- Schreibe AUSSCHLIESSLICH über dieses eine Rennen und seine Vorbereitung.
- Erwähne KEINE kommenden Ziele, Wettkämpfe, Saisonpläne oder andere Sportarten, und gib keine Empfehlungen für die nächste Trainingsphase.
- Erfinde keine Zahlen, nutze nur die gelieferten Daten.

Format: kompakter Fließtext auf Deutsch, ca. 120–180 Wörter. Keine Überschriften, keine Tabellen, keine Emojis. Erlaubt sind nur **fett** und kurze Aufzählungspunkte.`
}

function buildRecapPrompt(
  goal: SeasonGoal,
  race: Activity | null,
  predictedSeconds: number | null,
  prep: PrepStats | null,
  notes: string,
): string {
  const lines: string[] = []
  lines.push(`WETTKAMPF: ${goal.event_name}, ${new Date(goal.event_date).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}`)
  lines.push(`Sportart: ${goal.sport_type ?? '—'}, Priorität ${goal.priority}${goal.distance_km ? `, geplante Distanz ${goal.distance_km} km` : ''}${goal.elevation_m ? `, ${goal.elevation_m} hm` : ''}`)
  if (goal.notes) lines.push(`Notizen zum Ziel: ${goal.notes}`)

  lines.push('')
  if (race) {
    const km = race.distance_m ? race.distance_m / 1000 : null
    lines.push(`RENNERGEBNIS (Strava-Aktivität "${race.name}"):`)
    if (race.duration_s) lines.push(`- Zeit (Bewegungszeit): ${formatRaceTime(race.duration_s)}`)
    if (km) lines.push(`- Distanz: ${km.toFixed(2)} km`)
    if (km && race.duration_s && RUN_TYPES.includes(race.type)) lines.push(`- Tempo: ${formatPace(race.duration_s / km)} /km`)
    if (km && race.duration_s && RIDE_TYPES.includes(race.type)) lines.push(`- Ø Tempo: ${(km / (race.duration_s / 3600)).toFixed(1)} km/h`)
    const watts = race.np_watts ?? race.avg_watts
    if (watts && RIDE_TYPES.includes(race.type)) lines.push(`- ${race.np_watts ? 'NP' : 'Ø Watt'}: ${Math.round(watts)} W${race.device_watts === false ? ' (von Strava geschätzt, kein Powermeter)' : ''}`)
    if (race.avg_hr) lines.push(`- Ø Puls: ${Math.round(race.avg_hr)} bpm${race.max_hr ? `, max ${Math.round(race.max_hr)} bpm` : ''}`)
    if (race.elevation_m) lines.push(`- Höhenmeter: ${Math.round(race.elevation_m)}`)
    if (predictedSeconds != null && race.duration_s) {
      const diffPct = (race.duration_s - predictedSeconds) / predictedSeconds * 100
      lines.push(`- App-Prognose am Renntag (aus Trainingsdaten berechnet): ${formatRaceTime(predictedSeconds)} → Abweichung ${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)} %`)
    }
  } else {
    lines.push('RENNERGEBNIS: keine Strava-Aktivität vom Renntag vorhanden.')
  }

  if (prep) {
    lines.push('')
    lines.push('VORBEREITUNG (12 Wochen vor dem Renntag):')
    if (goal.sport_type === 'Laufen' || goal.sport_type === 'Radfahren') {
      lines.push(`- ${goal.sport_type}: ${prep.sportSessions} Einheiten, ${Math.round(prep.sportKm)} km, ${prep.sportHours.toFixed(1)} h, längste Einheit ${prep.longestKm.toFixed(1)} km`)
    }
    lines.push(`- Einheiten gesamt (alle Sportarten): ${prep.allSessions}`)
    if (prep.plannedDays > 0) lines.push(`- Plantreue: ${prep.completedDays} von ${prep.plannedDays} geplanten Trainingstagen absolviert (${Math.round(prep.completedDays / prep.plannedDays * 100)} %)`)
    if (prep.sickDays > 0) lines.push(`- Krankheitstage: ${prep.sickDays}`)
  }

  lines.push('')
  lines.push(notes.trim()
    ? `EIGENE EINSCHÄTZUNG DES ATHLETEN:\n${notes.trim()}`
    : 'EIGENE EINSCHÄTZUNG DES ATHLETEN: keine angegeben.')

  return lines.join('\n')
}

// ── Berechnung ───────────────────────────────────────────────────────────

export function calculatePrepStats(
  activities: Activity[],
  plans: { week_start: string; version: number; plan_json: PlanJson }[],
  illnesses: { start_date: string; end_date: string | null }[],
  sport: SportKey | null,
  prepStart: Date,
  raceStart: Date,
): PrepStats {
  const sportActs = sport ? activities.filter(a => activitySportKey(a.type) === sport) : []
  const sportKm = sportActs.reduce((s, a) => s + (a.distance_m ?? 0), 0) / 1000
  const sportHours = sportActs.reduce((s, a) => s + (a.duration_s ?? 0), 0) / 3600
  const longestKm = sportActs.reduce((m, a) => Math.max(m, (a.distance_m ?? 0) / 1000), 0)

  // Sportarten je Kalendertag (Lokalzeit), für den Abgleich mit dem Plan
  const sportsByDay = new Map<string, Set<string>>()
  for (const a of activities) {
    const key = activitySportKey(a.type)
    if (!key) continue
    const day = toDateStr(new Date(a.date))
    if (!sportsByDay.has(day)) sportsByDay.set(day, new Set())
    sportsByDay.get(day)!.add(key)
  }

  // Neueste Planversion je Woche
  const latestByWeek = new Map<string, { version: number; plan_json: PlanJson }>()
  for (const p of plans) {
    const prev = latestByWeek.get(p.week_start)
    if (!prev || p.version > prev.version) latestByWeek.set(p.week_start, p)
  }

  let plannedDays = 0
  let completedDays = 0
  for (const [weekStart, plan] of latestByWeek) {
    const monday = localDayStart(weekStart)
    DAYS.forEach((label, i) => {
      const date = addDays(monday, i)
      if (date < prepStart || date >= raceStart) return
      const day = plan.plan_json?.days?.[label]
      if (!day || isRestDay(day)) return
      plannedDays++
      const done = day._fulfilledBy != null
        || (['running', 'cycling', 'strength'] as const).some(s =>
          dayMatchesSport(day, s) && sportsByDay.get(toDateStr(date))?.has(s))
      if (done) completedDays++
    })
  }

  let sickDays = 0
  for (const ill of illnesses) {
    const from = Math.max(localDayStart(ill.start_date).getTime(), prepStart.getTime())
    const to = Math.min(ill.end_date ? localDayStart(ill.end_date).getTime() : raceStart.getTime(), raceStart.getTime())
    if (to > from) sickDays += Math.round((to - from) / (24 * 60 * 60 * 1000))
  }

  return {
    sportSessions: sportActs.length,
    sportKm,
    sportHours,
    longestKm,
    allSessions: activities.length,
    plannedDays,
    completedDays,
    sickDays,
  }
}
