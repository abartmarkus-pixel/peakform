import type { Athlete, Activity } from './supabase'
import { supabase } from './supabase'
import { analyzeActivity, claimActivityForAnalysis } from './activityAnalysis'
import { STANDARD_DISTANCES_KM } from './coachContext'

const CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID as string
const REDIRECT_URI = import.meta.env.VITE_STRAVA_REDIRECT_URI as string

// Generates a fresh CSRF state token for the OAuth flow, persists it in
// sessionStorage so AuthCallback can verify it, and returns it for the auth URL.
export function generateOAuthState(): string {
  const state = crypto.randomUUID()
  sessionStorage.setItem('oauth_state', state)
  return state
}

export function getStravaAuthUrl(state: string): string {
  return (
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=read,activity:read_all` +
    `&state=${state}`
  )
}

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
  average_watts?: number
  total_elevation_gain?: number
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

export async function fetchRecentActivities(
  accessToken: string,
  page: number = 1,
  perPage: number = 10,
): Promise<StravaActivity[]> {
  const res = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}&page=${page}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error('Failed to fetch activities')
  return res.json()
}

export type StravaSplitMetric = {
  split: number
  distance: number
  moving_time: number
  elapsed_time: number
  average_speed: number
  average_heartrate?: number
  pace_zone?: number
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

// Strava berechnet best_efforts (Bestzeiten über Standarddistanzen wie "5k", "10k")
// automatisch aus den GPS/Zeit-Daten jeder Laufaktivität. pr_rank ist nur bei den
// aktuellen Top-3-Leistungen des Athleten über diese Distanz gesetzt (1 = aktuelle
// Bestzeit), sonst null/fehlend.
export type StravaBestEffort = {
  name: string
  distance: number
  moving_time: number
  pr_rank: number | null
}

export async function fetchActivityDetail(
  accessToken: string,
  activityId: number,
): Promise<{ description?: string; splits_metric?: StravaSplitMetric[]; best_efforts?: StravaBestEffort[] }> {
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error('Failed to fetch activity detail')
  return res.json()
}

// pr_rank === 1 bei einer Standarddistanz (siehe STANDARD_DISTANCES_KM in
// coachContext.ts, z.B. "5k", "10k", "half-marathon") bedeutet: DIESE Aktivität hält
// aktuell (Stand des frischen API-Calls) athletenweit die Bestzeit über diese Distanz
// auf Strava — direkt aus GPS/Zeit-Daten ermittelt, nicht aus einem beliebig langen
// Lauf hochgerechnet wie estimateBest5kFromActivities()/estimateGoalFinishTime() in
// coachContext.ts. Sammelt ALLE gefundenen Distanzen einer Aktivität in einem Schritt
// in athletes.strava_prs (JSON-Map name→{seconds,at}), read-modify-write, damit
// bestehende Einträge für andere Distanzen erhalten bleiben. Läuft nur beim
// erstmaligen Detail-Fetch einer Aktivität (cache-first via splits_metric_json, siehe
// activityAnalysis.ts / ActivityDetail.tsx) — ältere Aktivitäten, deren Splits schon
// vor diesem Feature gecacht wurden, werden dadurch NICHT automatisch erfasst; dafür
// gibt es backfillStravaPrs() weiter unten.
export async function saveStravaPrsIfPresent(
  athleteId: string,
  bestEfforts: StravaBestEffort[] | undefined,
  activityDate: string,
): Promise<void> {
  const prs = (bestEfforts ?? []).filter(e => e.pr_rank === 1 && STANDARD_DISTANCES_KM[e.name.toLowerCase()] != null)
  if (prs.length === 0) return

  const { data: athleteRow } = await supabase.from('athletes').select('strava_prs').eq('id', athleteId).single()
  const existing = (athleteRow?.strava_prs ?? {}) as Record<string, { seconds: number; at: string }>
  const updated = { ...existing }
  for (const pr of prs) {
    updated[pr.name.toLowerCase()] = { seconds: pr.moving_time, at: activityDate }
  }
  await supabase.from('athletes').update({ strava_prs: updated }).eq('id', athleteId)
}

const BACKFILL_RUN_LIMIT = 20

// Einmaliger Nachhol-Check für Aktivitäten, deren splits_metric_json schon vor
// saveStravaPrsIfPresent() gecacht wurde (siehe Kommentar oben) — für die läuft
// fetchActivityDetail() im Normalbetrieb nie mehr, aktuelle Strava-Rekorde blieben
// also dauerhaft unentdeckt, bis zufällig ein neuer PR gelaufen wird. Holt deshalb für
// die letzten BACKFILL_RUN_LIMIT Läufe einmalig gezielt best_efforts nach —
// unabhängig vom splits_metric_json-Cache, ohne diesen zu verändern.
// Gate über athletes.strava_prs_backfill_done (analog recovery_checked/
// stimulus_checked auf Aktivitätsebene, hier aber athletenweit statt pro Aktivität,
// da es sich um einen einmaligen Vorgang und nicht ein Pro-Aktivität-Flag handelt).
// Wird das Flag NICHT gesetzt (z. B. weil getValidAccessToken() wegen eines
// abgelaufenen Refresh-Tokens wirft), bleibt der Backfill offen und der nächste
// App-Start versucht es erneut — silent failure analog zu syncPushSubscription().
export async function backfillStravaPrs(athleteId: string): Promise<void> {
  const { data: athleteRow } = await supabase
    .from('athletes')
    .select('*')
    .eq('id', athleteId)
    .single()
  if (!athleteRow) return
  const athlete = athleteRow as Athlete
  if (athlete.strava_prs_backfill_done) return

  try {
    const token = await getValidAccessToken(athlete)

    const { data: runs } = await supabase
      .from('activities')
      .select('strava_id, date')
      .eq('athlete_id', athleteId)
      .in('type', ['Run', 'VirtualRun', 'TrailRun'])
      .order('date', { ascending: false })
      .limit(BACKFILL_RUN_LIMIT)

    // Details parallel abrufen (reiner Lesezugriff, unproblematisch), aber in EINEM
    // Schreibzugriff am Ende zusammenführen — sonst würden bei bis zu
    // BACKFILL_RUN_LIMIT gleichzeitigen read-modify-write-Aufrufen auf dieselbe Zeile
    // (wie in saveStravaPrsIfPresent()) einzelne gefundene Distanzen sich gegenseitig
    // überschreiben.
    const details = await Promise.all(
      (runs ?? []).map(r =>
        fetchActivityDetail(token, r.strava_id)
          .then(d => ({ date: r.date, bestEfforts: d.best_efforts }))
          .catch(() => null),
      ),
    )

    const merged: Record<string, { seconds: number; at: string }> = { ...(athlete.strava_prs ?? {}) }
    for (const d of details) {
      if (!d) continue
      for (const e of d.bestEfforts ?? []) {
        const km = STANDARD_DISTANCES_KM[e.name.toLowerCase()]
        if (km && e.pr_rank === 1) merged[e.name.toLowerCase()] = { seconds: e.moving_time, at: d.date }
      }
    }

    await supabase.from('athletes').update({ strava_prs: merged, strava_prs_backfill_done: true }).eq('id', athleteId)
  } catch {
    // stiller Fehlschlag (z. B. Token-Refresh) — nächster App-Start versucht es erneut
  }
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
// Identifies the athlete via the persistent pf_athlete_id cookie (not LIMIT 1),
// so each browser restores its own account once multiple athletes exist.
export async function restoreSessionFromSupabase(): Promise<boolean> {
  try {
    const cookieMatch = document.cookie.match(/pf_athlete_id=([^;]+)/)
    const stravaAthleteId = cookieMatch?.[1]
    if (!stravaAthleteId) return false

    const { data } = await supabase
      .from('athletes')
      .select('id, strava_athlete_id, strava_access_token, strava_refresh_token, expires_at')
      .eq('strava_athlete_id', stravaAthleteId)
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
      avg_watts:   a.average_watts ?? null,
      elevation_m: a.total_elevation_gain ?? null,
    })),
    { onConflict: 'strava_id' },
  )

  // Fire-and-forget: auto-analyze any activity that doesn't have claude_analysis
  // yet (freshly synced ones, plus any older backlog). Not awaited — callers
  // (Dashboard/WeeklyPlan) proceed immediately, analysis runs in the background.
  // Sequential (not Promise.all) so a recovery decision from one activity is
  // already in coach_decisions by the time the next activity is analyzed.
  void (async () => {
    try {
      const { data: unanalyzed } = await supabase
        .from('activities')
        .select('*')
        .eq('athlete_id', athleteId)
        .is('claude_analysis', null)
        .order('date', { ascending: true })

      if (!unanalyzed?.length) return

      for (const activity of unanalyzed as Activity[]) {
        // Skip if another concurrent sync already claimed this activity (e.g.
        // StrictMode's dev double-mount, or WeeklyPlan's mini-sync running
        // around the same time) — prevents double Claude calls for one activity.
        if (!(await claimActivityForAnalysis(activity.id))) continue

        const result = await analyzeActivity(activity, athleteId)
        if (!result.success) {
          console.error(`Background analysis failed for activity ${activity.strava_id}:`, result.error)
        }
      }
    } catch (e) {
      // Best-effort background job — a lookup failure here must never surface
      // to the caller (Dashboard/WeeklyPlan already moved on without awaiting).
      console.error('Background analysis sweep failed:', e)
    }
  })()
}

// Revokes the app's Strava access for this athlete (used by account deletion).
// Fault-tolerant: returns false instead of throwing on failure (e.g. already-expired
// token) — the caller proceeds with DB deletion regardless and informs the athlete
// to disconnect manually via strava.com/settings/apps if this returns false.
export async function deauthorizeStrava(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch('/api/strava-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'deauthorize', access_token: accessToken }),
    })
    return res.ok
  } catch {
    return false
  }
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
