// Übernimmt eine Coach-Empfehlung aus activities.claude_analysis gezielt in
// einen Tag des aktuellen/nächsten Wochenplans (statt einer kompletten
// Neu-Generierung). Siehe src/lib/weeklyPlan.ts für die INSERT-only-Speicherung.

import { supabase, type WeeklyPlan } from './supabase'
import { getISOMonday, toDateStr, toLocalWeekdayDateStr, addDays } from './dateUtils'
import { DAYS, dayMatchesSport, insertPlanVersion, type DayPlan, type PlanJson } from './weeklyPlan'

export type PlanSport = 'running' | 'cycling' | 'strength'

export type RecommendationDraft = {
  day: string | null
  duration_min: number | null
  distance_km: number | null
  intensity: string | null
  description: string
  reasoning: string
}

// Monday einer Woche relativ zu heute, ohne Umweg über einen Wochentag —
// für den "Diese Woche"/"Nächste Woche"-Umschalter in der UI.
export function mondayForWeek(which: 'current' | 'next', today: Date = new Date()): Date {
  const thisMonday = getISOMonday(today)
  return which === 'current' ? thisMonday : addDays(thisMonday, 7)
}

// Woche wird deterministisch berechnet (nicht von Claude erraten): liegt der
// genannte Wochentag heute oder in der Vergangenheit dieser Woche, ist die
// nächste Einheit logisch für die kommende Woche gemeint.
export function resolveTargetWeek(day: string, today: Date = new Date()): { monday: Date; weekStart: string; which: 'current' | 'next' } {
  const todayIdx = today.getDay() === 0 ? 7 : today.getDay() // Mo=1..So=7
  const targetIdx = DAYS.indexOf(day) + 1 // DAYS = ['Mo',...,'So'] → 1..7
  const which: 'current' | 'next' = targetIdx > todayIdx ? 'current' : 'next'
  const monday = mondayForWeek(which, today)
  return { monday, weekStart: toDateStr(monday), which }
}

async function fetchLatestPlan(athleteId: string, weekStart: string): Promise<WeeklyPlan | null> {
  // Fallback: alte Einträge können mit UTC-Datum gespeichert sein (1 Tag früher) —
  // gleiche Behandlung wie in WeeklyPlan.tsx's Lade-Effekt.
  const [y, m, d] = weekStart.split('-').map(Number)
  const monday = new Date(y, m - 1, d)
  const weekStrFallback = toDateStr(addDays(monday, -1))

  const { data } = await supabase
    .from('weekly_plans')
    .select('*')
    .eq('athlete_id', athleteId)
    .in('week_start', [weekStart, weekStrFallback])
    .order('version', { ascending: false })
    .limit(1)
  return (data?.[0] as WeeklyPlan) ?? null
}

// Für den Tag-Dropdown im Übernahme-Modal: welche Tage einer Woche tragen
// bereits die passende Sportart (kein Verschieben der Trainingstag-Struktur).
export async function loadMatchingDays(athleteId: string, weekStart: string, sport: PlanSport): Promise<{ plan: WeeklyPlan; days: string[] } | null> {
  const plan = await fetchLatestPlan(athleteId, weekStart)
  if (!plan) return null
  const planJson = plan.plan_json as unknown as PlanJson
  const days = DAYS.filter(d => planJson.days[d] && dayMatchesSport(planJson.days[d], sport))
  return { plan, days }
}

function parseJsonFromClaudeText<T>(text: string): T {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = match ? match[1] : text
  return JSON.parse(raw.trim()) as T
}

export async function extractPlanRecommendation(params: {
  analysisText: string
  sport: PlanSport
}): Promise<RecommendationDraft> {
  const { analysisText, sport } = params
  const sportLabel: Record<PlanSport, string> = { running: 'Laufen', cycling: 'Radfahren', strength: 'Krafttraining' }

  const res = await fetch('/api/analyse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: 'Du extrahierst aus einem Trainings-Analysetext die Empfehlung für die nächste Einheit als striktes JSON. Antworte NUR mit JSON, kein Fließtext davor oder danach, keine Code-Fences.',
      prompt: `Heute ist ${toLocalWeekdayDateStr(new Date())}. Sportart der Analyse: ${sportLabel[sport]}.

Analysetext:
${analysisText}

Extrahiere die Empfehlung für die nächste Einheit als JSON:
{"day": "Mo"|"Di"|"Mi"|"Do"|"Fr"|"Sa"|"So"|null, "duration_min": number|null, "distance_km": number|null, "intensity": string|null, "description": string, "reasoning": string}

Regeln:
- "day": der im Text für die nächste Einheit genannte Wochentag (z.B. "Donnerstag" → "Do"). null wenn kein konkreter Wochentag genannt wird.
- "intensity": kurzes Format wie im Text (z.B. "Z2" oder "Z2-Z3"). null wenn nicht angegeben.
- "description": 1 prägnanter Satz, der die Empfehlung als Wochenplan-Tagesbeschreibung zusammenfasst.
- "reasoning": 1 kurzer Satz für ein Audit-Log, warum dieser Tag so angepasst wird.
- Nur Werte übernehmen, die im Text explizit für die NÄCHSTE Einheit genannt werden — keine Werte erfinden.`,
      max_tokens: 400,
    }),
  })
  if (!res.ok) throw new Error('Empfehlung konnte nicht extrahiert werden.')
  const { text } = await res.json() as { text: string }

  const draft = parseJsonFromClaudeText<RecommendationDraft>(text)
  if (draft.day && !DAYS.includes(draft.day)) draft.day = null
  if (!draft.description?.trim()) throw new Error('Keine verwertbare Empfehlung im Analysetext gefunden.')
  return draft
}

export async function applyPlanRecommendation(params: {
  athleteId: string
  weekStart: string
  day: string
  sport: PlanSport
  dayUpdate: { duration_min?: number | null; distance_km?: number | null; intensity?: string | null; description: string }
  activityName: string
  activityId: string
}): Promise<WeeklyPlan> {
  const { athleteId, weekStart, day, sport, dayUpdate, activityName, activityId } = params

  const plan = await fetchLatestPlan(athleteId, weekStart)
  if (!plan) throw new Error(`Kein Wochenplan für KW ${weekStart} gefunden — bitte zuerst einen Plan erzeugen.`)

  const planJson = plan.plan_json as unknown as PlanJson
  const existingDay = planJson.days[day]
  if (!existingDay) throw new Error(`Tag ${day} existiert nicht im Plan.`)
  if (!dayMatchesSport(existingDay, sport)) {
    throw new Error(`${day} ist im Plan kein ${sport === 'running' ? 'Lauf' : sport === 'cycling' ? 'Rad' : 'Kraft'}-Tag mehr — bitte anderen Tag wählen.`)
  }

  // Laufen zeigt nie distance_km (siehe CLAUDE.md-Invariante) — auch bei
  // manuell übernommenen Empfehlungen nicht durchbrechen.
  const updatedDay: DayPlan = {
    ...existingDay,
    ...(dayUpdate.duration_min != null && { duration_min: dayUpdate.duration_min }),
    ...(sport !== 'running' && dayUpdate.distance_km != null && { distance_km: dayUpdate.distance_km }),
    ...(dayUpdate.intensity && { intensity: dayUpdate.intensity }),
    description: dayUpdate.description,
  }

  const updatedPlanJson: PlanJson = { ...planJson, days: { ...planJson.days, [day]: updatedDay } }

  return insertPlanVersion({
    athleteId,
    weekStart: plan.week_start,
    planJson: updatedPlanJson,
    changeReason: `Empfehlung aus Analyse von "${activityName}" übernommen`,
    decisionType: 'plan_recommendation_applied',
    decisionSummary: `${day} (KW ${plan.week_start}): Empfehlung aus "${activityName}" übernommen`,
    relatedActivityId: activityId,
  })
}
