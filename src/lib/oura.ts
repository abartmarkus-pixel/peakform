import { supabase, type Athlete, type OuraDaily } from './supabase'
import { addDays, toDateStr } from './dateUtils'

// Oura-Ring-Anbindung: Schlaf/HRV/Readiness/Ruhepuls als Erholungssignal für den Coach
// (buildCoachContext() → [ERHOLUNG (OURA-RING)]) und automatischer Ruhepuls fürs
// Profil (Karvonen-Basis der HF-Zonen). OAuth wie bei Strava; alle Oura-Aufrufe laufen
// über /api/oura (Client-Secret nur serverseitig).

const SCOPES = 'daily'
const INITIAL_SYNC_DAYS = 60
const RESTING_HR_NIGHTS = 14
const RESTING_HR_MIN_NIGHTS = 5

export function ouraRedirectUri(): string {
  return `${window.location.origin}/oura/callback`
}

export function isOuraConfigured(): boolean {
  return !!import.meta.env.VITE_OURA_CLIENT_ID
}

export function getOuraAuthUrl(): string {
  const state = crypto.randomUUID()
  sessionStorage.setItem('oura_oauth_state', state)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: import.meta.env.VITE_OURA_CLIENT_ID,
    redirect_uri: ouraRedirectUri(),
    scope: SCOPES,
    state,
  })
  return `https://cloud.ouraring.com/oauth/authorize?${params}`
}

type OuraTokenResponse = { access_token: string; refresh_token: string; expires_in: number }

async function callOura<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/oura', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Oura ${payload.action} ${res.status}`)
  return res.json() as Promise<T>
}

async function saveTokens(athleteId: string, t: OuraTokenResponse): Promise<void> {
  const { error } = await supabase.from('athletes').update({
    oura_access_token: t.access_token,
    oura_refresh_token: t.refresh_token,
    oura_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  }).eq('id', athleteId)
  if (error) throw error
}

export async function connectOura(athleteId: string, code: string): Promise<void> {
  const t = await callOura<OuraTokenResponse>({
    action: 'token', grant_type: 'authorization_code', code, redirect_uri: ouraRedirectUri(),
  })
  await saveTokens(athleteId, t)
}

export async function disconnectOura(athleteId: string): Promise<void> {
  await supabase.from('athletes').update({
    oura_access_token: null,
    oura_refresh_token: null,
    oura_expires_at: null,
    resting_hr_source: null,
  }).eq('id', athleteId)
}

// Oura-Refresh-Tokens sind Einmal-Tokens: zwei gleichzeitige Refreshes (StrictMode-
// Doppel-Mount, mehrere Tabs) würden sich gegenseitig ungültig machen → ein laufender
// Refresh wird geteilt statt doppelt gestartet.
let refreshInFlight: Promise<string> | null = null

async function getValidOuraToken(athlete: Athlete): Promise<string> {
  if (!athlete.oura_access_token || !athlete.oura_refresh_token) throw new Error('Oura nicht verbunden')
  const expiresAt = athlete.oura_expires_at ? new Date(athlete.oura_expires_at).getTime() : 0
  if (expiresAt - Date.now() > 60_000) return athlete.oura_access_token

  if (!refreshInFlight) {
    refreshInFlight = callOura<OuraTokenResponse>({
      action: 'token', grant_type: 'refresh_token', refresh_token: athlete.oura_refresh_token,
    })
      .then(async t => { await saveTokens(athlete.id, t); return t.access_token })
      .finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

type OuraList<T> = { data: T[] }
type ReadinessItem = { day: string; score: number | null; temperature_deviation: number | null }
type DailySleepItem = { day: string; score: number | null }
type SleepItem = {
  day: string
  type: string
  total_sleep_duration: number | null
  average_hrv: number | null
  lowest_heart_rate: number | null
}

let syncInFlight: Promise<void> | null = null

// Holt neue Nächte ab (beim ersten Mal die letzten INITIAL_SYNC_DAYS Tage, danach ab
// 2 Tagen vor dem letzten gespeicherten Tag — Oura ergänzt Werte teils nachträglich)
// und aktualisiert den Ruhepuls. Silent failure analog zu backfillStravaPrs().
export function syncOuraData(athleteId: string): Promise<void> {
  if (!syncInFlight) syncInFlight = runSync(athleteId).catch(() => {}).finally(() => { syncInFlight = null })
  return syncInFlight
}

async function runSync(athleteId: string): Promise<void> {
  const { data: athleteRow } = await supabase.from('athletes').select('*').eq('id', athleteId).single()
  const athlete = athleteRow as Athlete | null
  if (!athlete?.oura_access_token) return

  const token = await getValidOuraToken(athlete)

  const { data: lastRow } = await supabase
    .from('oura_daily').select('day').eq('athlete_id', athleteId)
    .order('day', { ascending: false }).limit(1)
  const today = new Date()
  const earliest = addDays(today, -INITIAL_SYNC_DAYS)
  const lastDay = lastRow?.[0]?.day ? addDays(new Date(`${lastRow[0].day}T12:00:00`), -2) : earliest
  const start = toDateStr(lastDay > earliest ? lastDay : earliest)
  const end = toDateStr(addDays(today, 1))

  const fetchPath = <T>(path: string) =>
    callOura<OuraList<T>>({ action: 'data', path, access_token: token, start_date: start, end_date: end })
  const [readiness, dailySleep, sleep] = await Promise.all([
    fetchPath<ReadinessItem>('daily_readiness'),
    fetchPath<DailySleepItem>('daily_sleep'),
    fetchPath<SleepItem>('sleep'),
  ])

  const byDay = new Map<string, Partial<OuraDaily>>()
  const row = (day: string) => {
    if (!byDay.has(day)) byDay.set(day, { athlete_id: athleteId, day })
    return byDay.get(day)!
  }
  for (const r of readiness.data) {
    row(r.day).readiness_score = r.score
    row(r.day).temperature_deviation = r.temperature_deviation
  }
  for (const s of dailySleep.data) row(s.day).sleep_score = s.score
  // Pro Tag nur die Hauptschlafphase (längste "long_sleep"), keine Nickerchen
  const mainSleep = new Map<string, SleepItem>()
  for (const s of sleep.data) {
    if (s.type !== 'long_sleep') continue
    const prev = mainSleep.get(s.day)
    if (!prev || (s.total_sleep_duration ?? 0) > (prev.total_sleep_duration ?? 0)) mainSleep.set(s.day, s)
  }
  for (const [day, s] of mainSleep) {
    const r = row(day)
    r.sleep_duration_s = s.total_sleep_duration
    r.average_hrv = s.average_hrv
    r.lowest_heart_rate = s.lowest_heart_rate
  }

  if (byDay.size) {
    const { error } = await supabase.from('oura_daily').upsert([...byDay.values()], { onConflict: 'athlete_id,day' })
    if (error) throw error
  }

  await updateRestingHr(athleteId)
}

// Ruhepuls = Ø des niedrigsten Nachtpulses der letzten RESTING_HR_NIGHTS Nächte (Nutzerentscheidung:
// automatisch statt Vorschlag). Liegt meist 1–3 bpm unter dem klassisch morgens gemessenen Ruhepuls.
async function updateRestingHr(athleteId: string): Promise<void> {
  const { data } = await supabase
    .from('oura_daily').select('lowest_heart_rate')
    .eq('athlete_id', athleteId)
    .not('lowest_heart_rate', 'is', null)
    .gte('day', toDateStr(addDays(new Date(), -RESTING_HR_NIGHTS)))
  const values = (data ?? []).map(d => d.lowest_heart_rate as number)
  if (values.length < RESTING_HR_MIN_NIGHTS) return
  const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length)
  await supabase.from('athletes').update({ resting_hr: avg, resting_hr_source: 'oura' }).eq('id', athleteId)
}

// ── Coach-Kontext ─────────────────────────────────────────────────────────

const BASELINE_DAYS = 28

function avg(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x != null)
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

function formatSleep(seconds: number | null): string {
  if (seconds == null) return '—'
  const m = Math.round(seconds / 60)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`
}

export function formatOuraNight(d: OuraDaily): string {
  const parts = [
    d.readiness_score != null ? `Readiness ${d.readiness_score}` : null,
    d.sleep_score != null ? `Schlaf-Score ${d.sleep_score}` : null,
    d.sleep_duration_s != null ? `Schlaf ${formatSleep(d.sleep_duration_s)}` : null,
    d.average_hrv != null ? `HRV ${Math.round(d.average_hrv)} ms` : null,
    d.lowest_heart_rate != null ? `niedrigster Puls ${d.lowest_heart_rate}` : null,
    d.temperature_deviation != null ? `Temp. ${d.temperature_deviation > 0 ? '+' : ''}${d.temperature_deviation.toFixed(1)} °C` : null,
  ].filter(Boolean)
  return parts.join(', ')
}

/** [ERHOLUNG (OURA-RING)]-Abschnitt für buildCoachContext(): letzte 7 Nächte + 4-Wochen-Normalwert. */
export async function buildOuraContextSection(athleteId: string): Promise<string | null> {
  const { data } = await supabase
    .from('oura_daily').select('*')
    .eq('athlete_id', athleteId)
    .gte('day', toDateStr(addDays(new Date(), -BASELINE_DAYS)))
    .order('day', { ascending: false })
  const rows = (data ?? []) as OuraDaily[]
  if (!rows.length) return null

  const baseHrv = avg(rows.map(r => r.average_hrv))
  const baseLowHr = avg(rows.map(r => r.lowest_heart_rate))
  const baseSleep = avg(rows.map(r => r.sleep_duration_s))

  const lines = rows.slice(0, 7).map(r => {
    const [y, m, d] = r.day.split('-').map(Number)
    const label = new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })
    return `- ${label}: ${formatOuraNight(r)}`
  })

  return [
    '[ERHOLUNG (OURA-RING)]',
    'Nächtliche Erholungswerte (Tag = Morgen nach der Nacht), neueste zuerst:',
    ...lines,
    `Normalwert letzte ${BASELINE_DAYS} Tage: HRV ${baseHrv != null ? Math.round(baseHrv) + ' ms' : '—'}, niedrigster Puls ${baseLowHr != null ? Math.round(baseLowHr) + ' bpm' : '—'}, Schlaf ${formatSleep(baseSleep)}`,
    'Nutze diese Werte als Erholungssignal (z.B. erhöhter Puls in einer Einheit nach kurzer Nacht oder HRV deutlich unter Normalwert). Einzelne Nächte nicht überbewerten — erst mehrere schwache Nächte in Folge sind ein klares Signal. Keine medizinischen Diagnosen.',
  ].join('\n')
}

/** Oura-Werte der Nacht vor einer Aktivität (Tag der Aktivität = Oura-"day"), für die Einzelanalyse. */
export async function fetchOuraNightBefore(athleteId: string, activityDate: string): Promise<OuraDaily | null> {
  const { data } = await supabase
    .from('oura_daily').select('*')
    .eq('athlete_id', athleteId)
    .eq('day', toDateStr(new Date(activityDate)))
    .maybeSingle()
  return (data as OuraDaily | null) ?? null
}
