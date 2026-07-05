import { supabase, type Activity, type SportConfig, type EquipmentConfig, type AestheticGoals } from './supabase'
import { getISOMonday, toLocalDateStr, toLocalWeekdayDateStr } from './dateUtils'

const WEEKDAY_ORDER = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

/** Ergänzt die Mo–So-Tageskürzel im plan_json.days-Objekt um das jeweilige Kalenderdatum,
 *  damit Claude Wochentag↔Datum nicht selbst umrechnen muss. */
export function planJsonWithDates(planJson: unknown, monday: Date): unknown {
  if (!planJson || typeof planJson !== 'object') return planJson
  const pj = planJson as Record<string, unknown>
  const days = pj.days as Record<string, unknown> | undefined
  if (!days || typeof days !== 'object') return planJson

  const datedDays: Record<string, unknown> = {}
  for (const [label, value] of Object.entries(days)) {
    const idx = WEEKDAY_ORDER.indexOf(label)
    if (idx === -1) {
      datedDays[label] = value
      continue
    }
    const d = new Date(monday)
    d.setDate(d.getDate() + idx)
    datedDays[`${label} ${toLocalDateStr(d)}`] = value
  }
  return { ...pj, days: datedDays }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Returns the local YYYY-MM-DD string for the Monday of the given date. */
function mondayOf(date: Date): string {
  const d = getISOMonday(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Returns a human-readable countdown string (e.g. "17 Wochen 3 Tage"). */
function countdown(dateStr: string): string {
  const totalDays = Math.ceil((new Date(dateStr).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  if (totalDays <= 0) return 'vergangen'
  return `${totalDays} ${totalDays === 1 ? 'Tag' : 'Tage'}`
}

function fmt(n: number | null | undefined, decimals = 0): string {
  return n != null ? n.toFixed(decimals) : '—'
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

// ── exported coach-prompt helpers ─────────────────────────────────────────

type PhaseResult = { phase: string; label: string; description: string }

const PHASE_LABELS: Record<string, PhaseResult> = {
  readaptation: {
    phase: 'readaptation',
    label: 'Phase 1 — Readaptation',
    description: 'Sehnen, Gelenke und Laufmuskulatur readaptieren',
  },
  base: {
    phase: 'base',
    label: 'Phase 2 — Grundlagenaufbau',
    description: 'Kilometerzahl aufbauen, aerobe Effizienz verbessern',
  },
  race: {
    phase: 'race',
    label: 'Phase 3 — Wettkampfvorbereitung',
    description: 'Wettkampfspezifisches Training, Zieltempo',
  },
  taper: {
    phase: 'taper',
    label: 'Phase 4 — Taper',
    description: 'Frische aufbauen, Wettkampfbereitschaft maximieren',
  },
}

/** Bestimmt die aktuelle Saison-Phase aus Wochen bis A-Event oder manuellem Override. */
export function calculateSeasonPhase(
  weeksUntilEvent: number,
  override: string | null,
): PhaseResult {
  if (override && PHASE_LABELS[override]) return PHASE_LABELS[override]
  if (weeksUntilEvent >= 10) return PHASE_LABELS.readaptation
  if (weeksUntilEvent >= 6)  return PHASE_LABELS.base
  if (weeksUntilEvent >= 2)  return PHASE_LABELS.race
  return PHASE_LABELS.taper
}

/** Berechnet die Z2-HF-Grenzen als Zahlen. Karvonen-Methode wenn restingHR vorhanden. */
export function calculateZ2HRRange(maxHR: number, restingHR?: number | null): { min: number; max: number } {
  if (restingHR) {
    const hrr = maxHR - restingHR
    return { min: Math.round(hrr * 0.60 + restingHR), max: Math.round(hrr * 0.75 + restingHR) }
  }
  return { min: Math.round(maxHR * 0.70), max: Math.round(maxHR * 0.81) }
}

/** Berechnet HF-Zonen-Text aus Max HF. Karvonen-Methode wenn restingHR vorhanden. */
export function calculateHRZones(maxHR: number, restingHR?: number | null): string {
  const z2 = calculateZ2HRRange(maxHR, restingHR)
  if (restingHR) {
    const hrr = maxHR - restingHR
    return [
      `Z1 Regeneration:    < ${z2.min} bpm`,
      `Z2 Grundlage:       ${z2.min}–${z2.max} bpm`,
      `Z3 Tempo:           ${z2.max}–${Math.round(hrr * 0.85 + restingHR)} bpm`,
      `Z4 Schwelle:        ${Math.round(hrr * 0.85 + restingHR)}–${Math.round(hrr * 0.92 + restingHR)} bpm`,
      `Z5 VO2max:          > ${Math.round(hrr * 0.92 + restingHR)} bpm`,
      `(Karvonen-Methode, Ruhe-HF ${restingHR} bpm)`,
    ].join('\n')
  }
  return [
    `Z1 Regeneration:    < ${z2.min} bpm`,
    `Z2 Grundlage:       ${z2.min}–${z2.max} bpm`,
    `Z3 Tempo:           ${z2.max}–${Math.round(maxHR * 0.90)} bpm`,
    `Z4 Schwelle:        ${Math.round(maxHR * 0.90)}–${Math.round(maxHR * 0.96)} bpm`,
    `Z5 VO2max:          > ${Math.round(maxHR * 0.96)} bpm`,
  ].join('\n')
}

/**
 * Berechnet die tatsächliche Z2-Pace aus echten Läufen mit HF im Z2-Bereich —
 * distanzgewichteter Durchschnitt (nicht Mittelwert der Einzel-Paces), damit
 * längere Läufe stärker einfließen. Mindestens 3 qualifizierende Läufe nötig,
 * sonst Fallback auf die formelbasierte Berechnung (siehe calculatePaceReference()).
 */
export function calculateDynamicZ2Pace(
  runningActivities: Activity[],
  hrZoneMin: number,
  hrZoneMax: number,
): { paceSecPerKm: number; basedOnRuns: number } | null {
  const qualifying = runningActivities
    .filter(a => a.avg_hr != null && a.avg_hr <= hrZoneMax + 3 && a.avg_hr >= hrZoneMin - 5)
    .filter(a => a.distance_m && a.duration_s)
    .slice(0, 8)

  if (qualifying.length < 3) return null

  const totalDistanceKm = qualifying.reduce((sum, a) => sum + a.distance_m! / 1000, 0)
  const totalDurationSec = qualifying.reduce((sum, a) => sum + a.duration_s!, 0)
  const paceSecPerKm = totalDurationSec / totalDistanceKm

  return { paceSecPerKm, basedOnRuns: qualifying.length }
}

/**
 * Berechnet Pace-Referenz aus 5k-Bestzeit (Sekunden) und Event-Distanz (km).
 * Zielpace und Schwellenpace sind Zielwerte für ein zukünftiges Event und
 * bleiben immer formelbasiert aus der 5k-PB. Die Z2-Trainingspace nutzt
 * stattdessen `dynamicZ2` (aus `calculateDynamicZ2Pace()`), sobald genug
 * echte Läufe vorliegen — sonst Fallback auf dieselbe Formel wie bisher.
 */
export function calculatePaceReference(
  best5kSeconds: number | null,
  targetEventKm: number,
  dynamicZ2?: { paceSecPerKm: number; basedOnRuns: number } | null,
): string {
  if (!best5kSeconds) return 'Noch keine 5k Bestzeit hinterlegt.'
  const pacePerKm = best5kSeconds / 5
  const formatPace = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

  const z2Line = dynamicZ2
    ? `Z2 Trainingspace:   ${formatPace(dynamicZ2.paceSecPerKm - 15)}–${formatPace(dynamicZ2.paceSecPerKm + 15)} min/km (aus deinen letzten ${dynamicZ2.basedOnRuns} Läufen berechnet, nicht aus 5k-PB geschätzt)`
    : `Z2 Trainingspace:   ${formatPace(Math.round(pacePerKm * 1.15))}–${formatPace(Math.round(pacePerKm * 1.30))} min/km (deutlich langsamer als gefühlt nötig)`

  return [
    `Zielpace ${targetEventKm}k:    ${formatPace(Math.round(pacePerKm * 0.98))}–${formatPace(Math.round(pacePerKm * 1.05))} min/km`,
    z2Line,
    `Schwellenpace:      ${formatPace(Math.round(pacePerKm * 0.92))}–${formatPace(Math.round(pacePerKm * 0.97))} min/km`,
  ].join('\n')
}

// ── main ───────────────────────────────────────────────────────────────────

/**
 * Builds a structured context brief for every Claude call.
 * Always the same 7-section structure, always under ~3 000 tokens.
 * Never includes raw stream data.
 */
export async function buildCoachContext(
  athleteId: string,
  threadId?: string,
  activeSport?: 'running' | 'cycling' | 'strength' | null,
): Promise<string> {
  const mondayDate = getISOMonday(new Date())
  const thisWeek = mondayOf(new Date())
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString()

  // Fetch all data in parallel
  const [
    { data: athlete },
    { data: goals },
    { data: currentPlanRows },
    { data: recentActs },
    { data: planHistory },
    { data: decisions },
    { data: chatRows },
    { data: lastAnalysisRows },
  ] = await Promise.all([
    supabase
      .from('athletes')
      .select('name, ftp_watts, max_hr, weight_kg, training_days_per_week, sport_types, coach_persona, body_goals')
      .eq('id', athleteId)
      .single(),

    supabase
      .from('season_goals')
      .select('event_name, event_date, distance_km, elevation_m, priority, sport_type, notes')
      .eq('athlete_id', athleteId)
      .eq('active', true)
      .order('event_date', { ascending: true }),

    supabase
      .from('weekly_plans')
      .select('version, plan_json, review_notes, created_at')
      .eq('athlete_id', athleteId)
      .eq('week_start', thisWeek)
      .order('version', { ascending: false })
      .limit(1),

    supabase
      .from('activities')
      .select('date, distance_m, duration_s, avg_hr, np_watts, tss')
      .eq('athlete_id', athleteId)
      .gte('date', fourWeeksAgo)
      .order('date', { ascending: true }),

    supabase
      .from('weekly_plans')
      .select('week_start, version, change_reason, plan_json, review_notes, created_at')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(6),

    supabase
      .from('coach_decisions')
      .select('decision_type, decision_summary, reasoning, created_at, related_activity_id')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(5),

    threadId
      ? supabase
          .from('chat_messages')
          .select('role, content')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),

    supabase
      .from('activities')
      .select('name, date, type, claude_analysis')
      .eq('athlete_id', athleteId)
      .not('claude_analysis', 'is', null)
      .order('date', { ascending: false })
      .limit(1),
  ])

  const sections: string[] = []

  // ── 1. ATHLETEN-PROFIL (~200 tokens) ──────────────────────────────────
  const sportLabels: Record<string, string> = {
    cycling: 'Radfahren', running: 'Laufen', strength: 'Kraft',
  }
  const sportStr = (athlete?.sport_types as SportConfig[] | null)
    ?.map(s => `${sportLabels[s.type] ?? s.type} (${s.days} Tage/Woche)`)
    .join(', ') ?? '—'

  // FTP ist eine Rad-Leistungskennzahl — bei Lauf-/Kraft-fokussierten Analysen
  // gehört sie nicht in den Kontext (kontextuelle Blindheit, siehe LAUF_COACH_PROMPT).
  const showCyclingPower = activeSport === 'cycling' || activeSport == null

  sections.push([
    '[ATHLETEN-PROFIL]',
    athlete?.name ? `Name: ${athlete.name}` : null,
    showCyclingPower ? `FTP: ${fmt(athlete?.ftp_watts)} W` : null,
    `Max HF: ${fmt(athlete?.max_hr)} bpm`,
    `Gewicht: ${fmt(athlete?.weight_kg, 1)} kg`,
    `Trainingstage/Woche: ${athlete?.training_days_per_week ?? '—'}`,
    `Sportarten: ${sportStr}`,
    `Ziele: ${(athlete as { body_goals?: string[] } | null)?.body_goals?.join(', ') ?? '—'}`,
    athlete?.coach_persona
      ? `Coach-Persona: ${JSON.stringify(athlete.coach_persona)}`
      : null,
  ].filter(Boolean).join('\n'))

  // ── 1b. HARTE TRAININGS-CONSTRAINTS ───────────────────────────────────
  const configuredSports = (athlete?.sport_types as SportConfig[] | null) ?? []
  const totalTrainingDays = athlete?.training_days_per_week ?? 0
  const calendarRestDays = 7 - totalTrainingDays
  const sportConstraintLines = configuredSports.length
    ? configuredSports.map(s => {
        const label = sportLabels[s.type] ?? s.type
        return `- ${label}: ${s.days} ${s.days === 1 ? 'Tag' : 'Tage'}/Woche`
      }).join('\n')
    : '- Keine Sportarten konfiguriert'

  sections.push([
    '[HARTE TRAININGS-CONSTRAINTS — MÜSSEN EINGEHALTEN WERDEN]',
    `Gesamte Trainingstage diese Woche: ${totalTrainingDays} (von 7 Wochentagen)`,
    `Ruhetage: ${calendarRestDays}`,
    '',
    'Pflicht-Verteilung pro Sportart:',
    sportConstraintLines,
    '',
    'Diese Constraints sind nicht verhandelbar. Der Plan MUSS exakt die angegebene Gesamtzahl an Trainingstagen enthalten.',
  ].join('\n'))

  // ── 2. SAISON-ZIELE (~300 tokens) ─────────────────────────────────────
  const nextA = goals?.find(g => g.priority === 'A')
  const aCountdown = nextA
    ? `\nNächstes A-Event in ${countdown(nextA.event_date)}: ${nextA.event_name} (${nextA.event_date})`
    : ''

  const goalLines = goals?.length
    ? goals.map(g =>
        `[${g.priority}] ${g.event_name} — ${g.event_date}` +
        (g.distance_km ? ` | ${g.distance_km} km` : '') +
        (g.elevation_m ? ` | ${g.elevation_m} hm` : '') +
        (g.sport_type  ? ` | ${g.sport_type}` : '') +
        (g.notes       ? `\n    ${g.notes}` : '')
      ).join('\n')
    : 'Keine aktiven Ziele.'

  sections.push(`[SAISON-ZIELE]${aCountdown}\n${goalLines}`)

  // ── 3. AKTUELLER WOCHENPLAN (~400 tokens) ─────────────────────────────
  const currentPlan = currentPlanRows?.[0] ?? null
  const planBody = currentPlan
    ? JSON.stringify(planJsonWithDates(currentPlan.plan_json, mondayDate), null, 2)
    : 'Kein Wochenplan vorhanden.'

  const reviewNote = currentPlan?.review_notes
    ? `\nReview der Vorwoche:\n${currentPlan.review_notes}`
    : ''

  sections.push(
    `[AKTUELLER WOCHENPLAN]\nWoche: ${thisWeek}${currentPlan ? ` | Version ${currentPlan.version}` : ' | Noch kein Plan'}${reviewNote}\n${planBody}`
  )

  // ── 3b. LETZTE AKTIVITÄTS-ANALYSE ─────────────────────────────────────
  const lastAct = lastAnalysisRows?.[0] ?? null
  if (lastAct?.claude_analysis) {
    sections.push([
      '[LETZTE AKTIVITÄTS-ANALYSE]',
      `${lastAct.name} (${toLocalDateStr(lastAct.date)}, ${lastAct.type}):`,
      lastAct.claude_analysis,
      '→ Diese Analyse MUSS bei der Wochenplanung berücksichtigt werden.',
    ].join('\n'))
  }

  // ── 4. TRAININGSHISTORIE — LETZTE 4 WOCHEN (~600 tokens) ──────────────
  type WeekBucket = {
    count: number; distKm: number; durH: number
    tss: number; hrArr: number[]; npArr: number[]
  }
  const buckets = new Map<string, WeekBucket>()

  for (const a of recentActs ?? []) {
    const wk = mondayOf(new Date(a.date))
    if (!buckets.has(wk)) buckets.set(wk, { count: 0, distKm: 0, durH: 0, tss: 0, hrArr: [], npArr: [] })
    const b = buckets.get(wk)!
    b.count++
    b.distKm += (a.distance_m ?? 0) / 1000
    b.durH   += (a.duration_s ?? 0) / 3600
    b.tss    += a.tss ?? 0
    if (a.avg_hr)   b.hrArr.push(a.avg_hr)
    if (a.np_watts) b.npArr.push(a.np_watts)
  }

  const historyLines = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([wk, b]) => {
      const meanHr = b.hrArr.length ? Math.round(avg(b.hrArr)) : null
      const maxNp  = b.npArr.length ? Math.round(Math.max(...b.npArr)) : null
      return `KW ${wk}: ${b.count} Einheiten | ${b.distKm.toFixed(1)} km | ${b.durH.toFixed(1)} h` +
        (b.tss    ? ` | TSS ${b.tss.toFixed(0)}` : '') +
        (meanHr   ? ` | Ø HF ${meanHr} bpm` : '') +
        (maxNp    ? ` | NP max ${maxNp} W` : '')
    })

  sections.push(
    `[TRAININGSHISTORIE — LETZTE 4 WOCHEN]\n${historyLines.length ? historyLines.join('\n') : 'Keine Aktivitäten.'}`
  )

  // ── 5. PLAN-HISTORY — LETZTE 3 VERSIONEN (~300 tokens) ────────────────
  const olderPlans = (planHistory ?? [])
    .filter(p => !(p.week_start === thisWeek && p.version === currentPlan?.version))
    .slice(0, 3)

  const planHistLines = olderPlans.map(p => {
    const pj = p.plan_json as Record<string, unknown>
    const summary = typeof pj?.summary === 'string' ? pj.summary : `${Object.keys(pj ?? {}).length} Tage`
    return `KW ${p.week_start} v${p.version}: ${p.change_reason ?? 'Erstplan'} — ${summary}` +
      (p.review_notes ? `\n  → Review: ${String(p.review_notes).slice(0, 250)}` : '')
  })

  sections.push(
    `[PLAN-HISTORY — LETZTE 3 VERSIONEN]\n${planHistLines.length ? planHistLines.join('\n') : 'Keine früheren Pläne.'}`
  )

  // ── 6. COACH-ENTSCHEIDUNGEN — LETZTE 5 (~300 tokens) ──────────────────
  // related_activity_id-Datum separat auflösen: created_at ist der Logging-/
  // Eingabe-Zeitpunkt (z. B. Mid-Week-Feedback oft erst am Folgetag erfasst),
  // nicht das Datum der Aktivität selbst — beide dürfen nicht verwechselt werden.
  const decisionActivityIds = [...new Set(
    (decisions ?? []).map(d => d.related_activity_id).filter((v): v is string => !!v)
  )]
  const { data: decisionActivities } = decisionActivityIds.length
    ? await supabase.from('activities').select('id, name, date').in('id', decisionActivityIds)
    : { data: [] as { id: string; name: string; date: string }[] }
  const activityById = new Map((decisionActivities ?? []).map(a => [a.id, a]))

  const decisionLines = (decisions ?? []).map(d => {
    const relatedAct = d.related_activity_id ? activityById.get(d.related_activity_id) : null
    const header = relatedAct
      ? `[${d.decision_type} zu ${relatedAct.name}, ${toLocalWeekdayDateStr(relatedAct.date)} — eingegeben am ${toLocalDateStr(d.created_at)}]`
      : `[${d.decision_type}] ${toLocalDateStr(d.created_at)}`
    return `${header}: ${d.decision_summary}` + (d.reasoning ? `\n  → ${d.reasoning}` : '')
  })

  sections.push(
    `[COACH-ENTSCHEIDUNGEN — LETZTE 5]\n${decisionLines.length ? decisionLines.join('\n') : 'Keine Entscheidungen geloggt.'}`
  )

  // ── 7. AKTUELLE CHAT-SESSION (~500 tokens) ─────────────────────────────
  const chatLines = (chatRows ?? [])
    .slice()
    .reverse()
    .map(m => `${m.role === 'user' ? (athlete?.name ?? 'Athlet') : 'Coach'}: ${m.content}`)

  sections.push(
    `[AKTUELLE CHAT-SESSION]\n${chatLines.length ? chatLines.join('\n') : 'Neue Session.'}`
  )

  return sections.join('\n\n')
}

// ── specialist context ─────────────────────────────────────────────────────

/**
 * Builds a sport-specific context for the specialist coach overlay.
 * Fetches only the data relevant to the given sport type.
 * Always appended to the general buildCoachContext() output, never standalone.
 */
export async function buildSpecialistContext(
  athleteId: string,
  sport: 'running' | 'cycling' | 'strength',
): Promise<string> {
  const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  // ── Running ───────────────────────────────────────────────────────────────
  if (sport === 'running') {
    const { data: acts } = await supabase
      .from('activities')
      .select('date, distance_m, duration_s, avg_hr')
      .eq('athlete_id', athleteId)
      .in('type', ['Run', 'VirtualRun', 'TrailRun'])
      .gte('date', twoMonthsAgo)
      .order('date', { ascending: false })
      .limit(10)

    const lines = (acts ?? []).map(a => {
      const distKm = a.distance_m != null ? (a.distance_m / 1000).toFixed(1) : '—'
      const paceStr = (a.distance_m && a.duration_s)
        ? (() => {
            const sPerKm = a.duration_s / (a.distance_m / 1000)
            return `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, '0')} min/km`
          })()
        : '—'
      const hr = a.avg_hr != null ? `${Math.round(a.avg_hr)} bpm` : '—'
      return `${a.date.slice(0, 10)}: ${distKm} km | ${paceStr} | Ø HF ${hr}`
    })

    return [
      '[LAUF-KONTEXT — LETZTE 10 LÄUFE]',
      lines.length ? lines.join('\n') : 'Keine Läufe in den letzten 60 Tagen.',
    ].join('\n')
  }

  // ── Cycling ───────────────────────────────────────────────────────────────
  if (sport === 'cycling') {
    const [{ data: acts }, { data: athleteRow }] = await Promise.all([
      supabase
        .from('activities')
        .select('date, distance_m, duration_s, np_watts, tss, avg_hr')
        .eq('athlete_id', athleteId)
        .in('type', ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide'])
        .gte('date', twoMonthsAgo)
        .order('date', { ascending: false })
        .limit(10),
      supabase
        .from('athletes')
        .select('ftp_watts')
        .eq('id', athleteId)
        .single(),
    ])

    const ftp = athleteRow?.ftp_watts ?? null

    const lines = (acts ?? []).map(a => {
      const distKm = a.distance_m != null ? (a.distance_m / 1000).toFixed(0) : '—'
      const np = a.np_watts != null ? `NP ${Math.round(a.np_watts)}W` : '—'
      const pct = (a.np_watts != null && ftp) ? ` (${Math.round((a.np_watts / ftp) * 100)}% FTP)` : ''
      const tss = a.tss != null ? ` | TSS ${Math.round(a.tss)}` : ''
      const hr = a.avg_hr != null ? ` | Ø ${Math.round(a.avg_hr)} bpm` : ''
      return `${a.date.slice(0, 10)}: ${distKm} km | ${np}${pct}${tss}${hr}`
    })

    return [
      '[RAD-KONTEXT — LETZTE 10 AUSFAHRTEN]',
      ftp ? `FTP: ${ftp}W` : 'FTP: nicht gesetzt',
      lines.length ? lines.join('\n') : 'Keine Ausfahrten in den letzten 60 Tagen.',
    ].join('\n')
  }

  // ── Strength ──────────────────────────────────────────────────────────────
  const [{ data: athleteRow }, { data: acts }] = await Promise.all([
    supabase
      .from('athletes')
      .select('equipment, aesthetic_goals, body_goals')
      .eq('id', athleteId)
      .single(),
    supabase
      .from('activities')
      .select('date, name, description')
      .eq('athlete_id', athleteId)
      .in('type', ['WeightTraining', 'Workout'])
      .gte('date', twoMonthsAgo)
      .order('date', { ascending: false })
      .limit(5),
  ])

  const contextLines: string[] = []

  const eq = athleteRow?.equipment as EquipmentConfig | null
  if (eq) {
    const active: string[] = []
    if (eq.gym?.active) {
      active.push('Gym (alles verfügbar)')
    } else {
      if (eq.dumbbells?.active) active.push(`Kurzhanteln bis ${eq.dumbbells.max_kg ?? '?'} kg`)
      if (eq.bands?.active)     active.push('Bänder / Tubes')
      if (eq.bodyweight?.active) active.push('Körpergewicht')
      if (eq.pullup_bar?.active) active.push('Klimmzugstange')
    }
    contextLines.push(`Equipment: ${active.length ? active.join(', ') : 'nicht konfiguriert'}`)
  }

  const ag = athleteRow?.aesthetic_goals as AestheticGoals | null
  const bodyGoals = athleteRow?.body_goals as string[] | null
  const hasAestheticGoal = bodyGoals?.includes('Muskelaufbau') || bodyGoals?.includes('Gewicht reduzieren')
  if (hasAestheticGoal && ag?.priorities?.length) {
    contextLines.push(`Körperziel-Prioritäten (1=höchste): ${ag.priorities.join(' > ')}`)
    if (ag.notes) contextLines.push(`Besonderheiten: ${ag.notes}`)
  }

  const sessionLines = (acts ?? []).map(a => {
    const snippet = a.description ? ` | ${a.description.slice(0, 200)}` : ''
    return `${a.date.slice(0, 10)}: ${a.name}${snippet}`
  })

  return [
    '[KRAFT-KONTEXT]',
    ...contextLines,
    '',
    `Letzte ${sessionLines.length} Kraft-Sessions:`,
    sessionLines.length ? sessionLines.join('\n') : 'Keine Sessions in den letzten 60 Tagen.',
  ].join('\n')
}
