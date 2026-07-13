import { useEffect, useState } from 'react'
import type { IconType } from 'react-icons'
import {
  IconHome, IconPlan, IconChat, IconGoals, IconProfile,
} from './icons'
import { supabase, type Athlete } from './supabase'
import { useFeatures, DEFAULT_FEATURES, type FeatureFlags } from './features'

export interface TabDef {
  path: string
  Icon: IconType
  label: string
  featureKey: keyof FeatureFlags | null
}

const ALL_TABS: TabDef[] = [
  { path: '/dashboard', Icon: IconHome,    label: 'Home',   featureKey: null          },
  { path: '/plan',      Icon: IconPlan,    label: 'Plan',   featureKey: 'weekly_plan' },
  { path: '/chat',      Icon: IconChat,    label: 'Coach',  featureKey: 'coach_chat'  },
  { path: '/goals',     Icon: IconGoals,   label: 'Ziele',  featureKey: 'goals'       },
  { path: '/profile',   Icon: IconProfile, label: 'Profil', featureKey: null          },
]

// Einzige Quelle der Wahrheit für Tab-Reihenfolge + Sichtbarkeit — genutzt von
// BottomNav (Rendering) und useTabSwipeNavigation (Swipe-Ziel-Berechnung), damit
// beide bei unterschiedlichen Feature-Flags zwischen Athleten synchron bleiben.
export function useVisibleTabs(): TabDef[] {
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

  return ALL_TABS.filter(t => t.featureKey === null || features[t.featureKey])
}
