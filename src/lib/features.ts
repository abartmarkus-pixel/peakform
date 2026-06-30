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
