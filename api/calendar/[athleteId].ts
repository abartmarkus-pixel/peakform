import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { buildIcsFeed, type WeeklyPlanRow } from '../_lib/ics.js'

// Öffentlich abonnierbarer ICS-Feed (webcal://) pro Athlet. Kein Session-Auth nötig —
// athleteId (UUID) fungiert als Capability-Token, analog zur bereits offenen RLS-Policy
// im Rest des Projekts (persönlicher Einsatz, siehe CLAUDE.md).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const athleteId = req.query.athleteId
  if (typeof athleteId !== 'string' || athleteId.length < 10) {
    return res.status(400).json({ error: 'Invalid athleteId' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return res.status(500).json({ error: 'Server config error' })
  }

  const supabase = createClient(supabaseUrl, anonKey)

  const { data: plans, error } = await supabase
    .from('weekly_plans')
    .select('week_start, version, plan_json')
    .eq('athlete_id', athleteId)
    .order('version', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })

  // Absteigend nach version -> pro week_start zählt nur die erste (=neueste) Zeile.
  const latestByWeek = new Map<string, WeeklyPlanRow>()
  for (const p of plans ?? []) {
    const weekStart = p.week_start as string
    if (!latestByWeek.has(weekStart)) {
      latestByWeek.set(weekStart, { week_start: weekStart, plan_json: p.plan_json as WeeklyPlanRow['plan_json'] })
    }
  }

  const ics = buildIcsFeed(athleteId, [...latestByWeek.values()])

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  return res.status(200).send(ics)
}
