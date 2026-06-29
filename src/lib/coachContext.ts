import { supabase, type SportConfig } from './supabase'

// ── helpers ────────────────────────────────────────────────────────────────

/** Returns the ISO date string (YYYY-MM-DD) of the Monday of the given date. */
function mondayOf(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().slice(0, 10)
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

// ── main ───────────────────────────────────────────────────────────────────

/**
 * Builds a structured context brief for every Claude call.
 * Always the same 7-section structure, always under ~3 000 tokens.
 * Never includes raw stream data.
 */
export async function buildCoachContext(
  athleteId: string,
  threadId?: string,
): Promise<string> {
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
      .select('decision_type, decision_summary, reasoning, created_at')
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
  ])

  const sections: string[] = []

  // ── 1. ATHLETEN-PROFIL (~200 tokens) ──────────────────────────────────
  const sportLabels: Record<string, string> = {
    cycling: 'Radfahren', running: 'Laufen', strength: 'Kraft',
  }
  const sportStr = (athlete?.sport_types as SportConfig[] | null)
    ?.map(s => `${sportLabels[s.type] ?? s.type} (${s.days} Tage/Woche)`)
    .join(', ') ?? '—'

  sections.push([
    '[ATHLETEN-PROFIL]',
    athlete?.name ? `Name: ${athlete.name}` : null,
    `FTP: ${fmt(athlete?.ftp_watts)} W`,
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
    ? JSON.stringify(currentPlan.plan_json, null, 2)
    : 'Kein Wochenplan vorhanden.'

  const reviewNote = currentPlan?.review_notes
    ? `\nReview der Vorwoche:\n${currentPlan.review_notes}`
    : ''

  sections.push(
    `[AKTUELLER WOCHENPLAN]\nWoche: ${thisWeek}${currentPlan ? ` | Version ${currentPlan.version}` : ' | Noch kein Plan'}${reviewNote}\n${planBody}`
  )

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
  const decisionLines = (decisions ?? []).map(d =>
    `[${d.decision_type}] ${new Date(d.created_at).toLocaleDateString('de-DE')}: ${d.decision_summary}` +
    (d.reasoning ? `\n  → ${d.reasoning}` : '')
  )

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
