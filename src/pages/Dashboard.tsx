import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

import { fetchRecentActivities, getValidAccessToken, type StravaActivity } from '../lib/strava'
import { supabase, type Athlete } from '../lib/supabase'

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

function activityIcon(type: string) {
  const icons: Record<string, string> = {
    Run: '🏃',
    Ride: '🚴',
    Swim: '🏊',
    Walk: '🚶',
    Hike: '🥾',
    WeightTraining: '🏋️',
  }
  return icons[type] ?? '🏅'
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [activities, setActivities] = useState<StravaActivity[]>([])
  const [filter, setFilter] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

        try {
          const token = await getValidAccessToken(athlete)
          const acts = await fetchRecentActivities(token)
          setActivities(acts)

          // upsert into Supabase
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
        } catch (e) {
          console.error(e)
          setError('Aktivitäten konnten nicht geladen werden.')
        } finally {
          setLoading(false)
        }
      })
  }, [navigate])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-brand-500">PeakForm</h1>
        <button
          onClick={() => { localStorage.clear(); navigate('/') }}
          className="text-slate-500 hover:text-slate-300 transition-colors"
          title="Abmelden"
        >
          <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-6">
        {([
          ['/chat',    '💬', 'Coach'],
          ['/plan',    '📅', 'Plan'],
          ['/goals',   '🎯', 'Ziele'],
          ['/profile', '👤', 'Profil'],
        ] as [string, string, string][]).map(([to, icon, label]) => (
          <Link
            key={to}
            to={to}
            className="flex flex-col items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-xl py-4 transition-colors aspect-square"
          >
            <span className="text-4xl">{icon}</span>
            <span className="text-sm font-medium text-slate-300">{label}</span>
          </Link>
        ))}
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-slate-200">Letzte Aktivitäten</h2>
        <div className="flex gap-1.5">
          {([['WeightTraining', '🏋️'], ['Ride', '🚴'], ['Run', '🏃']] as [string, string][]).map(([type, emoji]) => (
            <button
              key={type}
              onClick={() => setFilter(f => f === type ? null : type)}
              className={`text-base w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                filter === type
                  ? 'bg-brand-500/30 ring-1 ring-brand-500'
                  : 'bg-slate-800 hover:bg-slate-700'
              }`}
            >
              {emoji}
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
                <span className="text-xl">{activityIcon(act.type)}</span>
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
    </div>
  )
}
