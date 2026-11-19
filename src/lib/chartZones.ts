// Farbige Zonen-Bänder für die HF-/Watt-Diagramme in ActivityDetail.tsx (nur Rad).
// Grenzen kommen aus denselben Quellen wie Plan/Coach: calculateHRZoneBounds() (HF)
// und POWER_ZONES (Watt, Coggan, % FTP) — keine eigene Zonenlogik.
import { POWER_ZONES, type CyclingZone, type HRZoneBounds } from './cyclingPower'

export type ZoneBand = { label: string; low: number; high: number; color: string }

const ZONE_COLORS = ['#94a3b8', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444']

/** HF-Zonen Z1–Z5; Z5 nach oben offen (Infinity, wird beim Zeichnen auf die Achse begrenzt). */
export function hrZoneBands(b: HRZoneBounds): ZoneBand[] {
  const lows = [b[1], b[2], b[3], b[4], b[5]]
  return lows.map((low, i) => ({
    label: `Z${i + 1}`,
    low,
    high: i < 4 ? lows[i + 1] : Infinity,
    color: ZONE_COLORS[i],
  }))
}

/** Watt-Zonen Z1–Z6 aus FTP; Sweet Spot ausgelassen (überlappt Z3/Z4), Z6 nach oben offen. */
export function powerZoneBands(ftp: number): ZoneBand[] {
  const zones: CyclingZone[] = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6']
  return zones.map((z, i) => ({
    label: z,
    low: i === 0 ? 0 : Math.round(POWER_ZONES[z].low * ftp),
    high: i < zones.length - 1 ? Math.round(POWER_ZONES[zones[i + 1]].low * ftp) : Infinity,
    color: ZONE_COLORS[i],
  }))
}

/** Achsenbereich aus den Daten (mit etwas Luft), damit die Bänder die Achse nicht aufblähen. */
export function dataDomain(values: number[], pad: number, floorZero = false): [number, number] {
  if (values.length === 0) return [0, 1]
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const lo = floorZero ? 0 : Math.max(0, Math.floor(min - pad))
  return [lo, Math.ceil(max + pad)]
}
