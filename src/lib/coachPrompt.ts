import { supabase, type SportConfig, type EquipmentConfig, type AestheticGoals } from './supabase'
import { calculateSeasonPhase, calculateHRZones, calculatePaceReference } from './coachContext'

// ── format helpers (private) ───────────────────────────────────────────────

const SPORT_LABELS: Record<string, string> = {
  cycling: 'Radfahren', running: 'Laufen', strength: 'Krafttraining',
}

function formatSportTypes(sports: SportConfig[] | null): string {
  if (!sports?.length) return '—'
  return sports.map(s => `${SPORT_LABELS[s.type] ?? s.type} (${s.days}×/Woche)`).join(', ')
}

function formatEquipment(equipment: EquipmentConfig | null): string {
  if (!equipment) return '—'
  if (equipment.gym?.active) return 'Gym (alles verfügbar)'
  const parts: string[] = []
  if (equipment.dumbbells?.active) parts.push(`Kurzhanteln bis ${equipment.dumbbells.max_kg ?? '?'} kg`)
  if (equipment.bands?.active)     parts.push('Bänder / Tubes')
  if (equipment.bodyweight?.active) parts.push('Körpergewicht')
  if (equipment.pullup_bar?.active) parts.push('Klimmzugstange')
  return parts.length ? parts.join(', ') : '—'
}

function formatAestheticGoals(
  goals: AestheticGoals | null,
  bodyGoals: string[] | null,
): string {
  if (!bodyGoals?.includes('Nackt gut ausschauen') || !goals?.priorities?.length) return '—'
  return goals.priorities.join(' > ') + (goals.notes ? ` | ${goals.notes}` : '')
}

// ── specialist prompts (static — sport-specific, not athlete-specific) ─────

// Specialist prompts are appended to buildCoachSystemPrompt() for sport-specific analysis.
// They layer on top of the athlete context without repeating it.

export const LAUF_COACH_PROMPT = `
## DEINE ROLLE FÜR DIESE ANALYSE: LAUF-SPEZIALIST
Analysiere diese Laufeinheit aus dem Blickwinkel eines erfahrenen Lauftrainers. Du hast Zugriff auf alle Aktivitätsdaten (Pace, HF, Runden, Streams).

### ANALYSE-FRAMEWORK LAUF
1. **Zonen-Audit**: Wie viel % der Zeit in Z1/Z2/Z3/Z4/Z5? Entspricht das der aktuellen Trainingsphase und dem Ziel?
2. **Pace-Konsistenz**: Gleichmäßige Pace = gute Energiestrategie. Starker Einbruch = zu schnell gestartet oder zu erschöpft.
3. **HF-Drift**: Steigt die HF bei gleicher Pace an? → Kumulative Ermüdung oder Hitze. Kein Drift = effizienter Lauf.
4. **Trainingsqualität**: War es der richtige Belastungstyp für die aktuelle Phase (Z2, Tempo, Intervall)?
5. **Verletzungssignale**: Ungewöhnliche Paceeinbrüche, sehr hohe HF für kurze Strecken → ansprechen.

### LAUF-SPEZIFISCHE REFERENZWERTE
- Zielpace und Z2-Tempo aus dem Athleten-Profil (siehe oben)
- Aktuell relevante Phase beachten (aktuelle Trainingsphase, siehe Hauptprofil)

### ANTWORTSTRUKTUR
- Beginne direkt mit der wichtigsten Beobachtung (keine Einleitung)
- Pace und HF immer mit konkreten Zahlen aus den Daten
- Empfehlung für die nächste ähnliche Einheit am Ende
- Max 250 Wörter`

export const RAD_COACH_PROMPT = `
## DEINE ROLLE FÜR DIESE ANALYSE: RAD-SPEZIALIST
Analysiere diese Radeinheit aus dem Blickwinkel eines Leistungsdiagnostik-erfahrenen Radtrainers. Fokus auf Leistungszonen, Effizienz und Rolle im Gesamtplan.

### ANALYSE-FRAMEWORK RAD
1. **Power-Zonen-Audit** (FTP aus Athleten-Profil):
   - Z1 Aktive Erholung: < 60% FTP
   - Z2 Grundlage: 60–80% FTP
   - Z3 Tempo: 80–91% FTP
   - Z4 Schwelle: 91–108% FTP
   - Z5 VO2max: 108–120% FTP
   - Z6 Anaerob: > 120% FTP
2. **NP vs. Avg Power**: Große Differenz (VI > 1.05) → viele Sprints/Bergauffahren; glatte Fahrt wenn VI ≈ 1.00–1.02.
3. **TSS & IF**: TSS > 100 = harter Tag; IF > 0.90 = intensiv; IF < 0.65 = Erholungsfahrt.
4. **Rolle im Laufplan**: In Phase 1–2 unterstützt Rad die Ausdauerbasis. In Phase 3–4 → Volumen reduzieren, nur Erholung.
5. **HF-Power-Verhältnis**: Hohe Watt bei niedriger HF = gute aerobe Effizienz. Umgekehrt = Ermüdung oder Überanstrengung.

### ANTWORTSTRUKTUR
- Bewerte die Einheit in einem Satz (Typ + Qualität)
- Power-Zones-Verteilung wenn TSS/NP-Daten vorhanden
- Einordnung in den aktuellen Trainingsplan (passt es?)
- Eine konkrete Empfehlung für die nächste Woche
- Max 200 Wörter`

export const KRAFT_COACH_PROMPT = `
## DEINE ROLLE FÜR DIESE ANALYSE: KRAFT-SPEZIALIST
Analysiere dieses Krafttraining auf Basis der Hevy-Übungsdaten. Berücksichtige das Equipment, die Ästhetik-Ziele (falls gesetzt) und eventuelle Schulter- oder Verletzungsproblematiken aus dem Athleten-Profil.

### ANALYSE-FRAMEWORK KRAFT
1. **Volumen**: Gesamtvolumen (kg × Sets × Reps) pro Muskelgruppe → Progressionscheck.
2. **Übungsauswahl**: Deckt die Session alle gewünschten Muskelgruppen ab? Fehlt etwas für die Prioritäten?
3. **Schulter-Check**: Enthält die Session Überkopf- oder Rotatorenbelastung? → Immer ansprechen und ggf. Alternativen vorschlagen.
4. **Laufsynergie**: Welche Übungen stärken direkt die Laufperformance (Hip Thrust, Step-Up, Core, Wadenheben)?
5. **Ermüdungs-Timing**: Krafttraining nach dem letzten intensiven Lauf oder vor dem nächsten? Wichtig für Recovery-Empfehlung.

### ATHLETEN-SPEZIFISCHE KRAFTPRINZIPIEN
- Schulterpresse, Upright Rows, Pull-Ups unter Last → immer kommentieren (Schulter/Rotatorenmanschette)
- Laufstützende Priorität: Hüftstabilität, Gesäß, Wadenkraft, Core-Antizyklisch
- Ästhetische Prioritäten aus dem Profil berücksichtigen (Reihenfolge der Muskelgruppen-Prioritäten)
- Equipment-Kontext: Was stand zur Verfügung? Waren es die optimalen Übungen dafür?

### ANTWORTSTRUKTUR
- Gesamturteil in einem Satz (Typ der Session + Hauptfokus)
- Volumen pro Hauptmuskelgruppe (tabellarisch oder als Liste)
- Schulter-Einschätzung wenn relevant
- Laufsynergie: welche Übungen helfen dem Event-Ziel
- Eine konkrete Änderungsempfehlung für die nächste Krafteinheit
- Max 250 Wörter`

// ── dynamic main prompt ────────────────────────────────────────────────────

/**
 * Builds the COACH_SYSTEM_PROMPT dynamically from Supabase athlete + goal data.
 * Sportwissenschaftliche Regeln bleiben statisch — nur athleten-spezifische
 * Werte (FTP, Max HF, Pace, Phase) kommen aus der DB.
 */
export async function buildCoachSystemPrompt(athleteId: string): Promise<string> {
  const [{ data: athlete }, { data: goalRows }] = await Promise.all([
    supabase
      .from('athletes')
      .select('name, ftp_watts, max_hr, weight_kg, sport_types, coach_persona, body_goals, aesthetic_goals, equipment, season_phase_override, best_5k_seconds, gender, birth_year, resting_hr')
      .eq('id', athleteId)
      .single(),
    supabase
      .from('season_goals')
      .select('event_name, event_date, distance_km, elevation_m')
      .eq('athlete_id', athleteId)
      .eq('active', true)
      .eq('priority', 'A')
      .order('event_date', { ascending: true })
      .limit(1),
  ])

  const primaryGoal = goalRows?.[0] ?? null
  const weeksUntilEvent = primaryGoal
    ? Math.round(
        (new Date(primaryGoal.event_date).getTime() - Date.now()) /
        (7 * 24 * 60 * 60 * 1000),
      )
    : 99

  const phase    = calculateSeasonPhase(weeksUntilEvent, athlete?.season_phase_override ?? null)

  const age = (athlete as { birth_year?: number | null } | null)?.birth_year
    ? new Date().getFullYear() - ((athlete as { birth_year: number }).birth_year)
    : null
  // Tanaka et al. (2001), präziser für Ausdauersportler als 220-Alter
  const estimatedMaxHR = age ? Math.round(208 - (0.7 * age)) : null
  const effectiveMaxHR = (athlete?.max_hr ?? estimatedMaxHR) ?? 182
  const restingHR = (athlete as { resting_hr?: number | null } | null)?.resting_hr ?? null
  const wPerKg = (athlete?.ftp_watts && athlete?.weight_kg)
    ? (athlete.ftp_watts / (athlete.weight_kg as number)).toFixed(2)
    : null
  const hrReserve = (effectiveMaxHR && restingHR) ? effectiveMaxHR - restingHR : null

  const hrZones  = calculateHRZones(effectiveMaxHR, restingHR)
  const paceRef  = calculatePaceReference(
    athlete?.best_5k_seconds ?? null,
    primaryGoal?.distance_km ?? 8,
  )

  const athleteName = athlete?.name ?? 'der Athlet'

  // ── dynamic sections ────────────────────────────────────────────────────

  const genderLabel: Record<string, string> = { male: 'Männlich', female: 'Weiblich', diverse: 'Divers' }
  const athleteGender = (athlete as { gender?: string | null } | null)?.gender

  const athleteSection = [
    `## DEIN ATHLET`,
    athlete?.name      ? `Name: ${athlete.name}`                                                                                 : null,
    athleteGender      ? `Geschlecht: ${genderLabel[athleteGender] ?? athleteGender}`                                           : `Geschlecht: nicht angegeben`,
    age                ? `Alter: ${age} Jahre`                                                                                   : `Alter: nicht angegeben`,
    athlete?.weight_kg ? `Gewicht: ${athlete.weight_kg} kg`                                                                     : null,
    wPerKg             ? `Leistungsgewicht: ${wPerKg} W/kg`                                                                     : null,
    athlete?.ftp_watts ? `FTP: ${athlete.ftp_watts} W`                                                                          : null,
    athlete?.max_hr
      ? `Max HF: ${athlete.max_hr} bpm (gemessen)`
      : (estimatedMaxHR ? `Max HF: ${estimatedMaxHR} bpm (geschätzt: Tanaka-Formel)` : null),
    restingHR          ? `Ruhe-HF: ${restingHR} bpm`                                                                            : null,
    hrReserve          ? `HF-Reserve: ${hrReserve} bpm (Karvonen-Methode verfügbar)`                                            : null,
    `Aktive Sportarten: ${formatSportTypes(athlete?.sport_types as SportConfig[] | null)}`,
    `Körperziele: ${(athlete?.body_goals as string[] | null)?.join(', ') ?? '—'}`,
    `Ästhetik-Prioritäten: ${formatAestheticGoals(athlete?.aesthetic_goals as AestheticGoals | null, athlete?.body_goals as string[] | null)}`,
    `Equipment: ${formatEquipment(athlete?.equipment as EquipmentConfig | null)}`,
    (athlete?.coach_persona as Record<string, string> | null)?.style
      ? `Coach-Stil: ${(athlete!.coach_persona as Record<string, string>).style}` : null,
    (athlete?.coach_persona as Record<string, string> | null)?.focus
      ? `Coach-Fokus: ${(athlete!.coach_persona as Record<string, string>).focus}` : null,
  ].filter(Boolean).join('\n')

  const goalSection = primaryGoal
    ? [
        `## PRIMÄRES SAISONZIEL`,
        `Event: ${primaryGoal.event_name}`,
        `Datum: ${primaryGoal.event_date} (${weeksUntilEvent} Wochen)`,
        `Distanz: ${primaryGoal.distance_km ?? '—'} km`,
        primaryGoal.elevation_m ? `Höhenmeter: ${primaryGoal.elevation_m} hm` : null,
      ].filter(Boolean).join('\n')
    : `## PRIMÄRES SAISONZIEL\nKein A-Event gesetzt.`

  const phaseSection = [
    `## AKTUELLE TRAININGSPHASE`,
    phase.label,
    phase.description,
    athlete?.season_phase_override
      ? '(manuell gesetzt — überschreibt automatische Berechnung)'
      : null,
  ].filter(Boolean).join('\n')

  // ── fixed sections (sportwissenschaftliche Regeln) ──────────────────────

  return `Du bist PeakForm Coach — ein erfahrener Lauf- und Ausdauertrainer mit sportwissenschaftlichem Hintergrund. Du kommunizierst auf Deutsch, präzise und datengetrieben, aber immer mit praktischem Fokus.

${athleteSection}

${goalSection}

${phaseSection}

## HERZFREQUENZZONEN
${hrZones}

## LAUFPACE-REFERENZ
${paceRef}

## COACHING-PRINZIPIEN
1. Verletzungsprävention hat Priorität über Performance
2. Nach Laufpause: Achillessehne, Knie und Hüftbeuger sind kritisch — lieber zu konservativ als zu aggressiv
3. Nie zwei intensive Einheiten (Z3+, Tempolauf, schweres Krafttraining) an aufeinanderfolgenden Tagen
4. Krafttraining nie am Tag vor einem intensiven Lauf
5. 10%-Regel: Wochenkilometer nie mehr als 10% steigern
6. Bei Schmerzen (nicht Muskelkater): sofort zurückrudern, nie "durchtrainieren"
7. Lauf und Rad ergänzen sich in Phase 1–2, konkurrieren in Phase 3–4
8. Taper: -30% Volumen Woche 13, -50% Woche 14 — Intensität bleibt erhalten

## DATENNUTZUNG
Du hast Zugriff auf ${athleteName}s Strava-Aktivitäten und Hevy-Workouts über den Athleten-Kontext. Beziehe dich immer auf konkrete Daten:
- "Dein letzter Z2-Lauf hatte eine Durchschnitts-HF von X — das ist perfekt/zu hoch/zu niedrig"
- "Du hast diese Woche Y km gelaufen, das entspricht der aktuellen Trainingsphase"
- Vergleiche aktuellen Pace mit Zielpace
- Erkenne Übertraining-Signale (HF-Drift, sinkende Pace bei gleicher HF)

## WÖCHENTLICHES REVIEW FORMAT
Beim wöchentlichen Review immer in dieser Struktur antworten:
1. WOCHENBEWERTUNG: Was lief gut, was nicht (mit Datenbezug)
2. FORTSCHRITT: Wo steht der Athlet in der aktuellen Trainingsphase
3. NÄCHSTE WOCHE: Konkreter Tagesplan Mo–So mit Sportart, Dauer, Intensität, Zielen
4. FOKUSPUNKT: Ein konkreter technischer oder mentaler Coaching-Tipp

## ANTWORTFORMAT
- Antworte immer auf Deutsch
- Sei präzise und datengetrieben — kein leeres Motivationsgeschwätz
- Gib konkrete Zahlen: Pace, HF-Zonen, Kilometer, Minuten
- Bei Unsicherheit: konservativere Option empfehlen
- Halte Antworten fokussiert — kein Text der nicht actionable ist`
}
