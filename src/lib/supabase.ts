import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export type SportConfig = {
  type: string
  days: number
}

export type EquipmentConfig = {
  dumbbells: { active: boolean; max_kg?: number }
  bands: { active: boolean }
  bodyweight: { active: boolean }
  pullup_bar: { active: boolean }
  gym: { active: boolean }
}

export type AestheticGoals = {
  priorities: string[]
  notes: string
}

export type Athlete = {
  id: string
  strava_athlete_id: number
  strava_access_token: string
  strava_refresh_token: string
  expires_at: string | null
  created_at: string
  // Phase 2 profile fields
  name: string | null
  ftp_watts: number | null
  max_hr: number | null
  weight_kg: number | null
  training_days_per_week: number | null
  sport_types: SportConfig[] | null
  coach_persona: Record<string, unknown> | null
  body_goal: string | null
  body_goals: string[] | null
  // Phase 3 coach system fields
  equipment: EquipmentConfig | null
  aesthetic_goals: AestheticGoals | null
  // Phase 4 dynamic prompt fields
  season_phase_override: 'readaptation' | 'base' | 'race' | 'taper' | null
  best_5k_seconds: number | null
}

export type SeasonGoal = {
  id: string
  athlete_id: string
  event_name: string
  event_date: string
  distance_km: number | null
  elevation_m: number | null
  priority: 'A' | 'B' | 'C'
  sport_type: string | null
  notes: string | null
  active: boolean
  created_at: string
}

export type WeeklyPlan = {
  id: string
  athlete_id: string
  week_start: string
  version: number
  plan_json: Record<string, unknown>
  review_notes: string | null
  change_reason: string | null
  plan_constraint_violation: boolean | null
  created_at: string
}

export type CoachDecision = {
  id: string
  athlete_id: string
  decision_type: string
  decision_summary: string
  reasoning: string | null
  related_plan_id: string | null
  related_activity_id: string | null
  created_at: string
}

export type ChatMessage = {
  id: string
  thread_id: string
  athlete_id: string
  role: 'user' | 'assistant'
  content: string
  chat_type: string
  activity_id: string | null
  created_at: string
}

export type Activity = {
  id: string
  athlete_id: string
  strava_id: number
  name: string
  type: string
  date: string
  distance_m: number | null
  duration_s: number | null
  avg_hr: number | null
  max_hr: number | null
  np_watts: number | null
  tss: number | null
  streams_json: Record<string, unknown> | null
  description: string | null
  claude_analysis: string | null
  created_at: string
}
