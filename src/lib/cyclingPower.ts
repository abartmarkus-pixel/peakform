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

/** Prompt-Abschnitt für Plan-Generierung — Watt-Tabelle fest berechnet, damit Claude
 *  nicht selbst rechnet; Indoor/Outdoor-Standard nach Monat der Planwoche. */
export function buildCyclingPlanRules(ftp: number | null, monday: Date): string {
  // Sonntag der Woche entscheidet — die Woche, die in den November reicht, zählt schon als Winter
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const month = sunday.getMonth() + 1
  const winter = month >= 11 || month <= 2
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
