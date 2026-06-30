import type { Athlete } from './supabase'
import { supabase } from './supabase'

const CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID as string
const REDIRECT_URI = import.meta.env.VITE_STRAVA_REDIRECT_URI as string

export const STRAVA_AUTH_URL =
  `https://www.strava.com/oauth/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=read,activity:read_all`

export type StravaActivity = {
  id: number
  name: string
  type: string
  start_date: string
  distance: number
  moving_time: number
  average_heartrate?: number
  max_heartrate?: number
  weighted_average_watts?: number
}

export type StravaTokenResponse = {
  access_token: string
  refresh_token: string
  expires_at: number
  athlete: { id: number }
}

export async function exchangeCodeForToken(code: string): Promise<StravaTokenResponse> {
  const res = await fetch('/api/strava-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  })
  if (!res.ok) throw new Error('Token exchange failed')
  return res.json()
}

export async function fetchRecentActivities(accessToken: string): Promise<StravaActivity[]> {
  const res = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=10',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error('Failed to fetch activities')
  return res.json()
}

export type StravaLap = {
  lap_index: number
  name: string
  elapsed_time: number
  distance: number
  average_speed: number
  average_heartrate?: number
  max_heartrate?: number
  average_watts?: number
  average_cadence?: number
}

export async function fetchActivityLaps(
  accessToken: string,
  activityId: number,
): Promise<StravaLap[]> {
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/laps`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error('Failed to fetch laps')
  return res.json()
}

export async function fetchActivityDetail(
  accessToken: string,
  activityId: number,
): Promise<{ description?: string }> {
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error('Failed to fetch activity detail')
  return res.json()
}

export async function fetchActivityStreams(
  accessToken: string,
  activityId: number,
): Promise<Record<string, unknown>> {
  const keys = 'time,heartrate,altitude,velocity_smooth,watts,cadence'
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=${keys}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error('Failed to fetch streams')
  return res.json()
}

type RefreshResult = {
  access_token: string
  refresh_token: string
  expires_at: number
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const res = await fetch('/api/strava-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  if (!res.ok) throw new Error('Token refresh failed')
  return res.json()
}

// Attempts to restore the session from Supabase when localStorage is empty.
// Single-user app — queries the one athlete row, refreshes token if needed.
export async function restoreSessionFromSupabase(): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('athletes')
      .select('id, strava_athlete_id, strava_access_token, strava_refresh_token, expires_at')
      .limit(1)
      .single()

    if (!data?.strava_refresh_token) return false

    await getValidAccessToken(data as unknown as Athlete)

    const stravaId = String(data.strava_athlete_id)
    localStorage.setItem('athlete_strava_id', stravaId)
    sessionStorage.setItem('athlete_strava_id', stravaId)
    // Set RLS context after successful session restore
    void supabase.rpc('set_athlete_context', { athlete_id: stravaId })
    return true
  } catch {
    return false
  }
}

export async function syncActivitiesToSupabase(
  activities: StravaActivity[],
  athleteId: string,
): Promise<void> {
  await supabase.from('activities').upsert(
    activities.map(a => ({
      athlete_id: athleteId,
      strava_id:  a.id,
      name:       a.name,
      type:       a.type,
      date:       a.start_date,
      distance_m: a.distance ?? null,
      duration_s: a.moving_time ?? null,
      avg_hr:     a.average_heartrate ?? null,
      max_hr:     a.max_heartrate ?? null,
      np_watts:   a.weighted_average_watts ?? null,
    })),
    { onConflict: 'strava_id' },
  )
}

// Returns a valid access token, refreshing automatically if expired (with 60s buffer).
// Also sets the athlete context for RLS policies.
export async function getValidAccessToken(athlete: Athlete): Promise<string> {
  // Set RLS context for this session (best-effort; effective in session-mode pooling)
  void supabase.rpc('set_athlete_context', { athlete_id: String(athlete.strava_athlete_id) })

  const expiresAt = athlete.expires_at ? new Date(athlete.expires_at).getTime() : 0
  const isExpired = Date.now() >= expiresAt - 60_000

  if (!isExpired) return athlete.strava_access_token

  const refreshed = await refreshAccessToken(athlete.strava_refresh_token)
  await supabase
    .from('athletes')
    .update({
      strava_access_token: refreshed.access_token,
      strava_refresh_token: refreshed.refresh_token,
      expires_at: new Date(refreshed.expires_at * 1000).toISOString(),
    })
    .eq('strava_athlete_id', athlete.strava_athlete_id)

  return refreshed.access_token
}
