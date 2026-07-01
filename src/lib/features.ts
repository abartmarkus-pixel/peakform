import type { Athlete } from './supabase'

export interface FeatureFlags {
  cycling: boolean
  running: boolean
  strength: boolean
  body_checkin: boolean
  weekly_plan: boolean
  coach_chat: boolean
  goals: boolean
}

export const DEFAULT_FEATURES: FeatureFlags = {
  cycling: true,
  running: true,
  strength: true,
  body_checkin: true,
  weekly_plan: true,
  coach_chat: true,
  goals: true,
}

export function useFeatures(athlete: Athlete | null): FeatureFlags {
  if (!athlete?.features) return DEFAULT_FEATURES
  return { ...DEFAULT_FEATURES, ...(athlete.features as Partial<FeatureFlags>) }
}

/** Body-Check-in ist sichtbar wenn Feature-Flag aktiv, Krafttraining gewählt und ein Ästhetik-Körperziel gesetzt ist. */
export function canBodyCheckin(athlete: Athlete | null): boolean {
  if (!athlete) return false
  if (!useFeatures(athlete).body_checkin) return false
  const hasStrength = (athlete.sport_types ?? []).some(s => s.type === 'strength')
  if (!hasStrength) return false
  const bodyGoals = athlete.body_goals ?? []
  return bodyGoals.includes('Muskelaufbau') || bodyGoals.includes('Gewicht reduzieren')
}
