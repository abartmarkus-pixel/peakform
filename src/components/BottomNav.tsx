import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconHome, IconPlan, IconChat, IconGoals, IconProfile,
} from '../lib/icons'
import { supabase, type Athlete } from '../lib/supabase'
import { useFeatures, DEFAULT_FEATURES, type FeatureFlags } from '../lib/features'

const ALL_TABS = [
  { path: '/dashboard', Icon: IconHome,    label: 'Home',   featureKey: null            },
  { path: '/plan',      Icon: IconPlan,    label: 'Plan',   featureKey: 'weekly_plan'   },
  { path: '/chat',      Icon: IconChat,    label: 'Coach',  featureKey: 'coach_chat'    },
  { path: '/goals',     Icon: IconGoals,   label: 'Ziele',  featureKey: 'goals'         },
  { path: '/profile',   Icon: IconProfile, label: 'Profil', featureKey: null            },
] as const

export default function BottomNav() {
  const { pathname } = useLocation()
  const navigate     = useNavigate()
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES)

  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id')
    if (!stravaId) return
    supabase
      .from('athletes')
      .select('features')
      .eq('strava_athlete_id', Number(stravaId))
      .single()
      .then(({ data }) => {
        if (data) setFeatures(useFeatures(data as unknown as Athlete))
      })
  }, [])

  const tabs = ALL_TABS.filter(t =>
    t.featureKey === null || features[t.featureKey as keyof FeatureFlags]
  )

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900 border-t border-slate-800"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex max-w-2xl mx-auto">
        {tabs.map(({ path, Icon, label }) => {
          const active = pathname.startsWith(path)
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={`flex flex-col items-center justify-center gap-1 flex-1 py-2.5 min-h-[48px] active:opacity-70 transition-opacity ${
                active ? 'text-brand-500' : 'text-slate-400'
              }`}
            >
              <Icon size={20} />
              <span className="text-[10px] uppercase tracking-wide font-medium leading-none">
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
