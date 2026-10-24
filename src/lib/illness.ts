// Krankheit melden / wieder gesund (WeeklyPlan.tsx) — Zeiträume in illness_periods
// (end_date NULL = aktuell krank). Rein deterministisch, kein Claude-Call:
// - Krank: Trainingstage ab dem Krankheitsbeginn werden Ruhetage (wiederherstellbar
//   über _restoreFrom, wie markAsRestDay()).
// - Wieder gesund: Wiedereinstieg mit so vielen lockeren Tagen wie Krankheitstagen
//   (mind. 2, max. 7 — Faustregel, keine Studie). In dem Zeitraum nur Z1/Z2 und
//   kürzer, kein Krafttraining; danach der ursprüngliche Plan. "Bei Fieber kein
//   Training" deckt die Krankmeldung selbst ab (alles Ruhetage, bis wieder gesund).

import { supabase } from './supabase'
import { toDateStr } from './dateUtils'
import { DAYS, REST_KEYWORDS, SPORT_KEYWORDS, type DayPlan, type PlanJson } from './weeklyPlan'

export type IllnessPeriod = {
  id: string
  athlete_id: string
  start_date: string // YYYY-MM-DD
  end_date: string | null
}

const RETURN_MIN_DAYS = 2
const RETURN_MAX_DAYS = 7
const RETURN_DURATION_FACTOR = 0.6
export const SICK_DESCRIPTION = 'Krank'

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return toDateStr(new Date(y, m - 1, d + days))
}

function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number)
  const [yb, mb, db] = b.split('-').map(Number)
  return Math.round((new Date(yb, mb - 1, db).getTime() - new Date(ya, ma - 1, da).getTime()) / 86400000)
}

/** Letzter Tag (inklusive) des lockeren Wiedereinstiegs, null solange noch krank. */
export function returnWindowEnd(p: IllnessPeriod): string | null {
  if (!p.end_date) return null
  const sickDays = Math.max(0, daysBetween(p.start_date, p.end_date))
  const returnDays = Math.min(RETURN_MAX_DAYS, Math.max(RETURN_MIN_DAYS, sickDays))
  return addDays(p.end_date, returnDays - 1)
}

/** Aktive Krankheit oder eine, deren Wiedereinstieg noch läuft (sonst null). */
export async function fetchRelevantIllness(athleteId: string): Promise<IllnessPeriod | null> {
  const { data } = await supabase
    .from('illness_periods')
    .select('id, athlete_id, start_date, end_date')
    .eq('athlete_id', athleteId)
    .order('start_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
  const p = (data?.[0] as IllnessPeriod | undefined) ?? null
  if (!p) return null
  const until = returnWindowEnd(p)
  return !until || until >= toDateStr(new Date()) ? p : null
}

export async function startIllness(athleteId: string, startDate: string): Promise<IllnessPeriod> {
  const { data, error } = await supabase
    .from('illness_periods')
    .insert({ athlete_id: athleteId, start_date: startDate })
    .select('id, athlete_id, start_date, end_date')
    .single()
  if (error) throw error
  return data as IllnessPeriod
}

export async function endIllness(p: IllnessPeriod, endDate: string): Promise<IllnessPeriod> {
  const { data, error } = await supabase
    .from('illness_periods')
    .update({ end_date: endDate < p.start_date ? p.start_date : endDate })
    .eq('id', p.id)
    .select('id, athlete_id, start_date, end_date')
    .single()
  if (error) throw error
  return data as IllnessPeriod
}

function dayDateStr(monday: Date, day: string): string {
  return toDateStr(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + DAYS.indexOf(day)))
}

function isRest(d: DayPlan): boolean {
  return REST_KEYWORDS.some(k => d.type.toLowerCase().includes(k))
}

function isKraft(d: DayPlan): boolean {
  return SPORT_KEYWORDS.strength.some(k => d.type.toLowerCase().includes(k))
}

/** Trainingstage ab fromDate (inklusive) werden zu Krank-Ruhetagen. */
export function markSickDays(planJson: PlanJson, monday: Date, fromDate: string): PlanJson {
  const days = { ...planJson.days }
  for (const key of DAYS) {
    const d = days[key]
    if (!d || isRest(d) || dayDateStr(monday, key) < fromDate) continue
    days[key] = { type: 'Ruhetag', description: SICK_DESCRIPTION, _restoreFrom: d }
  }
  return { ...planJson, days }
}

function softened(d: DayPlan): DayPlan {
  if (isKraft(d)) {
    return { type: 'Ruhetag', description: 'Wiedereinstieg nach Krankheit — noch kein Krafttraining', _restoreFrom: d }
  }
  return {
    ...d,
    duration_min: d.duration_min ? Math.max(20, Math.round((d.duration_min * RETURN_DURATION_FACTOR) / 5) * 5) : d.duration_min,
    intensity: 'Z2 locker',
    description: 'Wiedereinstieg nach Krankheit — locker und kürzer, bei erneuten Beschwerden abbrechen',
    main_set: undefined,
    power: undefined, // applyCyclingPower() berechnet Z2-Watt neu
  }
}

/** Ab fromDate: Krank-Tage wiederherstellen; bis untilDate (inklusive) im lockeren
 *  Wiedereinstieg-Modus, danach im Original. Tage vor fromDate bleiben unverändert. */
export function applyReturnToPlan(planJson: PlanJson, monday: Date, fromDate: string, untilDate: string): PlanJson {
  const days = { ...planJson.days }
  for (const key of DAYS) {
    const d = days[key]
    const date = dayDateStr(monday, key)
    if (!d || date < fromDate) continue
    const original = d.description === SICK_DESCRIPTION && d._restoreFrom ? d._restoreFrom : d
    if (isRest(original)) { days[key] = original; continue }
    days[key] = date <= untilDate ? softened(original) : original
  }
  return { ...planJson, days }
}

/** Prompt-Abschnitt für generatePlan() (höchste Priorität) bzw. Coach-Kontext. */
export function illnessPromptLine(p: IllnessPeriod): string {
  const fmt = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })
  if (!p.end_date) return `Athlet ist seit ${fmt(p.start_date)} krank gemeldet — kein Training, bis er sich gesund meldet.`
  const until = returnWindowEnd(p)!
  return `Athlet war vom ${fmt(p.start_date)} bis ${fmt(p.end_date)} krank. Wiedereinstieg bis einschließlich ${fmt(until)}: nur lockere, kürzere Einheiten (Z1/Z2), KEINE harten Einheiten, Kraft-Tage erst nach diesem Datum einplanen.`
}

/** Ob der Wiedereinstieg (oder die Krankheit) in die Woche ab monday hineinreicht. */
export function illnessAffectsWeek(p: IllnessPeriod, monday: Date): boolean {
  const until = returnWindowEnd(p)
  return !until || until >= toDateStr(monday)
}
