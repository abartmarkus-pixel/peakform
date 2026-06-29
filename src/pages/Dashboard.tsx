import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

import { fetchRecentActivities, getValidAccessToken, type StravaActivity } from '../lib/strava'
import { supabase, type Athlete } from '../lib/supabase'
import { buildCoachSystemPrompt } from '../lib/coachPrompt'
import {
  IconLogout, IconRunning, IconCycling, IconStrength, IconWarning,
} from '../lib/icons'
import { SPORT_DISPLAY } from '../lib/icons'

// ── helpers ────────────────────────────────────────────────────────────────

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
    return <IconRunning size={18} color={SPORT_DISPLAY.running.color} />
  if (type === 'Ride' || type === 'VirtualRide' || type === 'MountainBikeRide' || type === 'GravelRide')
    return <IconCycling size={18} color={SPORT_DISPLAY.cycling.color} />
  if (type === 'WeightTraining' || type === 'Workout')
    return <IconStrength size={18} color={SPORT_DISPLAY.strength.color} />
  return <IconRunning size={18} className="text-slate-400" />
}

// ── component ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const [activities,       setActivities]       = useState<StravaActivity[]>([])
  const [filter,           setFilter]           = useState<string | null>(null)
  const [loading,          setLoading]          = useState(true)
  const [error,            setError]            = useState<string | null>(null)

  const [athleteId,        setAthleteId]        = useState<string | null>(null)

  // alert state
  const [alert,            setAlert]            = useState<{ message: string } | null>(null)
  const [alertDismissed,   setAlertDismissed]   = useState(false)
  const [planModal,        setPlanModal]        = useState<{ loading: boolean; content: string | null } | null>(null)
  const [currentPlanJson,  setCurrentPlanJson]  = useState<Record<string, unknown> | null>(null)

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
        const athlete = data as Athlete
        setAthleteId(athlete.id)

        try {
          const token = await getValidAccessToken(athlete)
          const acts = await fetchRecentActivities(token)
          setActivities(acts)

          await supabase.from('activities').upsert(
            acts.map((a) => ({
              athlete_id: athlete.id,
              strava_id: a.id,
              name: a.name,
              type: a.type,
              date: a.start_date,
              distance_m: a.distance ?? null,
              duration_s: a.moving_time ?? null,
              avg_hr: a.average_heartrate ?? null,
              max_hr: a.max_heartrate ?? null,
              np_watts: a.weighted_average_watts ?? null,
            })),
            { onConflict: 'strava_id' },
          )

          // ── Echtzeit-Alert: einmal pro Session prüfen ──────────────────
          const thisWeek = mondayOf(new Date())
          const alertKey = `peakform_alert_${thisWeek}`

          if (!sessionStorage.getItem(alertKey)) {
            sessionStorage.setItem(alertKey, 'checked') // mark before async to prevent double-fire

            const [{ data: planRows }, { data: recentActs }, systemPrompt] = await Promise.all([
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
              buildCoachSystemPrompt(athlete.id),
            ])

            const plan = planRows?.[0]
            const latestAct = recentActs?.[0]

            if (plan && latestAct) {
              setCurrentPlanJson(plan.plan_json as Record<string, unknown>)

              const checkPrompt = `Du bist der PeakForm Coach. Prüfe ob folgende Aktivität den geplanten Wochenplan verletzt.

Wochenplan (JSON):
${JSON.stringify(plan.plan_json, null, 2)}

Neueste Aktivität diese Woche:
- Name: ${latestAct.name}
- Typ: ${latestAct.type}
- Datum: ${new Date(latestAct.date).toLocaleDateString('de-DE')}
- Dauer: ${latestAct.duration_s ? Math.round(latestAct.duration_s / 60) : '?'} min
- Ø HF: ${latestAct.avg_hr ? Math.round(latestAct.avg_hr) : 'k.A.'} bpm
${latestAct.np_watts ? `- NP: ${Math.round(latestAct.np_watts)} W` : ''}

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
    if (!currentPlanJson || !alert || !athleteId) return
    setPlanModal({ loading: true, content: null })
    try {
      const systemPrompt = await buildCoachSystemPrompt(athleteId)
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Problem: ${alert.message}\n\nAktueller Wochenplan:\n${JSON.stringify(currentPlanJson, null, 2)}\n\nSchlage konkrete Anpassungen für die verbleibenden Tage dieser Woche vor. Kurz und umsetzbar, max 150 Wörter.`,
          system: systemPrompt,
          max_tokens: 600,
        }),
      })
      if (!res.ok) throw new Error('API Fehler')
      const { text } = await res.json() as { text: string }
      setPlanModal({ loading: false, content: text })
    } catch {
      setPlanModal({ loading: false, content: 'Empfehlung konnte nicht geladen werden.' })
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const FILTER_BUTTONS: [string, JSX.Element][] = [
    ['WeightTraining', <IconStrength size={16} />],
    ['Ride',          <IconCycling  size={16} />],
    ['Run',           <IconRunning  size={16} />],
  ]

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-brand-500">PeakForm</h1>
        <button
          onClick={() => { localStorage.clear(); sessionStorage.clear(); navigate('/') }}
          className="text-slate-500 hover:text-slate-300 transition-colors"
          title="Abmelden"
        >
          <IconLogout size={22} />
        </button>
      </div>

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
            ) : (
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap mb-5">
                {planModal.content}
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
  )
}
