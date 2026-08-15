// ISO 8601: Woche beginnt Montag, Sonntag ist letzter Tag

export function getISOMonday(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=So, 1=Mo, ..., 6=Sa
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

export function getISOSunday(monday: Date): Date {
  const d = new Date(monday)
  d.setDate(d.getDate() + 6)
  d.setHours(23, 59, 59, 999)
  return d
}

export function formatWeekRange(monday: Date): string {
  const sunday = getISOSunday(monday)
  const fmt = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.`
  const year = sunday.getFullYear()
  return `${fmt(monday)} – ${fmt(sunday)}${year}`
}

/** Formats a Date als "YYYY-MM-DD" in Lokalzeit (nicht toISOString().slice(0,10),
 *  das UTC nimmt und in CET/CEST einen Tag zu früh liegen kann). */
export function toDateStr(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Neues Date, `days` Tage versetzt (via setDate, nicht ms-Arithmetik — bleibt
 *  über DST-Wechsel hinweg auf demselben Kalendertag statt um eine Stunde zu driften). */
export function addDays(d: Date, days: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + days)
  return copy
}

const WEEKDAY_LABELS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

/** Formats a Date/ISO-Timestamp als "TT.MM.JJJJ" in Lokalzeit (nicht UTC-slice). */
export function toLocalDateStr(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`
}

/** Formats a Date/ISO-Timestamp als "Di 30.6.2026" — Wochentag-Kürzel + Lokaldatum. */
export function toLocalWeekdayDateStr(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${WEEKDAY_LABELS_DE[d.getDay()]} ${toLocalDateStr(d)}`
}

/** Gibt das Mo/Di/.../So-Kürzel zurück, unter dem dieses Datum als Key in
 *  PlanJson.days steht (siehe weeklyPlan.ts). */
export function dayLabelForDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return WEEKDAY_LABELS_DE[d.getDay()]
}

/** Formats a Date/ISO-Timestamp als "Di 30.6.2026, 18:08 Uhr" — Wochentag + Lokaldatum + Uhrzeit. */
export function toLocalWeekdayDateTimeStr(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${toLocalWeekdayDateStr(d)}, ${hh}:${mm} Uhr`
}

/** Formats Sekunden als "42 min" (< 60 min) oder "1 Std 30 Min" (≥ 60 min) statt roher Minutenzahl
 *  (z.B. "386 Minuten" bei mehrstündigen Aktivitäten) — für Prompt-Text und UI-Anzeige. */
export function formatDurationHuman(seconds: number): string {
  const totalMin = Math.round(seconds / 60)
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m > 0 ? `${h} Std ${m} Min` : `${h} Std`
}

/** Formatiert Sekunden als Ziel-/Wettkampfzeit: "h:mm:ss" ab 1 Std, sonst "mm:ss". */
export function formatRaceTime(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

/** Gibt eine explizite Tag-Relation zu heute zurück ("heute" | "gestern" | "vor X Tagen" | "morgen" | "in X Tagen"),
 *  damit Claude Datumsdifferenzen nicht selbst berechnen (und dabei erfinden) muss. */
export function relativeDayLabel(date: Date | string): string {
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000)
  if (diffDays === 0) return 'heute'
  if (diffDays === 1) return 'gestern'
  if (diffDays > 1) return `vor ${diffDays} Tagen`
  return diffDays === -1 ? 'morgen' : `in ${-diffDays} Tagen`
}
