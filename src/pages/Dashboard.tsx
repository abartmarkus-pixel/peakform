import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

import { fetchRecentActivities, getValidAccessToken, syncActivitiesToSupabase, type StravaActivity } from '../lib/strava'
import { supabase, type Athlete } from '../lib/supabase'
import { buildCoachSystemPrompt } from '../lib/coachPrompt'
import {
  IconLogout, IconRunning, IconCycling, IconStrength, IconWarning,
} from '../lib/icons'
import { SPORT_DISPLAY } from '../lib/icons'
import { AppHeader } from '../components/AppHeader'
import { useFeatures } from '../lib/features'

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

// ── helpers ────────────────────────────────────────────────────────────────

function parsePlanJson(text: string): PlanJson {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = match ? match[1] : text
  return JSON.parse(raw.trim()) as PlanJson
}

function mondayOf(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().slice(0, 10)
}

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function formatDistance(meters: number) {
  return (meters / 1000).toFixed(2) + ' km'
}

function ActivityIcon({ type }: { type: string }) {
  if (type === 'Run' || type === 'VirtualRun' || type === 'TrailRun')
    return <IconRunning size={18} color={SPORT_DISPLAY.running.color} className="flex-shrink-0" />
  if (type === 'Ride' || type === 'VirtualRide' || type === 'MountainBikeRide' || type === 'GravelRide')
    return <IconCycling size={18} color={SPORT_DISPLAY.cycling.color} className="flex-shrink-0" />
  if (type === 'WeightTraining' || type === 'Workout')
    return <IconStrength size={18} color={SPORT_DISPLAY.strength.color} className="flex-shrink-0" />
  return <IconRunning size={18} className="flex-shrink-0 text-slate-400" />
}

// ── component ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const [activities,       setActivities]       = useState<StravaActivity[]>([])
  const [filter,           setFilter]           = useState<string | null>(null)
  const [loading,          setLoading]          = useState(true)
  const [error,            setError]            = useState<string | null>(null)

  const [athleteId,        setAthleteId]        = useState<string | null>(null)
  const [athlete,          setAthlete]          = useState<Athlete | null>(null)

  // alert state
  const [alert,            setAlert]            = useState<{ message: string } | null>(null)
  const [alertDismissed,   setAlertDismissed]   = useState(false)
  const [planModal,        setPlanModal]        = useState<{ loading: boolean; status: 'success' | 'error' | null } | null>(null)
  const [currentPlanJson,  setCurrentPlanJson]  = useState<PlanJson | null>(null)
  const [planWeekStart,    setPlanWeekStart]    = useState<string | null>(null)

  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    supabase
      .from('athletes')
      .select('*')
      .eq('strava_athlete_id', Number(stravaId))
      .single()
      .then(async ({ data, error: dbError }) => {
        if (dbError || !data) { navigate('/'); return }
        const athleteRow = data as Athlete
        setAthlete(athleteRow)
        setAthleteId(athleteRow.id)
        const athlete = athleteRow

        try {
          const token = await getValidAccessToken(athlete)
          const acts = await fetchRecentActivities(token)
          setActivities(acts)

          await syncActivitiesToSupabase(acts, athlete.id)

          // ── Echtzeit-Alert: einmal pro Session prüfen ──────────────────
          const thisWeek = mondayOf(new Date())
          const alertKey = `peakform_alert_${thisWeek}`

          if (!sessionStorage.getItem(alertKey)) {
            sessionStorage.setItem(alertKey, 'checked') // mark before async to prevent double-fire

            const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

            const [{ data: planRows }, { data: recentActs }, { data: recoveryRows }, systemPrompt] = await Promise.all([
              supabase
                .from('weekly_plans')
                .select('plan_json')
                .eq('athlete_id', athlete.id)
                .eq('week_start', thisWeek)
                .order('version', { ascending: false })
                .limit(1),
              supabase
                .from('activities')
                .select('name, type, date, duration_s, avg_hr, np_watts')
                .eq('athlete_id', athlete.id)
                .gte('date', thisWeek)
                .order('date', { ascending: false })
                .limit(1),
              supabase
                .from('coach_decisions')
                .select('decision_summary, reasoning, created_at')
                .eq('athlete_id', athlete.id)
                .eq('decision_type', 'recovery_required')
                .gte('created_at', fortyEightHoursAgo)
                .order('created_at', { ascending: false }),
              buildCoachSystemPrompt(athlete.id),
            ])

            const plan = planRows?.[0]
            const latestAct = recentActs?.[0]
            const hasRecovery = !!recoveryRows?.length

            // Auch ohne neue Aktivität prüfen, wenn eine frische Recovery-Empfehlung vorliegt,
            // die im aktuellen Plan noch nicht berücksichtigt sein könnte.
            if (plan && (latestAct || hasRecovery)) {
              setCurrentPlanJson(plan.plan_json as PlanJson)
              setPlanWeekStart(thisWeek)

              const activitySection = latestAct
                ? `Neueste Aktivität diese Woche:
- Name: ${latestAct.name}
- Typ: ${latestAct.type}
- Datum: ${new Date(latestAct.date).toLocaleDateString('de-DE')}
- Dauer: ${latestAct.duration_s ? Math.round(latestAct.duration_s / 60) : '?'} min
- Ø HF: ${latestAct.avg_hr ? Math.round(latestAct.avg_hr) : 'k.A.'} bpm
${latestAct.np_watts ? `- NP: ${Math.round(latestAct.np_watts)} W` : ''}`
                : 'Keine neue Aktivität diese Woche.'

              const recoverySection = hasRecovery
                ? `\nCoach-Erholungseinschätzungen der letzten 48h (noch nicht im Plan berücksichtigt):\n${
                    (recoveryRows ?? []).map(d =>
                      `- ${new Date(d.created_at).toLocaleDateString('de-DE')}: ${d.reasoning ?? d.decision_summary}`
                    ).join('\n')
                  }\n`
                : ''

              const checkPrompt = `Du bist der PeakForm Coach. Prüfe ob die folgende Situation den geplanten Wochenplan verletzt.

Wochenplan (JSON):
${JSON.stringify(plan.plan_json, null, 2)}

${activitySection}
${recoverySection}
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Text davor oder danach):
{"conflict": true, "message": "Kurze Beschreibung was nicht passt (max 20 Wörter)"}
oder
{"conflict": false, "message": null}`

              const res = await fetch('/api/analyse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  prompt: checkPrompt,
                  system: systemPrompt,
                  max_tokens: 150,
                }),
              })

              if (res.ok) {
                const { text } = await res.json() as { text: string }
                const match = text.match(/\{[\s\S]*\}/)
                if (match) {
                  try {
                    const parsed = JSON.parse(match[0]) as { conflict: boolean; message: string | null }
                    if (parsed.conflict && parsed.message) {
                      setAlert({ message: parsed.message })
                    }
                  } catch {
                    // malformed JSON from Claude — silent, no alert shown
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error(e)
          setError('Aktivitäten konnten nicht geladen werden.')
        } finally {
          setLoading(false)
        }
      })
  }, [navigate])

  async function handlePlanAnpassen() {
    if (!currentPlanJson || !alert || !athleteId || !planWeekStart) return
    setPlanModal({ loading: true, status: null })
    try {
      const systemPrompt = await buildCoachSystemPrompt(athleteId)
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Problem: ${alert.message}

Aktueller Wochenplan (JSON):
${JSON.stringify(currentPlanJson, null, 2)}

Passe die verbleibenden (noch nicht absolvierten) Tage dieser Woche an, um den Konflikt zu lösen. Bereits vergangene Tage unverändert übernehmen.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt im gleichen Format wie der Original-Plan — kein Text davor oder danach, kein Markdown:
{
  "summary": "Einzeiliger Wochen-Überblick (max 120 Zeichen)",
  "days": {
    "Mo": { "type": "Ruhetag|Radfahren|Laufen|Kraft", "duration_min": 0, "distance_km": null, "intensity": null, "description": "Kurze Beschreibung (oder 'Workout I/II/III' bei Kraft)" },
    "Di": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Mi": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Do": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Fr": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "Sa": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." },
    "So": { "type": "...", "duration_min": 0, "distance_km": null, "intensity": null, "description": "..." }
  }
}`,
          system: systemPrompt,
          max_tokens: 2048,
        }),
      })
      if (!res.ok) throw new Error('API Fehler')
      const { text } = await res.json() as { text: string }
      const adjustedPlan = parsePlanJson(text)

      const { data: existing } = await supabase
        .from('weekly_plans')
        .select('version')
        .eq('athlete_id', athleteId)
        .eq('week_start', planWeekStart)
        .order('version', { ascending: false })
        .limit(1)
      const nextVersion = (existing?.[0]?.version ?? 0) + 1

      const { data: inserted } = await supabase
        .from('weekly_plans')
        .insert({
          athlete_id:    athleteId,
          week_start:    planWeekStart,
          version:       nextVersion,
          plan_json:     adjustedPlan,
          change_reason: `Echtzeit-Alert: ${alert.message}`,
        })
        .select()
        .single()

      await supabase.from('coach_decisions').insert({
        athlete_id:       athleteId,
        decision_type:    'plan_adjusted',
        decision_summary: `Wochenplan v${nextVersion} nach Konflikt angepasst: ${alert.message}`,
        reasoning:        adjustedPlan.summary,
        related_plan_id:  (inserted as { id: string } | null)?.id ?? null,
      })

      setCurrentPlanJson(adjustedPlan)
      setAlertDismissed(true)
      setPlanModal({ loading: false, status: 'success' })
    } catch (e) {
      console.error(e)
      setPlanModal({ loading: false, status: 'error' })
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const features = useFeatures(athlete)
  const FILTER_BUTTONS: [string, JSX.Element][] = [
    ...(features.strength  ? [['WeightTraining', <IconStrength size={16} />] as [string, JSX.Element]] : []),
    ...(features.cycling   ? [['Ride',           <IconCycling  size={16} />] as [string, JSX.Element]] : []),
    ['Run', <IconRunning size={16} />],
  ]

  function handleLogout() {
    localStorage.clear(); sessionStorage.clear()
    document.cookie = 'pf_athlete_id=; max-age=0; path=/'
    navigate('/')
  }

  return (
    <>
      <AppHeader
        rightAction={
          <button
            onClick={handleLogout}
            className="p-2 text-slate-400 hover:text-white transition-colors"
            title="Abmelden"
          >
            <IconLogout size={18} />
          </button>
        }
      />
      <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">

      {/* ── Echtzeit-Alert Banner ──────────────────────────────── */}
      {alert && !alertDismissed && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-5 flex items-start gap-3">
          <IconWarning size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-200 mb-3">{alert.message}</p>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handlePlanAnpassen}
                className="text-xs bg-amber-500 hover:bg-amber-600 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
              >
                Plan anpassen
              </button>
              <button
                onClick={() => setAlertDismissed(true)}
                className="text-xs text-amber-400/70 hover:text-amber-300 px-2 py-1.5 transition-colors"
              >
                Verwerfen
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-slate-200">Letzte Aktivitäten</h2>
        <div className="flex gap-1.5">
          {FILTER_BUTTONS.map(([type, icon]) => (
            <button
              key={type}
              onClick={() => setFilter(f => f === type ? null : type)}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                filter === type
                  ? 'bg-brand-500/30 ring-1 ring-brand-500 text-brand-400'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
              }`}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-red-400 mb-4">{error}</p>}

      <ul className="flex flex-col gap-3">
        {activities.filter(a => !filter || a.type === filter || (filter === 'Ride' && a.type === 'VirtualRide') || (filter === 'Run' && a.type === 'VirtualRun')).map((act) => (
          <li key={act.id}>
            <Link
              to={`/activity/${act.id}`}
              className="block bg-slate-800 hover:bg-slate-700 rounded-xl p-4 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <ActivityIcon type={act.type} />
                <span className="font-semibold text-slate-100 truncate">{act.name}</span>
                <span className="ml-auto text-xs text-slate-400">
                  {new Date(act.start_date).toLocaleDateString('de-DE')}
                </span>
              </div>
              <div className="flex gap-4 text-sm text-slate-400 flex-wrap">
                {act.distance > 0 && <span>{formatDistance(act.distance)}</span>}
                <span>{formatDuration(act.moving_time)}</span>
                {act.average_heartrate && <span>Ø {Math.round(act.average_heartrate)} bpm</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* ── Plan-Anpassen Modal ────────────────────────────────── */}
      {planModal && (
        <div className="fixed inset-0 bg-black/60 flex items-end justify-center z-50 p-4 pb-6">
          <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-lg shadow-2xl">
            <h3 className="font-semibold text-slate-100 mb-4">Plan-Anpassung</h3>
            {planModal.loading ? (
              <div className="flex justify-center py-8">
                <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : planModal.status === 'success' ? (
              <div className="mb-5">
                <p className="text-sm text-emerald-300 font-medium mb-4">Plan aktualisiert ✓</p>
                <Link
                  to="/plan"
                  onClick={() => setPlanModal(null)}
                  className="block text-center bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2.5 rounded-xl transition-colors text-sm"
                >
                  Zum Wochenplan
                </Link>
              </div>
            ) : (
              <p className="text-sm text-red-300 leading-relaxed mb-5">
                Anpassung konnte nicht gespeichert werden. Bitte im Wochenplan manuell prüfen.
              </p>
            )}
            <button
              onClick={() => setPlanModal(null)}
              disabled={planModal.loading}
              className="w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 font-medium py-2.5 rounded-xl transition-colors text-sm"
            >
              Schließen
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  )
}
