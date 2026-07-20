import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import webpush, { type PushSubscription, WebPushError } from 'web-push'

// getDay()-Index (0=So .. 6=Sa) -> Wochentag-Kürzel, wie in plan_json.days verwendet.
const WEEKDAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const REST_KEYWORDS = ['ruhetag', 'erholung', 'regeneration']

type DayPlan = {
  type: string
  duration_min?: number
  distance_km?: number
  description: string
}

// Läuft in der Vercel-Runtime (Prozess-Timezone UTC) — "heute"/Wochenstart werden
// deshalb explizit in Europe/Vienna berechnet statt über new Date().getDay(), sonst
// droht derselbe UTC-Slice-Bug-Typ wie mehrfach in der Roadmap dokumentiert.
function viennaTodayInfo(now: Date): { weekdayLabel: string; weekStart: string } {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(now)
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const weekdayLabel = WEEKDAY_LABELS[date.getDay()]

  const monday = new Date(date)
  const diff = date.getDay() === 0 ? -6 : 1 - date.getDay()
  monday.setDate(monday.getDate() + diff)
  const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`

  return { weekdayLabel, weekStart }
}

function isRestDay(d: DayPlan): boolean {
  return REST_KEYWORDS.some(k => d.type.toLowerCase().includes(k))
}

// Liefert den UTC-Zeitraum für "heute" in Europe/Vienna als [start, end) — für die
// activities.date-Abfrage im Abend-Slot. longOffset (z.B. "GMT+02:00") berücksichtigt
// CEST/CET automatisch, ohne den Wert selbst hart zu codieren.
function viennaDayBoundsUTC(now: Date): { startUTC: string; endUTC: string } {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(now)
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna', timeZoneName: 'longOffset' })
    .formatToParts(now)
    .find(p => p.type === 'timeZoneName')?.value ?? 'GMT+02:00'
  const offset = offsetName.replace('GMT', '')
  const start = new Date(`${dateStr}T00:00:00${offset}`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startUTC: start.toISOString(), endUTC: end.toISOString() }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // morning (07:00): immer senden, wenn kein Ruhetag. evening (17:00): zusätzlich
  // nur, wenn für heute noch keine Strava-Aktivität erfasst wurde.
  const slot = req.query.slot === 'evening' ? 'evening' : 'morning'

  const vapidPublic = process.env.VITE_VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!vapidPublic || !vapidPrivate || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server config error' })
  }

  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:noreply@peakform.app', vapidPublic, vapidPrivate)
  const supabase = createClient(supabaseUrl, serviceKey)

  const { weekdayLabel, weekStart } = viennaTodayInfo(new Date())

  const { data: subs, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('id, athlete_id, endpoint, p256dh, auth')
  if (subsError) return res.status(500).json({ error: subsError.message })
  if (!subs?.length) return res.status(200).json({ sent: 0, skipped: 0, removedStale: 0 })

  const athleteIds = [...new Set(subs.map(s => s.athlete_id as string))]

  const { data: plans } = await supabase
    .from('weekly_plans')
    .select('athlete_id, plan_json, version')
    .in('athlete_id', athleteIds)
    .eq('week_start', weekStart)
    .order('version', { ascending: false })

  // Absteigend nach version sortiert -> pro Athlet zählt nur die erste (=neueste) Zeile.
  const latestPlanByAthlete = new Map<string, Record<string, unknown>>()
  for (const p of plans ?? []) {
    const athleteId = p.athlete_id as string
    if (!latestPlanByAthlete.has(athleteId)) {
      latestPlanByAthlete.set(athleteId, p.plan_json as Record<string, unknown>)
    }
  }

  // Abend-Slot: Athleten mit bereits erfasster Aktivität "heute" (Vienna) überspringen.
  // Bewusst simpler Check (irgendeine Aktivität heute) statt der vollen
  // Sportart/Workout-Matching-Logik aus WeeklyPlan.tsx — für eine Erinnerung reicht
  // "hat heute schon trainiert", eine Fehlklassifizierung hätte hier keine Folgen.
  const athletesWithActivityToday = new Set<string>()
  if (slot === 'evening') {
    const { startUTC, endUTC } = viennaDayBoundsUTC(new Date())
    const { data: todaysActivities } = await supabase
      .from('activities')
      .select('athlete_id')
      .in('athlete_id', athleteIds)
      .gte('date', startUTC)
      .lt('date', endUTC)
    for (const a of todaysActivities ?? []) athletesWithActivityToday.add(a.athlete_id as string)
  }

  let sent = 0
  let skipped = 0
  const staleSubscriptionIds: string[] = []

  for (const sub of subs) {
    const athleteId = sub.athlete_id as string
    if (slot === 'evening' && athletesWithActivityToday.has(athleteId)) { skipped++; continue }

    const planJson = latestPlanByAthlete.get(athleteId)
    const days = planJson?.days as Record<string, DayPlan> | undefined
    const today = days?.[weekdayLabel]
    if (!today || isRestDay(today)) { skipped++; continue }

    const bodyParts = [today.type]
    if (today.duration_min) bodyParts.push(`${today.duration_min} min`)
    if (today.distance_km) bodyParts.push(`${today.distance_km} km`)

    const subscription: PushSubscription = {
      endpoint: sub.endpoint as string,
      keys: { p256dh: sub.p256dh as string, auth: sub.auth as string },
    }

    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ title: 'Geplante Einheit für heute', body: bodyParts.join(' · '), url: '/plan' }),
      )
      sent++
    } catch (err) {
      if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
        staleSubscriptionIds.push(sub.id as string)
      }
    }
  }

  if (staleSubscriptionIds.length) {
    await supabase.from('push_subscriptions').delete().in('id', staleSubscriptionIds)
  }

  return res.status(200).json({ slot, sent, skipped, removedStale: staleSubscriptionIds.length })
}
