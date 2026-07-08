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

/** Formats a Date/ISO-Timestamp als "Di 30.6.2026, 18:08 Uhr" — Wochentag + Lokaldatum + Uhrzeit. */
export function toLocalWeekdayDateTimeStr(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${toLocalWeekdayDateStr(d)}, ${hh}:${mm} Uhr`
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
