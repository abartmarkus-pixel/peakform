import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type SeasonGoal, type Activity } from '../lib/supabase'
import { AppHeader } from '../components/AppHeader'
import { IconChevronLeft } from '../lib/icons'
import {
  calculateSeasonPhase,
  estimateGoalFinishTime,
  estimateGoalFinishTimeFromEfficiency,
  resolveHRProfile,
  type GoalFinishEstimate,
} from '../lib/coachContext'
import { formatRaceTime } from '../lib/dateUtils'

const PHASE_STEPS: { key: string; label: string }[] = [
  { key: 'readaptation', label: 'Readaptation' },
  { key: 'base',         label: 'Grundlage' },
  { key: 'race',         label: 'Wettkampf-\nvorbereitung' },
  { key: 'taper',        label: 'Taper' },
]

function formatPace(secPerKm: number): string {
  const s = Math.round(secPerKm)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const CONFIDENCE_LABEL: Record<GoalFinishEstimate['confidence'], string> = {
  hoch: 'Hohe Verlässlichkeit',
  mittel: 'Mittlere Verlässlichkeit',
  niedrig: 'Grobe Schätzung',
}

export default function GoalDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [goal, setGoal] = useState<SeasonGoal | null>(null)
  const [estimate, setEstimate] = useState<GoalFinishEstimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }
    if (!id) { navigate('/goals'); return }

    ;(async () => {
      const { data: athleteData } = await supabase
        .from('athletes')
        .select('*')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
      if (!athleteData) { setLoading(false); return }
      const a = athleteData as Athlete
      setAthlete(a)

      const { data: goalData } = await supabase
        .from('season_goals')
        .select('*')
        .eq('id', id)
        .eq('athlete_id', a.id)
        .maybeSingle()
      if (!goalData) { setNotFound(true); setLoading(false); return }
      const g = goalData as SeasonGoal
      setGoal(g)

      if (g.sport_type === 'Laufen' && g.distance_km) {
        const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
        const { data: runs } = await supabase
          .from('activities')
          .select('id, date, distance_m, duration_s, avg_hr')
          .eq('athlete_id', a.id)
          .in('type', ['Run', 'VirtualRun', 'TrailRun'])
          .gte('date', sixMonthsAgo)
          .order('date', { ascending: false })
        const runningActivities = (runs ?? []) as Activity[]

        const { effectiveMaxHR, restingHR } = resolveHRProfile(a)
        const efficiencyEstimate = estimateGoalFinishTimeFromEfficiency(
          g.distance_km, effectiveMaxHR, restingHR, a.max_hr != null, runningActivities,
        )
        setEstimate(efficiencyEstimate ?? estimateGoalFinishTime(g.distance_km, a.strava_prs, runningActivities))
      }

      setLoading(false)
    })()
  }, [id, navigate])

  if (loading) {
    return (
      <>
        <AppHeader />
        <div className="min-h-screen flex items-center justify-center text-slate-500">Lädt…</div>
      </>
    )
  }

  if (notFound || !goal) {
    return (
      <>
        <AppHeader />
        <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">
          <p className="text-slate-400">Ziel nicht gefunden.</p>
          <button onClick={() => navigate('/goals')} className="text-brand-500 hover:text-brand-400 text-sm mt-2">
            Zurück zu den Zielen
          </button>
        </div>
      </>
    )
  }

  const weeksUntilEvent = Math.round((new Date(goal.event_date).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000))
  const phase = calculateSeasonPhase(weeksUntilEvent, athlete?.season_phase_override ?? null)
  const totalDays = Math.ceil((new Date(goal.event_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000))

  return (
    <>
      <AppHeader />
      <div className="min-h-screen p-4 max-w-2xl mx-auto page-content">
        <button
          onClick={() => navigate('/goals')}
          className="inline-flex items-center gap-1 text-brand-500 hover:text-brand-400 text-sm mb-4"
        >
          <IconChevronLeft size={14} /> Zurück
        </button>

        <h1 className="text-xl font-bold text-slate-100 mb-1">{goal.event_name}</h1>
        <p className="text-slate-400 text-sm mb-6">
          {new Date(goal.event_date).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          {totalDays > 0 ? ` · noch ${totalDays} ${totalDays === 1 ? 'Tag' : 'Tage'}` : ' · vergangen'}
          {goal.distance_km ? ` · ${goal.distance_km} km` : ''}
        </p>

        {/* Phasen-Grafik */}
        <div className="bg-slate-800 rounded-2xl p-5 mb-4">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">Wo du im Trainingsplan stehst</p>

          <div className="flex gap-1.5 mb-4">
            {PHASE_STEPS.map(step => {
              const isCurrent = step.key === phase.phase
              return (
                <div
                  key={step.key}
                  className={`flex-1 h-2 rounded-full ${isCurrent ? 'bg-brand-500' : 'bg-slate-700'}`}
                />
              )
            })}
          </div>
          <div className="flex gap-1.5 mb-4">
            {PHASE_STEPS.map(step => {
              const isCurrent = step.key === phase.phase
              return (
                <div
                  key={step.key}
                  className={`flex-1 text-center text-[10px] leading-tight whitespace-pre-line ${isCurrent ? 'text-brand-400 font-semibold' : 'text-slate-600'}`}
                >
                  {step.label}
                </div>
              )
            })}
          </div>

          <p className="text-slate-100 font-semibold">{phase.label}</p>
          <p className="text-slate-400 text-sm mt-0.5">{phase.description}</p>
        </div>

        {/* Zeitschätzung */}
        {goal.sport_type === 'Laufen' && goal.distance_km && (
          <div className="bg-slate-800 rounded-2xl p-5">
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">Geschätzte Zielzeit</p>

            {estimate ? (
              <>
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-bold text-slate-100">{formatRaceTime(estimate.estimatedSeconds)}</p>
                  <p className="text-sm text-slate-400">{formatPace(estimate.estimatedSeconds / goal.distance_km)} /km</p>
                </div>
                <p className="text-sm text-slate-400 mt-1">{CONFIDENCE_LABEL[estimate.confidence]}</p>
                <p className="text-xs text-slate-500 mt-3">{estimate.basisText}</p>
                <p className="text-xs text-slate-600 mt-2">
                  Diese Schätzung basiert ausschließlich auf deinen bisherigen Trainingsdaten — nichts davon ist geraten.
                </p>
              </>
            ) : (
              <p className="text-slate-400 text-sm">
                Noch nicht genug Trainingsdaten für eine verlässliche Schätzung. Sobald du ein paar Läufe in Richtung dieser Distanz absolviert hast, erscheint hier eine Zeit.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  )
}
