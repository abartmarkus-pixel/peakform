// Watt-Vorgaben + Indoor/Outdoor für Rad-Plantage (Regelliste Rad v1: F1 Wattzonen
// immer aus der aktuellen FTP, L9 Indoor nach Watt steuern + Obergrenze). Die Watt-
// zahlen rechnet die App selbst — Claude liefert nur Zone + Intervallstruktur.
// Die berechneten Watt werden beim Erzeugen mit in plan_json gespeichert (wie ein
// ausgedruckter Plan): ändert sich die FTP, gilt sie ab dem nächsten erzeugten Plan.

import type { DayPlan, PlanJson } from './weeklyPlan'

export type CyclingZone = 'Z1' | 'Z2' | 'Z3' | 'SS' | 'Z4' | 'Z5' | 'Z6'

// Coggan-Leistungszonen in % FTP; SS = Sweet Spot (88–94 %, Regelliste L4)
export const POWER_ZONES: Record<CyclingZone, { low: number; high: number; label: string }> = {
  Z1: { low: 0,    high: 0.55, label: 'Erholung' },
  Z2: { low: 0.56, high: 0.75, label: 'Grundlage' },
  Z3: { low: 0.76, high: 0.90, label: 'Tempo' },
  SS: { low: 0.88, high: 0.94, label: 'Sweet Spot' },
  Z4: { low: 0.91, high: 1.05, label: 'Schwelle' },
  Z5: { low: 1.06, high: 1.20, label: 'VO2max' },
  Z6: { low: 1.21, high: 1.50, label: 'anaerob' },
}

// Persönliche Leitplanke (Regelliste L9 nennt 2–2,5 h als Faustregel ohne Studie;
// bewusst auf 3 h gesetzt)
export const INDOOR_MAX_MIN = 180

export type MainSetItem = {
  reps: number
  minutes: number
  zone: CyclingZone
  rest_min: number
  // von der App berechnet (applyCyclingPower), nie von Claude
  low?: number
  high?: number
}

export function wattRange(zone: CyclingZone, ftp: number): { low: number; high: number } {
  const z = POWER_ZONES[zone]
  return { low: Math.round(z.low * ftp), high: Math.round(z.high * ftp) }
}

export function isCyclingDay(d: DayPlan): boolean {
  const t = d.type.toLowerCase()
  return ['ride', 'radfahren', 'cycling'].some(k => t.includes(k))
}

function dayZone(d: DayPlan): CyclingZone | null {
  const m = /^(Z[1-6]|SS)/i.exec(d.intensity ?? '')
  return m ? (m[1].toUpperCase() as CyclingZone) : null
}

/** Ergänzt alle Rad-Tage um Watt-Bereiche (Gesamteinheit + Intervalle) aus der FTP.
 *  Ungültige Intervall-Einträge von Claude werden verworfen statt geraten. Ohne FTP
 *  bleiben nur Zonen stehen (keine Wattzahlen). */
export function applyCyclingPower(planJson: PlanJson, ftp: number | null): PlanJson {
  const days: Record<string, DayPlan> = {}
  for (const [key, d] of Object.entries(planJson.days)) {
    if (!isCyclingDay(d)) { days[key] = d; continue }
    const zone = dayZone(d)
    const mainSet = (Array.isArray(d.main_set) ? d.main_set : [])
      .filter(s => s && s.zone in POWER_ZONES && s.reps > 0 && s.minutes > 0)
      .map(s => ({
        reps: Math.round(s.reps),
        minutes: s.minutes,
        zone: s.zone,
        rest_min: s.rest_min > 0 ? s.rest_min : 0,
        ...(ftp ? wattRange(s.zone, ftp) : {}),
      }))
    days[key] = {
      ...d,
      location: d.location === 'outdoor' ? 'outdoor' : d.location === 'indoor' ? 'indoor' : undefined,
      power: ftp && zone ? wattRange(zone, ftp) : undefined,
      main_set: mainSet.length ? mainSet : undefined,
    }
  }
  return { ...planJson, days }
}

/** Harte Prüfung (wie validateConstraints): Indoor-Einheit länger als die Obergrenze. */
export function checkIndoorCap(planJson: PlanJson): string[] {
  return Object.entries(planJson.days)
    .filter(([, d]) => isCyclingDay(d) && d.location === 'indoor' && (d.duration_min ?? 0) > INDOOR_MAX_MIN)
    .map(([key, d]) => `${key}: Indoor-Einheit ${d.duration_min} Min (max. ${INDOOR_MAX_MIN} Min)`)
}

export function formatWatts(r: { low: number; high: number }): string {
  return r.low > 0 ? `${r.low}–${r.high} W` : `bis ${r.high} W`
}

export function formatMainSetItem(s: MainSetItem): string {
  const watts = s.low != null && s.high != null ? ` @ ${formatWatts({ low: s.low, high: s.high })}` : ''
  const rest = s.rest_min ? `, Pause ${s.rest_min} Min locker` : ''
  return `${s.reps} × ${s.minutes} Min ${POWER_ZONES[s.zone].label}${watts}${rest}`
}

// Sonntag der Woche entscheidet — die Woche, die in den November reicht, zählt schon als Winter
function isWinterWeek(monday: Date): boolean {
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const month = sunday.getMonth() + 1
  return month >= 11 || month <= 2
}

/** Prompt-Abschnitt für Plan-Generierung — Watt-Tabelle fest berechnet, damit Claude
 *  nicht selbst rechnet; Indoor/Outdoor-Standard nach Monat der Planwoche. */
export function buildCyclingPlanRules(ftp: number | null, monday: Date): string {
  const winter = isWinterWeek(monday)
  const zoneTable = ftp
    ? (Object.keys(POWER_ZONES) as CyclingZone[])
        .map(z => `  ${z} ${POWER_ZONES[z].label}: ${formatWatts(wattRange(z, ftp))}`)
        .join('\n')
    : '  (keine FTP im Profil — nur Zonen angeben)'
  return `
RAD-EINHEITEN — PFLICHT:
9. Jede Rad-Einheit hat "location": "indoor" (Rolle/Zwift) oder "outdoor". ${winter
    ? 'Diese Woche liegt im Winter (Nov–Feb): plane Rad-Einheiten standardmäßig indoor.'
    : 'Außerhalb des Winters: lange Ausfahrten outdoor, Intervalle dürfen indoor sein.'}
10. Indoor-Einheiten dauern maximal ${INDOOR_MAX_MIN} Minuten.
11. Leistungszonen bei FTP ${ftp ?? '–'} W (von der App berechnet, NICHT selbst umrechnen):
${zoneTable}
12. "intensity" einer Rad-Einheit beginnt mit der Zone der Gesamteinheit ("Z2 Grundlage", "SS Sweet Spot", "Z4 Schwelle" …).
13. Strukturierte Einheiten (Intervalle ab Z3/SS) bekommen "main_set": Liste der Hauptblöcke, z. B. [{"reps": 3, "minutes": 15, "zone": "SS", "rest_min": 5}]. Erlaubte Zonen: Z1, Z2, Z3, SS, Z4, Z5, Z6. Ein- und Ausfahren NICHT in main_set. Lockere Fahrten: "main_set": null.
14. Nenne in "description" KEINE Wattzahlen — die App zeigt sie aus main_set/Zone selbst an.
`
}

// ── Wochenaufbau Rad (Regelliste L3 + F5) ──────────────────────────────────
// Nur wenn das A-Ziel ein Radziel ist (Aufruf in WeeklyPlan.tsx generatePlan()).
// Claude wählt die Inhalte, die App prüft das Gerüst: genau eine lange Ausfahrt am
// Wochenende, 1–2 harte Einheiten, nie hart am Tag nach der langen Ausfahrt,
// Wochenstunden laut Profil (±10 %).

const HOURS_TOLERANCE = 0.1

function isHardRide(d: DayPlan): boolean {
  return /^(Z[3-6]|SS)/i.test(d.intensity ?? '')
}

function rideMinutesTarget(hoursPerWeek: number | null, volumeFactor = 1): number | null {
  return hoursPerWeek ? Math.round((hoursPerWeek * 60 * volumeFactor) / 5) * 5 : null
}

// Minuten-Budget fest vorgerechnet — Claude verteilte die Wochenstunden sonst falsch
// (zu wenig, oder ein zusätzlicher Radtag statt längerer Einheiten). Lange Ausfahrt
// ~45 % (in 15-Min-Schritten, indoor gedeckelt), Rest gleichmäßig in 5-Min-Schritten.
function rideBudget(rideDays: number, target: number, indoor: boolean): { long: number; other: number } {
  const longRaw = Math.round((target * 0.45) / 15) * 15
  const long = indoor ? Math.min(longRaw, INDOOR_MAX_MIN) : longRaw
  const other = Math.round((target - long) / (rideDays - 1) / 5) * 5
  return { long, other }
}

export function buildCyclingWeekStructureRules(
  rideDays: number,
  hoursPerWeek: number | null,
  monday: Date,
  volumeFactor = 1,
): string {
  if (rideDays < 2) return ''
  const target = rideMinutesTarget(hoursPerWeek, volumeFactor)
  const maxHard = rideDays >= 3 ? 2 : 1
  const budget = target ? rideBudget(rideDays, target, isWinterWeek(monday)) : null
  return `
RAD-WOCHENAUFBAU (fest, wird technisch geprüft):
15. Genau ${rideDays} Rad-Tage — mehr Umfang NIE über zusätzliche Tage, nur über die Dauer.
16. Genau EINE lange Ausfahrt: am Samstag oder Sonntag, Z2, die längste Rad-Einheit der Woche${budget ? ` — ${budget.long} Min` : ''}.
17. ${maxHard === 2 ? '1–2' : 'Genau 1'} harte Rad-Einheit(en) (SS/Z3 oder höher), nie am Tag direkt nach der langen Ausfahrt. Alle übrigen Rad-Einheiten Z1/Z2.${budget ? `
18. Die übrigen ${rideDays - 1} Rad-Einheiten dauern je ca. ${budget.other} Min (inkl. Ein-/Ausfahren). Summe ≈ ${target} Min${volumeFactor === 1 ? ` = ${hoursPerWeek} h laut Profil` : ` (${Math.round(volumeFactor * 100)} % von ${hoursPerWeek} h laut Profil)`}.` : ''}
`
}

export function checkCyclingWeekStructure(
  planJson: PlanJson,
  hoursPerWeek: number | null,
  skipVolumeCheck: boolean,
  volumeFactor = 1,
  expectedHard: number | null = null,
): string[] {
  const order = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
  const rides = order
    .map(key => ({ key, d: planJson.days[key] }))
    .filter((r): r is { key: string; d: DayPlan } => !!r.d && isCyclingDay(r.d))
  if (rides.length < 2) return []

  const issues: string[] = []
  const longest = rides.reduce((a, b) => ((b.d.duration_min ?? 0) > (a.d.duration_min ?? 0) ? b : a))
  if (!['Sa', 'So'].includes(longest.key) || isHardRide(longest.d)) {
    issues.push('Rad: keine lange, lockere Ausfahrt am Wochenende')
  } else {
    const next = planJson.days[order[order.indexOf(longest.key) + 1]]
    if (next && isCyclingDay(next) && isHardRide(next)) issues.push(`Rad: harte Einheit am Tag nach der langen Ausfahrt`)
  }

  const hard = rides.filter(r => isHardRide(r.d)).length
  const maxHard = rides.length >= 3 ? 2 : 1
  if (expectedHard != null ? hard !== Math.min(expectedHard, maxHard) : (hard < 1 || hard > maxHard)) {
    const expected = expectedHard != null ? String(Math.min(expectedHard, maxHard)) : maxHard === 2 ? '1–2' : '1'
    issues.push(`Rad: ${hard} harte Einheiten (vorgesehen: ${expected})`)
  }

  const target = rideMinutesTarget(hoursPerWeek, volumeFactor)
  if (target && !skipVolumeCheck) {
    const total = rides.reduce((sum, r) => sum + (r.d.duration_min ?? 0), 0)
    if (Math.abs(total - target) > target * HOURS_TOLERANCE) {
      const fmt = (min: number) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 1 })
      issues.push(`Rad: ${fmt(total)} h statt ${fmt(target)} h geplant`)
    }
  }
  return issues
}

// ── Blockplanung Rad (Regelliste L1, L2, L4–L6, F2/F3) ─────────────────────
// Blöcke rückwärts vom A-Event: Taper 2 Wo., Spezifisch 7, Aufbau 10, davor Grundlage
// (nominal 12 Wo.). Durchgehender 3:1-Rhythmus vor dem Taper (3 Belastungs-, 1 Ent-
// lastungswoche), so gezählt, dass die letzten 3 Wochen vor dem Taper Belastung sind.
// Die Intervall-Inhalte stehen fest pro Block + Stufe; die App setzt sie nach der
// Generierung selbst in die harten Rad-Einheiten ein (wie applyWorkoutRotation()).

export type CyclingPhase = 'readaptation' | 'base' | 'race' | 'taper'

const BLOCK_START: Record<CyclingPhase, number> = { readaptation: 30, base: 18, race: 8, taper: 1 }
const DELOAD_FACTOR = 0.7
const TAPER_FACTOR = [0.45, 0.6] // Index = Wochen bis Event (Bosquet 2007: −41–60 %)

/** Wochen bis zum Event ab dem Montag der Planwoche (Eventwoche = 0) — fürs Rad die
 *  maßgebliche Zählung für Phase, Entlastung und Stufe. */
export function weeksUntilEventFrom(eventDate: string, monday: Date): number {
  const [y, m, d] = eventDate.split('-').map(Number)
  return Math.max(0, Math.floor((new Date(y, m - 1, d).getTime() - monday.getTime()) / (7 * 86400000)))
}

export function cyclingPhaseFor(weeksUntilEvent: number): CyclingPhase {
  return weeksUntilEvent >= 19 ? 'readaptation' : weeksUntilEvent >= 9 ? 'base' : weeksUntilEvent >= 2 ? 'race' : 'taper'
}

function isDeloadSlot(weeksUntilEvent: number): boolean {
  const k = weeksUntilEvent - 2
  return k >= 0 && k % 4 === 3
}

type Prescription = { label: string; zone: CyclingZone; steps: Omit<MainSetItem, 'zone' | 'low' | 'high'>[] }

const S = (reps: number, minutes: number, rest_min: number) => ({ reps, minutes, rest_min })

// Pro Block die harten Einheiten der Woche (in dieser Reihenfolge auf die harten
// Rad-Tage verteilt) mit ihren Steigerungsstufen
const BLOCK_SESSIONS: Record<CyclingPhase, Prescription[]> = {
  readaptation: [
    { label: 'Sweet Spot', zone: 'SS', steps: [S(2, 15, 5), S(3, 12, 5), S(3, 15, 5), S(2, 20, 5), S(3, 20, 5)] },
  ],
  base: [
    { label: 'Schwelle', zone: 'Z4', steps: [S(3, 10, 5), S(3, 12, 5), S(2, 20, 10), S(3, 15, 5), S(2, 25, 10)] },
    { label: 'VO2max', zone: 'Z5', steps: [S(4, 4, 4), S(5, 4, 4), S(4, 5, 5), S(5, 5, 5), S(4, 6, 6), S(4, 8, 8)] },
  ],
  race: [
    { label: 'Kletterintervalle', zone: 'Z4', steps: [S(3, 8, 5), S(4, 10, 5), S(3, 15, 5), S(3, 20, 5)] },
    { label: 'VO2max (Erhalt)', zone: 'Z5', steps: [S(4, 5, 5)] },
  ],
  taper: [
    { label: 'kurze VO2max-Reize', zone: 'Z5', steps: [S(3, 3, 3)] },
  ],
}

export type CyclingBlockWeek = {
  phase: CyclingPhase
  weeksUntilEvent: number
  deload: boolean
  sessions: { label: string; item: MainSetItem }[]
  volumeFactor: number
}

/** loadedWeeks: Wochen (als "Wochen bis Event"), in denen wirklich trainiert wurde
 *  (siehe loadedWeeksFromRides). Die Stufe steigt nur mit absolvierten Belastungswochen,
 *  und eine Entlastungswoche gibt es nur nach 3 absolvierten Wochen — sonst gibt es
 *  nichts zu entlasten. null (keine Wochenstunden im Profil): rein kalendarisch. */
export function cyclingBlockWeek(weeksUntilEvent: number, loadedWeeks: Set<number> | null): CyclingBlockWeek {
  const phase = cyclingPhaseFor(weeksUntilEvent)
  const loaded = (w: number) => loadedWeeks == null || loadedWeeks.has(w)
  const recentlyLoaded = [1, 2, 3].every(i => loaded(weeksUntilEvent + i))
  const deload = phase !== 'taper' && isDeloadSlot(weeksUntilEvent) && recentlyLoaded

  // Stufe = absolvierte Belastungswochen seit Blockbeginn; Entlastungs-Slots zählen nicht
  let step = 0
  for (let w = BLOCK_START[phase]; w > weeksUntilEvent; w--) if (!isDeloadSlot(w) && loaded(w)) step++

  const prescriptions = deload ? BLOCK_SESSIONS[phase].slice(0, 1) : BLOCK_SESSIONS[phase]
  const sessions = prescriptions.map(p => {
    const s = p.steps[deload ? 0 : Math.min(step, p.steps.length - 1)]
    return { label: p.label, item: { ...s, zone: p.zone } }
  })
  const volumeFactor = phase === 'taper' ? TAPER_FACTOR[weeksUntilEvent] ?? 0.6 : deload ? DELOAD_FACTOR : 1
  return { phase, weeksUntilEvent, deload, sessions, volumeFactor }
}

/** Gruppiert Radfahrten nach Woche ("Wochen bis Event") und liefert die Wochen mit
 *  ≥ 70 % der Profil-Stunden. */
export function loadedWeeksFromRides(
  rides: { date: string; duration_s: number | null }[],
  eventDate: string,
  hoursPerWeek: number,
): Set<number> {
  const minutes = new Map<number, number>()
  for (const r of rides) {
    const d = new Date(r.date)
    const day = (d.getDay() + 6) % 7
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
    const w = weeksUntilEventFrom(eventDate, monday)
    minutes.set(w, (minutes.get(w) ?? 0) + (r.duration_s ?? 0) / 60)
  }
  return new Set([...minutes].filter(([, min]) => min >= 0.7 * hoursPerWeek * 60).map(([w]) => w))
}

/** Harte Einheiten auf die verfügbaren Radtage begrenzen — ein Tag bleibt immer für
 *  die lange Ausfahrt (bei 2 Radtagen also nur die erste harte Einheit). */
export function fitBlockToRideDays(week: CyclingBlockWeek, rideDays: number): CyclingBlockWeek {
  return { ...week, sessions: week.sessions.slice(0, Math.max(1, rideDays - 1)) }
}

export function buildCyclingBlockRules(week: CyclingBlockWeek, rideDays: number): string {
  const easy = rideDays - 1 - week.sessions.length
  const lines = week.sessions.map((s, i) =>
    `- Harte Einheit ${i + 1}: ${s.label} — ${s.item.reps} × ${s.item.minutes} Min ${s.item.zone}, Pause ${s.item.rest_min} Min (intensity "${s.item.zone} ${s.label}")`)
  const note = week.phase === 'taper'
    ? 'TAPER-WOCHE: Umfang deutlich reduziert, die kurzen harten Reize bleiben (nicht streichen).'
    : week.deload
      ? 'ENTLASTUNGSWOCHE: ca. 30 % weniger Umfang, nur EINE harte Einheit auf der niedrigsten Stufe.'
      : 'Belastungswoche.'
  return `
RAD-BLOCKPLAN (fest, von der App berechnet — ${week.weeksUntilEvent} Wochen bis zum Event):
${note}
Die ${rideDays} Rad-Tage dieser Woche sind GENAU: 1× lange Ausfahrt (Z2, Sa/So) + ${week.sessions.length}× harte Einheit${easy > 0 ? ` + ${easy}× lockere Fahrt (Z1/Z2)` : ' (keine weitere lockere Fahrt)'} — keine weiteren Rad-Tage.
Harte Einheiten, in dieser Reihenfolge über die Woche verteilt:
${lines.join('\n')}
Übernimm Zone und Intervallstruktur exakt als "main_set" — die App setzt sie nach der Generierung ohnehin fest ein.
`
}

/** Setzt die fest vorgegebenen Intervalle der Reihe nach in die harten Rad-Tage ein
 *  (Claude legt nur fest, AN WELCHEN Tagen). Watt berechnet danach applyCyclingPower(). */
export function applyCyclingBlock(planJson: PlanJson, week: CyclingBlockWeek): PlanJson {
  const order = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
  const days = { ...planJson.days }
  const hardKeys = order.filter(k => days[k] && isCyclingDay(days[k]) && isHardRide(days[k]))
  hardKeys.slice(0, week.sessions.length).forEach((k, i) => {
    const { label, item } = week.sessions[i]
    days[k] = { ...days[k], intensity: `${item.zone} ${label}`, main_set: [item] }
  })
  return { ...planJson, days }
}
