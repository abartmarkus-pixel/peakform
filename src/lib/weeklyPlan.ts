// Geteilte Wochenplan-Typen und -Helfer — genutzt von WeeklyPlan.tsx (Haupt-UI)
// UND von planRecommendation.ts (Coach-Empfehlung aus einer Aktivitäts-Analyse
// gezielt in einen Plantag übernehmen, siehe ActivityDetail.tsx).

import { supabase, type WeeklyPlan } from './supabase'

export type DayPlan = {
  type: string
  duration_min?: number
  distance_km?: number
  intensity?: string
  description: string
  // Nur gesetzt bei manuell erzeugten Ruhetagen (via markAsRestDay) — trägt den
  // ursprünglichen Taginhalt für "Aktivität wiederherstellen" mit; JSONB speichert
  // es klaglos mit, übersteht also Reload und Versionswechsel.
  _restoreFrom?: DayPlan
  // Nur gesetzt, wenn eine an einem anderen Tag vorgezogen durchgeführte Aktivität
  // diesen Tag erfüllt (Kontext-Vorschlag "Vorziehen erkannt").
  // Der Tag selbst bleibt inhaltlich unverändert (type/description etc.).
  _fulfilledBy?: { date: string; stravaId: number }
}

export type PlanJson = {
  summary: string
  days: Record<string, DayPlan>
}

export const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
export const DAY_FULL: Record<string, string> = {
  Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag',
  Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag',
}

// ── manual-edit conflict check (client-seitig, kein Claude-Call) ───────────
// "intensiv" folgt denselben sportwissenschaftlichen Regeln, die der Coach
// beim Planen bekommt (siehe generatePlan()-Prompt in WeeklyPlan.tsx, Regeln 3-4):
// Z3+-Ausdauer UND schweres Krafttraining zählen beide als intensiv.

export const REST_KEYWORDS = ['ruhetag', 'erholung', 'regeneration']
export const SPORT_KEYWORDS: Record<string, string[]> = {
  cycling:  ['ride', 'radfahren', 'cycling'],
  running:  ['run', 'laufen', 'running'],
  strength: ['kraft', 'weighttraining', 'krafttraining'],
}

// Ob ein Plan-Tag zu einer Sportart passt — genutzt um beim Übernehmen einer
// Coach-Empfehlung (siehe planRecommendation.ts) nur Tage anwählbar zu machen,
// die bereits diese Sportart tragen (kein Verschieben der Trainingstag-Struktur).
export function dayMatchesSport(d: DayPlan, sport: 'running' | 'cycling' | 'strength'): boolean {
  const t = d.type.toLowerCase()
  return SPORT_KEYWORDS[sport].some(k => t.includes(k))
}

// Generalisiert die /^Z[3-5]/-Konvention aus isIntensiveEndurance/isIntensiveDay
// auf alle 5 Zonen — genutzt vom Stimulus-Check (Ist-HF vs. für den Tag geplante
// Soll-Zone, siehe activityAnalysis.ts triggerStimulusCheck()).
export function resolveDayZone(d: DayPlan): number | null {
  const match = /^Z([1-5])/i.exec(d.intensity ?? '')
  return match ? Number(match[1]) : null
}

function isRestDay(d: DayPlan): boolean {
  return REST_KEYWORDS.some(k => d.type.toLowerCase().includes(k))
}

function isKraftDay(d: DayPlan): boolean {
  return SPORT_KEYWORDS.strength.some(k => d.type.toLowerCase().includes(k))
}

function isIntensiveEndurance(d: DayPlan): boolean {
  return !isRestDay(d) && !isKraftDay(d) && /^Z[3-5]/i.test(d.intensity ?? '')
}

function isIntensiveDay(d: DayPlan): boolean {
  if (isRestDay(d)) return false
  if (isKraftDay(d)) return true
  return /^Z[3-5]/i.test(d.intensity ?? '')
}

export function checkPlanConflicts(days: Record<string, DayPlan>): string | null {
  for (let i = 0; i < DAYS.length - 1; i++) {
    const today = days[DAYS[i]]
    const tomorrow = days[DAYS[i + 1]]
    if (!today || !tomorrow) continue

    if (isKraftDay(today) && isIntensiveEndurance(tomorrow)) {
      return `Krafttraining am ${DAYS[i]} liegt jetzt direkt vor einer intensiven Einheit am ${DAYS[i + 1]}.`
    }
    if (isIntensiveDay(today) && isIntensiveDay(tomorrow)) {
      return `${DAYS[i]} und ${DAYS[i + 1]} sind jetzt beide intensiv — direkt hintereinander ohne Erholung.`
    }
  }
  return null
}

// ── INSERT-only Versionierung (siehe CLAUDE.md: weekly_plans nie UPDATEn) ──
// Gleiche Logik wie WeeklyPlan.tsx' saveManualPlanChange()/savePlanJson(), als
// eigenständige Funktion nutzbar auch außerhalb der WeeklyPlan-Komponente
// (z.B. von ActivityDetail.tsx aus, ohne deren lokalen Component-State).

export async function insertPlanVersion(params: {
  athleteId: string
  weekStart: string
  planJson: PlanJson
  changeReason: string
  decisionType: string
  decisionSummary: string
  hasViolation?: boolean
  relatedActivityId?: string
}): Promise<WeeklyPlan> {
  const { athleteId, weekStart, planJson, changeReason, decisionType, decisionSummary, hasViolation, relatedActivityId } = params

  const { data: existing } = await supabase
    .from('weekly_plans')
    .select('version')
    .eq('athlete_id', athleteId)
    .eq('week_start', weekStart)
    .order('version', { ascending: false })
    .limit(1)
  const nextVersion = (existing?.[0]?.version ?? 0) + 1

  const { data: inserted, error } = await supabase
    .from('weekly_plans')
    .insert({
      athlete_id:    athleteId,
      week_start:    weekStart,
      version:       nextVersion,
      plan_json:     planJson,
      change_reason: changeReason,
      ...(hasViolation && { plan_constraint_violation: true }),
    })
    .select()
    .single()
  if (error) throw error

  await supabase.from('coach_decisions').insert({
    athlete_id:           athleteId,
    decision_type:        decisionType,
    decision_summary:     decisionSummary,
    related_plan_id:      (inserted as WeeklyPlan).id,
    ...(relatedActivityId && { related_activity_id: relatedActivityId }),
  })

  return inserted as WeeklyPlan
}
