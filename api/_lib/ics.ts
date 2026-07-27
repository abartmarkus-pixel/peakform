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
function addDaysToDateStr(dateStr: string, days: number): { y: number; m: number; d: number } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function fmtDashed({ y, m, d }: { y: number; m: number; d: number }): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// longOffset (z.B. "GMT+02:00") berücksichtigt CEST/CET automatisch für das jeweilige
// Datum, analog zum bereits etablierten Pattern in api/send-daily-reminder.ts.
function viennaOffsetForDate(dashed: string): string {
  const probe = new Date(`${dashed}T12:00:00Z`)
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna', timeZoneName: 'longOffset' })
    .formatToParts(probe)
    .find(p => p.type === 'timeZoneName')?.value ?? 'GMT+02:00'
  return offsetName.replace('GMT', '')
}

function toIcsUtc(dt: Date): string {
  return dt.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}

// Montag der aktuellen Woche in Europe/Vienna (nicht Prozess-Timezone UTC), analog zu
// viennaTodayInfo() in api/send-daily-reminder.ts — sonst würde der Feed abends UTC
// bereits im Sonntag der Folgewoche stecken und die falsche Woche als "aktuell" werten.
function currentWeekStartVienna(now: Date): string {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(now)
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const diff = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay()
  const monday = new Date(Date.UTC(y, m - 1, d + diff))
  return fmtDashed({ y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() })
}

const EVENT_HOUR = 18
const EVENT_MINUTE = 30
const DEFAULT_DURATION_MIN = 60

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
  const currentWeekStart = currentWeekStartVienna(now)

  const events: string[] = []

  for (const plan of plans) {
    if (plan.week_start < currentWeekStart) continue
    const days = plan.plan_json?.days
    if (!days) continue

    for (const [label, day] of Object.entries(days)) {
      const offset = WEEKDAY_ORDER.indexOf(label)
      if (offset === -1 || !day?.type) continue
      if (classify(day.type) === 'rest') continue

      const dayDashed = fmtDashed(addDaysToDateStr(plan.week_start, offset))
      const offsetStr = viennaOffsetForDate(dayDashed)
      const startUtc = new Date(`${dayDashed}T${String(EVENT_HOUR).padStart(2, '0')}:${String(EVENT_MINUTE).padStart(2, '0')}:00${offsetStr}`)
      const durationMin = day.duration_min ?? DEFAULT_DURATION_MIN
      const endUtc = new Date(startUtc.getTime() + durationMin * 60_000)
      const uid = `${athleteId}-${plan.week_start}-${label}@peakform.app`

      events.push(
        [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART:${toIcsUtc(startUtc)}`,
          `DTEND:${toIcsUtc(endUtc)}`,
          'CATEGORIES:Sport',
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
