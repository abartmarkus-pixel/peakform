// Reine ICS-Generierungslogik (kein Framework-Import), damit sie sowohl von der
// Vercel-Function (api/calendar/[athleteId].ts) als auch von der Vite-Dev-Middleware
// (vite.config.ts) unverändert genutzt werden kann.

const WEEKDAY_ORDER = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const REST_KEYWORDS = ['ruhetag', 'erholung', 'regeneration']
const RUN_KEYWORDS = ['run', 'laufen', 'running']
const RIDE_KEYWORDS = ['ride', 'radfahren', 'cycling']
const KRAFT_KEYWORDS = ['kraft', 'weighttraining', 'krafttraining']

type DayPlan = {
  type: string
  duration_min?: number
  distance_km?: number
  intensity?: string
  description?: string
}

export type WeeklyPlanRow = {
  week_start: string // 'YYYY-MM-DD'
  plan_json: { days?: Record<string, DayPlan> } | null
}

// Reine UTC-Datumsarithmetik (kein new Date(y,m,d) in Lokalzeit) — die Vercel-Function
// läuft in UTC, aber selbst wenn nicht: Date.UTC() ist unabhängig von der Prozess-Timezone.
function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const yyyy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} Min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h} Std ${m} Min` : `${h} Std`
}

// RFC 5545 TEXT-Escaping: Backslash, Komma, Semikolon, Zeilenumbruch.
function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function classify(type: string): 'rest' | 'run' | 'ride' | 'kraft' | 'other' {
  const t = type.toLowerCase()
  if (REST_KEYWORDS.some(k => t.includes(k))) return 'rest'
  if (RUN_KEYWORDS.some(k => t.includes(k))) return 'run'
  if (RIDE_KEYWORDS.some(k => t.includes(k))) return 'ride'
  if (KRAFT_KEYWORDS.some(k => t.includes(k))) return 'kraft'
  return 'other'
}

// Kraft-description ist immer nur "Workout I/II/III" (kurz) — direkt als Titel geeignet.
// Lauf/Rad-description ist dagegen ein freier Coaching-Fließtext, der als Kalendertitel
// unlesbar lang wäre; dort bleibt der Titel kurz und der Text wandert in DESCRIPTION.
function buildSummary(day: DayPlan): string {
  const kind = classify(day.type)
  const duration = day.duration_min ? ` · ${formatDuration(day.duration_min)}` : ''
  if (kind === 'kraft') return `💪🍑 ${day.description || 'Workout'}`
  if (kind === 'run') return `🏃 Laufen${duration}`
  if (kind === 'ride') return `🚴 Radfahren${duration}`
  return `🏋️ ${day.type}${duration}`
}

function buildDescription(day: DayPlan): string {
  const kind = classify(day.type)
  const parts: string[] = []
  if (kind === 'run' || kind === 'ride' || kind === 'other') {
    if (day.description) parts.push(day.description)
  }
  if (kind !== 'run' && kind !== 'ride' && day.duration_min) parts.push(formatDuration(day.duration_min))
  if (day.distance_km) parts.push(`${day.distance_km} km`)
  if (day.intensity) parts.push(day.intensity)
  return parts.join(' · ')
}

export function buildIcsFeed(athleteId: string, plans: WeeklyPlanRow[]): string {
  const now = new Date()
  const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

  const events: string[] = []

  for (const plan of plans) {
    const days = plan.plan_json?.days
    if (!days) continue

    for (const [label, day] of Object.entries(days)) {
      const offset = WEEKDAY_ORDER.indexOf(label)
      if (offset === -1 || !day?.type) continue
      if (classify(day.type) === 'rest') continue

      const dtstart = addDaysToDateStr(plan.week_start, offset)
      const dtend = addDaysToDateStr(plan.week_start, offset + 1)
      const uid = `${athleteId}-${plan.week_start}-${label}@peakform.app`

      events.push(
        [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART;VALUE=DATE:${dtstart}`,
          `DTEND;VALUE=DATE:${dtend}`,
          `SUMMARY:${escapeIcsText(buildSummary(day))}`,
          `DESCRIPTION:${escapeIcsText(buildDescription(day))}`,
          'END:VEVENT',
        ].join('\r\n'),
      )
    }
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PeakForm//Wochenplan//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:PeakForm Trainingsplan',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n'
}
