import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type SeasonGoal, type Activity } from '../lib/supabase'
import { AppHeader } from '../components/AppHeader'
import { IconChevronLeft, IconStar } from '../lib/icons'
import {
  calculateSeasonPhase,
  calculatePhaseProgressNarrative,
  estimateGoalFinishTime,
  estimateGoalFinishTimeFromEfficiency,
  resolveHRProfile,
  type GoalFinishEstimate,
  type PhaseProgressNarrative,
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

const METHOD_EXPLANATION: Record<GoalFinishEstimate['method'], { text: string; sources: string[] }> = {
  efficiency: {
    text: 'Wir schauen uns an, wie schnell du bei welchem Puls in deinen normalen Trainingsläufen unterwegs warst. Je niedriger dein Puls bei gleichem Tempo, desto fitter bist du gerade — daraus leiten wir ab, welche Zeit für die Zieldistanz realistisch ist.',
    sources: [
      'Daniels & Gilbert (1979): "Oxygen Power" – Leistungstabellen für Läufer',
      'American College of Sports Medicine (ACSM): Formel für den Sauerstoffverbrauch beim Laufen',
    ],
  },
  distance_anchor: {
    text: 'Wir nehmen deine bisher schnellste vergleichbare Strecke (aus Strava oder einem Trainingslauf) und rechnen sie mit einer bewährten mathematischen Formel auf deine Zieldistanz um.',
    sources: [
      'Riegel, P. S. (1977): "Athletic Records and Human Endurance", American Scientist',
    ],
  },
}

export default function GoalDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [goal, setGoal] = useState<SeasonGoal | null>(null)
  const [estimate, setEstimate] = useState<GoalFinishEstimate | null>(null)
  const [narrative, setNarrative] = useState<PhaseProgressNarrative | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showMethodInfo, setShowMethodInfo] = useState(false)

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

      if (g.sport_type === 'Laufen') {
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

        if (g.distance_km) {
          const efficiencyEstimate = estimateGoalFinishTimeFromEfficiency(
            g.distance_km, effectiveMaxHR, restingHR, a.max_hr != null, runningActivities,
          )
          setEstimate(efficiencyEstimate ?? estimateGoalFinishTime(g.distance_km, a.strava_prs, runningActivities))
        }

        const weeksUntilEventNow = Math.round((new Date(g.event_date).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000))
        const phaseNow = calculateSeasonPhase(weeksUntilEventNow, a.season_phase_override ?? null)
        setNarrative(calculatePhaseProgressNarrative(phaseNow.phase, runningActivities, effectiveMaxHR, restingHR))
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
  const currentPhaseIndex = PHASE_STEPS.findIndex(step => step.key === phase.phase)

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
            {PHASE_STEPS.map((step, index) => {
              if (index < currentPhaseIndex) {
                return (
                  <div key={step.key} className="flex-1 h-2 rounded-full bg-brand-500 relative">
                    <IconStar
                      size={16}
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-yellow-400"
                    />
                  </div>
                )
              }
              if (index > currentPhaseIndex) {
                return <div key={step.key} className="flex-1 h-2 rounded-full bg-slate-700" />
              }
              return (
                <div key={step.key} className="flex-1 h-2 rounded-full bg-slate-700 relative overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-brand-500 rounded-full"
                    style={{ width: `${phase.progressPct ?? 100}%` }}
                  />
                </div>
              )
            })}
          </div>
          <div className="flex gap-1.5 mb-4">
            {PHASE_STEPS.map((step, index) => {
              const isCurrent = step.key === phase.phase
              const isCompleted = index < currentPhaseIndex
              return (
                <div
                  key={step.key}
                  className={`flex-1 text-center text-[10px] leading-tight whitespace-pre-line ${
                    isCurrent ? 'text-brand-400 font-semibold' : isCompleted ? 'text-yellow-400' : 'text-slate-600'
                  }`}
                >
                  {step.label}
                </div>
              )
            })}
          </div>

          <p className="text-slate-100 font-semibold">{phase.label}</p>
          <p className="text-slate-400 text-sm mt-0.5">{phase.description}</p>
          {narrative ? (
            <p className="text-xs text-slate-500 mt-2">{narrative.text}</p>
          ) : phase.progressPct != null ? (
            <p className="text-xs text-slate-500 mt-2">{Math.round(phase.progressPct)}% dieser Phase geschafft</p>
          ) : null}
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
                <button
                  onClick={() => setShowMethodInfo(true)}
                  className="text-xs text-slate-500 mt-3 underline decoration-dotted underline-offset-2 hover:text-slate-300 text-left"
                >
                  {estimate.basisText}
                </button>
              </>
            ) : (
              <p className="text-slate-400 text-sm">
                Noch nicht genug Trainingsdaten für eine verlässliche Schätzung. Sobald du ein paar Läufe in Richtung dieser Distanz absolviert hast, erscheint hier eine Zeit.
              </p>
            )}
          </div>
        )}

        {showMethodInfo && estimate && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4"
            onClick={() => setShowMethodInfo(false)}
          >
            <div
              className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full"
              onClick={e => e.stopPropagation()}
            >
              <p className="text-slate-100 font-semibold mb-2">Wie wird das berechnet?</p>
              <p className="text-sm text-slate-300">{METHOD_EXPLANATION[estimate.method].text}</p>
              <p className="text-xs text-slate-500 uppercase tracking-wider mt-4 mb-1">Quellen</p>
              <ul className="text-xs text-slate-500 space-y-1">
                {METHOD_EXPLANATION[estimate.method].sources.map(source => (
                  <li key={source}>{source}</li>
                ))}
              </ul>
              <button
                onClick={() => setShowMethodInfo(false)}
                className="mt-5 w-full text-center text-sm text-brand-500 hover:text-brand-400 py-2"
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
