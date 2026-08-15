# PeakForm — Projektdokumentation

## Was ist PeakForm?
PWA-KI-Trainingscoach: verbindet Strava-Daten mit Claude-Analysen.
Zielgruppe: persönlicher Einsatz (kein SaaS).

## Tech-Stack
| Schicht | Technologie |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| Charts | Recharts |
| Routing | React Router v6 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Backend/DB | Supabase (PostgreSQL) |
| KI | Claude Sonnet (claude-sonnet-4-6) via `/api/analyse` |
| Hosting | Vercel — deployed auf `peakform-wheat.vercel.app` |
| PWA | vite-plugin-pwa |

## Supabase-Projekt
- **Name:** peakform
- **Project ID:** `thjihbyyelqrrvdinzti`
- **URL:** `https://thjihbyyelqrrvdinzti.supabase.co`
- **Region:** eu-central-1

## GitHub
- **Repo:** `https://github.com/abartmarkus-pixel/peakform` (privat)
- **Branch:** `main` → Auto-Deploy auf Vercel

## Datenbankschema
```sql
athletes (id uuid PK, strava_athlete_id bigint UNIQUE, strava_access_token text,
          strava_refresh_token text, expires_at timestamptz,
          name text,
          ftp_watts int, max_hr int, weight_kg numeric,
          training_days_per_week int,
          sport_types jsonb,           ← SportConfig[] {type, days}; cycling/running/strength
          body_goals text[],           ← Mehrfachauswahl: Event/Muskelaufbau/Gewicht reduzieren
          coach_persona jsonb,         ← {style, focus}
          equipment jsonb,             ← {dumbbells:{active,max_kg?},bands,bodyweight,pullup_bar,gym}
          aesthetic_goals jsonb,       ← {priorities:string[],notes:string}
          season_phase_override text,  ← NULL=Auto | 'readaptation'|'base'|'race'|'taper'
          best_5k_seconds int,         ← 5k-Bestzeit in Sekunden (Basis für Pace-Berechnung), manuell im Profil
          strava_prs jsonb DEFAULT '{}', ← von Strava selbst erkannte Bestzeiten je Standarddistanz
                                      -- (best_efforts/pr_rank aus der Activity-Detail-Response), Keys sind
                                      -- Stravas Distanz-Namen lowercased ("5k","10k","half-marathon",...,
                                      -- siehe STANDARD_DISTANCES_KM in coachContext.ts), Werte {seconds,at}.
                                      -- Via saveStravaPrsIfPresent() (strava.ts) bei jedem erstmaligen
                                      -- Detail-Fetch einer Laufaktivität aktualisiert. Für die 5k-Pace-Referenz
                                      -- Priorität in buildCoachSystemPrompt(): best_5k_seconds (manuell) >
                                      -- strava_prs['5k'] > Riegel-Schätzung. Ersetzt die frühere
                                      -- strava_best_5k_seconds/_at-Spalten (bleiben als toter Rest in der DB,
                                      -- ungenutzt, um den damals schon live deployten Code nicht zu brechen)
          strava_prs_backfill_done bool DEFAULT false, ← true nach dem einmaligen backfillStravaPrs()-
                                      -- Durchlauf (strava.ts), unabhängig vom Ergebnis
          push_opted_out bool DEFAULT false, ← serverseitiges Push-Opt-out (statt nur localStorage);
                                      -- übersteht Logout (localStorage.clear()) und iOS "Icon entfernen +
                                      -- neu hinzufügen" (leert ebenfalls localStorage), wo Notification.permission
                                      -- trotzdem 'granted' bleibt
          created_at timestamptz)

activities (id uuid PK, athlete_id uuid FK→athletes, strava_id bigint UNIQUE,
            name text, type text, date timestamptz,
            distance_m numeric, duration_s int, avg_hr numeric, max_hr numeric,
            np_watts numeric,       ← Strava weighted_average_watts (Summary-Feld, keine Eigenberechnung)
            avg_watts numeric,      ← Strava average_watts (Summary-Feld); NICHT aus streams_json.watts
                                      -- neu berechnen (Mittelwert dort exkl. Nullen → +15% zu hoch)
            elevation_m numeric,    ← Strava total_elevation_gain (Summary-Feld); NICHT aus
                                      -- streams_json.altitude neu berechnen (unsmoothe Rohdaten → +30-40% zu hoch)
            tss numeric, streams_json jsonb,
            description text,       ← Strava description (Hevy-Daten); beim 1. Öffnen gecacht
            claude_analysis text, created_at timestamptz,
            laps_json jsonb, splits_metric_json jsonb,
            recovery_checked bool,   ← true nach erstem Recovery-Check, unabhängig vom Ergebnis;
                                      -- verhindert wiederholten Mini-Claude-Call bei jedem Seitenaufruf
            stimulus_checked bool,   ← true nach erstem Stimulus-Check (triggerStimulusCheck), unabhängig
                                      -- vom Ergebnis; rein deterministisch, kein Claude-Call nötig
            rpe int,                 ← CHECK 1-10, Rate of Perceived Exertion; nur Laufen, freiwillig
                                      -- vom Athleten in ActivityDetail.tsx eingetragen (kein Auto-Wert)
            analysis_claimed_at timestamptz)  ← Lease für automatische Analyse (claimActivityForAnalysis);
                                      -- verhindert doppelte Claude-Calls bei gleichzeitigen Syncs (StrictMode
                                      -- Doppel-Mount, Dashboard+WeeklyPlan); nach 2 Min als abgelaufen behandelt

season_goals (id uuid PK, athlete_id uuid FK→athletes, event_name text,
              event_date date, distance_km numeric, elevation_m int,
              priority goal_priority ENUM('A','B','C'), sport_type text,
              notes text, active bool, created_at timestamptz)

weekly_plans (id uuid PK, athlete_id uuid FK→athletes, week_start date,
              version int, plan_json jsonb, review_notes text,
              review_user_input text,  ← persistenter Freitext-Input des Users beim Wochenreview
              change_reason text, plan_constraint_violation bool,
              created_at timestamptz)
-- INSERT-only, niemals UPDATE bestehender Pläne; version wird inkrementiert

coach_decisions (id uuid PK, athlete_id uuid FK→athletes, decision_type text,
                 decision_summary text, reasoning text,
                 related_plan_id uuid FK→weekly_plans,
                 related_activity_id uuid FK→activities,  ← gesetzt bei 'recovery_required' und
                                      -- 'stimulus_insufficient'
                 created_at timestamptz)

chat_messages (id uuid PK, thread_id uuid, athlete_id uuid FK→athletes,
               role text CHECK('user','assistant'), content text,
               chat_type text, activity_id uuid, created_at timestamptz)

push_subscriptions (id uuid PK, athlete_id uuid FK→athletes ON DELETE CASCADE,
                    endpoint text UNIQUE,  ← ein Athlet kann mehrere Geräte/Subscriptions haben
                    p256dh text, auth text,  ← Push-Verschlüsselungskeys aus PushSubscription.toJSON()
                    created_at timestamptz)
```
RLS aktiv, aktuell offene Policy (für persönlichen Einsatz ok).

## Projektstruktur
```
peakform/
├── api/
│   ├── analyse.ts          # Vercel Serverless Function → Claude API Proxy
│   │                       # Params: prompt, max_tokens?, system?
│   │                       # Limits: 80k Zeichen, max_tokens Cap 4096, generische Fehler
│   ├── strava-token.ts     # Vercel Serverless Function → Strava OAuth Token Exchange/Refresh
│   │                       # (STRAVA_CLIENT_SECRET serverseitig, nie im Browser-Bundle)
│   ├── send-daily-reminder.ts # Vercel Cron (0 6 * * * = 08:00 CEST, keine DST-Anpassung) → CRON_SECRET-geschützt
│   │                       # Berechnet "heute"/Wochenstart explizit in Europe/Vienna (Prozess-TZ ist UTC!),
│   │                       # sendet Push via web-push wenn Tag kein Ruhetag ist, räumt 404/410-Subscriptions auf
│   ├── calendar/[athleteId].ts # Öffentlicher ICS-Feed (GET, kein Auth) → athleteId (UUID) als Capability-Token
│   │                       # in der URL, analog zur offenen RLS-Policy. Liest weekly_plans (neueste Version je
│   │                       # week_start), rendert via buildIcsFeed() zu text/calendar. Für Apple Kalender als
│   │                       # webcal://…/api/calendar/<athleteId>-Abo gedacht (Profile.tsx "Kalender"-Sektion)
│   └── _lib/ics.ts         # buildIcsFeed(): reine ICS-Generierung (RFC 5545), von api/calendar/ UND der
│                           # vite.config.ts-Dev-Middleware genutzt. Titel: Kraft "💪🍑 Workout I/II/III",
│                           # Lauf "🏃 Laufen · Xmin", Rad "🚴 Radfahren · Xmin" (Freitext-description wandert
│                           # in DESCRIPTION statt SUMMARY, sonst unlesbar langer Kalendertitel); Ruhetage
│                           # werden ausgelassen (kein Event)
├── src/
│   ├── App.tsx             # Router: / | /auth/callback | /dashboard | /activity/:id
│   │                       #         /profile | /goals | /goals/:id | /plan | /chat
│   │                       # Session-Guard in Layout: localStorage → sessionStorage → restoreSessionFromSupabase()
│   │                       # Loading-Splash "PeakForm wird geladen…" während Supabase-Check
│   │                       # Layout: useTabSwipeNavigation() — Swipe-Geste zwischen BottomNav-Tabs
│   ├── components/
│   │   └── BottomNav.tsx   # 5-Tab-Navigation (Home|Plan|Coach|Ziele|Profil); Tabs aus useVisibleTabs()
│   ├── pages/
│   │   ├── Home.tsx        # Strava-Connect-Button; Auto-Redirect zu /dashboard (prüft localStorage + sessionStorage)
│   │   ├── AuthCallback.tsx # OAuth Code → /api/strava-token → Supabase upsert → localStorage + sessionStorage
│   │   ├── Dashboard.tsx   # 4 Nav-Kacheln + Letzte Aktivitäten + Filter (🏋️🚴🏃) + Echtzeit-Alert
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Übungstabelle + Claude-Analyse
│   │   ├── Profile.tsx     # Name, FTP/HF/Gewicht, Sportarten, Equipment, Ästhetik, Trainingsphase; Auto-Save 800ms
│   │   │                   # Sportarten-Stepper: Invariante Σdays ≤ trainingDays technisch erzwungen
│   │   ├── Goals.tsx       # Saisonziele A/B/C, Countdown in Tagen, Add/Edit-Modal; Karten verlinken zu /goals/:id
│   │   ├── GoalDetail.tsx  # Phasen-Grafik + geschätzte Zielzeit (nur Laufziele) — komplett Claude-frei
│   │   ├── WeeklyPlan.tsx  # Wochenplan + Constraint-Prompt + Validation-Banner + Wochenreview
│   │   └── Chat.tsx        # Globaler Coach-Chat mit Supabase-Persistenz; Button "In Plan übernehmen" unter
│   │                       # der letzten Coach-Nachricht (extractChatPlanRecommendation/applyPlanRecommendation)
│   ├── lib/
│   │   ├── supabase.ts     # Supabase Client + Types (Athlete, Activity, SportConfig, SeasonGoal, WeeklyPlan, CoachDecision, ...)
│   │   ├── strava.ts       # OAuth URL, Token Exchange via /api/strava-token, Activities, Streams, Laps
│   │   │                   # restoreSessionFromSupabase(): Session-Wiederherstellung aus Supabase (Single-User)
│   │   ├── dateUtils.ts    # ISO 8601 Datums-Helpers: getISOMonday(date), getISOSunday(monday), formatWeekRange(monday)
│   │   │                   # Woche beginnt Montag; toDateStr nutzt Lokalzeit (nicht UTC) — kritisch für CET/CEST
│   │   │                   # dayLabelForDate(date): Mo/Di/.../So-Key für PlanJson.days zu einem Datum
│   │   ├── coachContext.ts # buildCoachContext(): 8 Abschnitte inkl. [HARTE TRAININGS-CONSTRAINTS]
│   │   │                   # buildSpecialistContext(athleteId, sport): sportart-spezifische Historien
│   │   │                   # calculateSeasonPhase(), calculateHRZones(), calculatePaceReference() (exportiert)
│   │   │                   # calculateHRZoneBounds(): Zonen-Untergrenzen als Zahlen (Basis von calculateHRZones()
│   │   │                   # UND dem Stimulus-Check); resolveHRProfile(athlete): effektive Max-HF (Tanaka-Fallback)
│   │   ├── coachPrompt.ts  # buildCoachSystemPrompt(athleteId): Promise<string> — dynamisch aus DB
│   │   │                   # LAUF_COACH_PROMPT | RAD_COACH_PROMPT | KRAFT_COACH_PROMPT (statisch)
│   │   ├── useVisibleTabs.ts        # useVisibleTabs(): TabDef[] — gefilterte/geordnete BottomNav-Tab-Liste
│   │   │                   # (Route/Icon/Label/Feature-Gate); einzige Quelle der Wahrheit für BottomNav.tsx + useTabSwipeNavigation.ts
│   │   ├── useTabSwipeNavigation.ts # useTabSwipeNavigation(): natives touchstart/touchend-Swipe zwischen Tabs
│   │   │                   # aus useVisibleTabs(); >60px + |Δx|>2×|Δy|, kein Wrap-Around, nur auf den 5 Haupt-Tabs aktiv
│   │   ├── weeklyPlan.ts   # DayPlan/PlanJson-Types, checkPlanConflicts(), dayMatchesSport(), insertPlanVersion()
│   │   │                   # (geteilte INSERT-only-Speicherlogik, aus WeeklyPlan.tsx extrahiert) — genutzt von
│   │   │                   # WeeklyPlan.tsx UND planRecommendation.ts
│   │   │                   # resolveDayZone(day): Zonenzahl (1-5) aus intensity-Präfix "Z1".."Z5", sonst null
│   │   ├── planRecommendation.ts # extractPlanRecommendation()/applyPlanRecommendation(): Coach-Empfehlung aus
│   │   │                   # claude_analysis gezielt in einen Plantag übernehmen (ActivityDetail.tsx-Button).
│   │   │                   # extractChatPlanRecommendation(): gleiches Prinzip für eine freie Chat-Nachricht
│   │   │                   # (Chat.tsx-Button) — extrahiert zusätzlich die Sportart selbst (vorher unbekannt).
│   │   │                   # applyPlanRecommendation() nimmt ein generisches source-Label statt activityName/-Id
│   │   │                   # (activityId optional) — von beiden Buttons gemeinsam genutzt
│   │   └── push.ts         # getPushSupport() (Feature-Detection inkl. iOS-Standalone-Check), enablePushNotifications()/
│   │                       # disablePushNotifications(), syncPushSubscription() — stiller Re-Subscribe bei jedem
│   │                       # App-Start (App.tsx Layout), fängt bekanntes iOS-Subscription-Expiry-Problem ab
│   ├── sw.ts               # Custom Service-Worker-Entry (injectManifest-Strategie, nicht generateSW) —
│   │                       # push/notificationclick-Handler; von tsconfig.json bewusst ausgeschlossen
│   │                       # (WebWorker- vs DOM-Lib-Konflikt mit dem Rest von src/)
│   └── vite-env.d.ts       # Env-Variable-Types
├── vite.config.ts          # PWA-Config (strategies: injectManifest, srcDir: src, filename: sw.ts) +
│                           # /api/analyse + /api/strava-token + /api/calendar Middleware für lokales Dev
├── vercel.json             # SPA Rewrites + SW Cache-Header + Cron (send-daily-reminder) + Build-Config
└── .env                    # Credentials (nicht committen!)
```

## Env-Variablen (.env)
```
VITE_SUPABASE_URL=https://thjihbyyelqrrvdinzti.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_STRAVA_CLIENT_ID=260874
STRAVA_CLIENT_SECRET=...    ← kein VITE_ Prefix — nur serverseitig in /api/strava-token
VITE_STRAVA_REDIRECT_URI=https://peakform-wheat.vercel.app/auth/callback
ANTHROPIC_API_KEY=...       ← kein VITE_ Prefix (nur serverseitig)
SUPABASE_SERVICE_ROLE_KEY=... ← kein VITE_ Prefix; nur in api/send-daily-reminder.ts (Cross-Athlet-Zugriff für Cron)
VITE_VAPID_PUBLIC_KEY=...   ← Web Push, öffentlich (Frontend pushManager.subscribe())
VAPID_PRIVATE_KEY=...       ← kein VITE_ Prefix — nur in api/send-daily-reminder.ts
VAPID_SUBJECT=mailto:...    ← optional, Default 'mailto:noreply@peakform.app' (bewusst kein persönlicher Kontakt im öffentlichen Repo)
CRON_SECRET=...             ← schützt /api/send-daily-reminder; Vercel setzt automatisch den Authorization-Header, wenn diese Var gesetzt ist
```

## Lokale Entwicklung
```bash
npm run dev       # Vite Dev-Server auf localhost:5173
                  # /api/analyse + /api/strava-token als Vite-Middleware (kein vercel dev nötig)
```

## Was ist implementiert ✅

### Foundation
- [x] React + Vite + Tailwind + PWA (theme_color: #1D9E75)
- [x] Supabase-Tabellen + RLS
- [x] Strava OAuth 2.0 Flow (code → /api/strava-token server-side → Supabase)
- [x] Strava Token-Refresh (automatisch, 60s Buffer, via /api/strava-token)
- [x] Persistente Session: `restoreSessionFromSupabase()` — kein erneuter Strava-Login bei leerem localStorage

### Dashboard & Aktivitäten
- [x] Dashboard: letzte 10 Aktivitäten, in Supabase gecacht
- [x] Dashboard: 4 quadratische Nav-Kacheln (💬 Coach / 📅 Plan / 🎯 Ziele / 👤 Profil)
- [x] Dashboard: Filter nach Trainingsart (🏋️🚴🏃), Logout-Icon; Filter-Wert in `sessionStorage` (`dashboard_filter`) gespiegelt — überlebt damit das Unmount/Remount von `Dashboard` beim Navigieren zu `/activity/:id` und zurück
- [x] Home.tsx: Auto-Redirect zu `/dashboard` wenn `athlete_strava_id` in localStorage
- [x] Dashboard: Echtzeit-Alert (Claude-Konflikt-Check nach Strava-Sync, sessionStorage-Gate, Amber-Banner + Modal)
- [x] Aktivitäts-Detail: Stats-Grid, Charts, Rundentabelle, Claude-Analyse
- [x] Aktivitäts-Detail: "Zurück"-Button navigiert deterministisch zur Herkunftsseite statt sich auf Browser-History zu verlassen — Dashboard.tsx (`<Link>`) und WeeklyPlan.tsx (`navigate()`) übergeben beim Verlinken auf `/activity/:id` explizit `state: { from: '/dashboard' | '/plan' }`; der Button liest `location.state?.from` und navigiert dorthin. Nur wenn kein `from`-State vorhanden ist (z. B. Deep-Link/Reload), Fallback auf `navigate(-1)` (`window.history.state?.idx > 0`-Guard) bzw. zuletzt `/dashboard`
- [x] Markdown-Renderer

### Navigation
- [x] BottomNav: 5 Tabs (Home|Plan|Coach|Ziele|Profil), Tab-Reihenfolge/-Sichtbarkeit aus `useVisibleTabs()` (einzige Quelle der Wahrheit, feature-flag-gefiltert)
- [x] Swipe-Navigation zwischen BottomNav-Tabs: `useTabSwipeNavigation()` (nativ, kein Package) im Layout-Wrapper registriert; aktiv nur wenn aktueller Pfad einem der 5 Haupt-Tabs entspricht (sonst inert, z. B. `/activity/:id`, `/onboarding`); Schwelle horizontale Distanz >60px UND |Δx|>2×|Δy|; kein Wrap-Around an den Rändern; `DayCard` in WeeklyPlan.tsx trägt `data-swipe-ignore`, damit Gesten auf einer Karte/deren Drag-Griff die Swipe-Erkennung nicht auslösen (Kollisionsvermeidung mit dnd-kit-Drag + Long-Press-Kontextmenü)

### Krafttraining-Detailansicht (WeightTraining)
- [x] Hevy → Strava description Parser (`parseHevyDescription`)
- [x] Übungskarten mit Volumen-Pill + Muskelgruppe-Pill
- [x] activities.description: Cache-first (Supabase → Strava Detail-API Fallback)

### Coach-System
- [x] `buildCoachSystemPrompt(athleteId): Promise<string>` — dynamisch aus DB (FTP, Max HF, Saison-Phase, HF-Zonen, Pace-Referenz, A-Event)
- [x] `buildCoachContext(athleteId, threadId?)`: 8 Abschnitte parallel — `generatePlan()`/`startReview()` in WeeklyPlan.tsx übergeben seit Kurzem `threadId = athlete.id` mit (vorher nicht gesetzt), damit Abschnitt 7 (`[AKTUELLE CHAT-SESSION]`, letzte 20 Chat-Nachrichten) auch bei Plan-Generierung/-Review gefüllt ist — Wünsche/Absprachen aus dem Coach-Chat fließen so als Kontext ein. Kein hartes Erzwingen: Claude gewichtet den Chat-Kontext nur als ein Signal von mehreren, keine garantierte 1:1-Übernahme
- [x] `buildSpecialistContext(athleteId, sport)`: Lauf/Rad/Kraft-spezifische Historien
- [x] `LAUF_COACH_PROMPT` / `RAD_COACH_PROMPT` / `KRAFT_COACH_PROMPT`: statische Spezialcoaches
- [x] Coach-Routing (`getSpecialistPrompt(activityType)`) in ActivityDetail.tsx
- [x] `calculateSeasonPhase()`, `calculateHRZones()`, `calculatePaceReference()` in coachContext.ts
- [x] Recovery-Extraktion: `triggerRecoveryExtraction(analysisText, athleteId, activityId)` — fire-and-forget nach Analyse ODER beim Laden bestehender Analyse (on-load check: `if (act.claude_analysis && !act.recovery_checked)`); setzt `activities.recovery_checked=true` nach jedem Lauf unabhängig vom Ergebnis, bleibt bei Fehler `false` für Retry
- [x] Stimulus-Check (unzureichender Trainingsreiz): `triggerStimulusCheck(activity, athleteId)` in `activityAnalysis.ts` — im Gegensatz zur Recovery-Extraktion **kein Claude-Call**, rein deterministischer Ist/Soll-Vergleich. Löst über `dayLabelForDate()` (`dateUtils.ts`) den zur Aktivität gehörenden Plantag auf, liest dessen `intensity`-Präfix per `resolveDayZone()` (`weeklyPlan.ts`, parst `/^Z([1-5])/`) und vergleicht `activity.avg_hr` gegen die Zonen-Untergrenze aus `calculateHRZoneBounds()` (`coachContext.ts`, gleiche Karvonen-Formel wie `calculateHRZones()`, jetzt als Zahlen statt nur Text) minus 5 bpm Toleranz. Bewusst nur für Laufen und nur Z2/Z3 (kontinuierliche Belastung, wo Ø-HF ein verlässlicher Proxy ist) — Z1 ist gewollt leicht, Z4/Z5 meist Intervall-Strukturen mit Pausen, bei denen die Gesamt-Ø-HF kein verlässlicher Ist-Wert wäre. Bei struktureller Unterforderung: `coach_decisions`-Insert mit `decision_type: 'stimulus_insufficient'`. Aufruf-Stellen spiegeln `triggerRecoveryExtraction()` 1:1 (nach `analyzeActivity()` UND On-Load-Backfill in ActivityDetail.tsx via `!act.stimulus_checked`), läuft aber unabhängig von `claude_analysis`, da kein API-Call nötig ist. `generatePlan()` in WeeklyPlan.tsx liest `stimulus_insufficient`-Decisions der letzten 14 Tage (weiteres Fenster als Recovery, da Progressions-Signale länger nachwirken dürfen als Verletzungs-Flags) und injiziert sie als eigene "STIMULUS-SIGNALE"-Regel in den Plan-Prompt (niedrigere Priorität als `recoverySection`, überschreibt nie die harten Tage-Constraints). Schließt die Lücke, dass bisher nur `calculateDynamicZ2Pace()` datengetrieben war (Pace-Referenz aus echten Läufen neu berechnet) — die Reaktion darauf ("Intensität erhöhen") hing komplett von Claudes Freitext-Interpretation der letzten Analyse ab, ohne Erzwingung. `resolveHRProfile()` (`coachContext.ts`) wurde aus `buildCoachSystemPrompt()` extrahiert (Tanaka-Fallback-Formel für Max-HF aus Geburtsjahr), damit Prompt-Text und Stimulus-Check dieselbe HF-Zonen-Basis nutzen
- [x] RPE-Erfassung (Rate of Perceived Exertion, 1-10): Picker in ActivityDetail.tsx (nur Laufen, unter dem Stats-Grid), Tap speichert sofort per `saveRpe()` (kein Modal, keine Debounce — Button-Hervorhebung ist die Bestätigung). Zweck: HF ist nur ein Proxy für Trainingsreiz und kann täuschen (Hitze, Schlafmangel, Brustgurt-Ausrutscher) — RPE liefert ein unabhängiges zweites Signal. Zwei Verwendungen: (1) `activityAnalysis.ts`s `activityBlock`-Prompt zeigt Claude die RPE, damit die Zonen-Audit-Analyse HF/RPE-Diskrepanzen kommentieren kann; (2) `WeeklyPlan.tsx`s `stimulusRows`-Query filtert `stimulus_insufficient`-Decisions per `.or('rpe.is.null,rpe.lte.6', { foreignTable: 'activities' })` — eine hohe RPE (≥7) bei einer als "zu leicht" geflaggten Einheit widerspricht dem HF-Befund, das Signal fließt dann NICHT als harte Regel in die nächste Plan-Generierung ein (`coach_decisions`-Zeile bleibt aber erhalten, nur query-seitig ausgeblendet). Kein Zeitproblem mit dem automatischen `triggerStimulusCheck()` (läuft sofort nach Sync, bevor RPE existieren kann): die Decision wird wie bisher sofort auf HF-Basis angelegt, der RPE-Filter greift erst später beim nächsten `generatePlan()`-Aufruf, wenn die RPE typischerweise längst eingetragen ist
- [x] Automatische Analyse nach Sync (`syncActivitiesToSupabase()` fire-and-forget-Sweep über `claude_analysis IS NULL`, sowie `WeeklyPlan.tsx`s `closeOutstandingAnalyses()`-Fallback) läuft pro Aktivität exakt einmal: `claimActivityForAnalysis(activityId)` claimt atomar über `analysis_claimed_at` (conditional UPDATE), bevor `analyzeActivity()` aufgerufen wird — verhindert doppelte Claude-Calls bei gleichzeitigen Syncs (React StrictMode Doppel-Mount, Dashboard+WeeklyPlan). Claim wird nach Erfolg/Fehlschlag zurückgesetzt; nach 2 Min als abgelaufen behandelt (Selbstheilung bei abgebrochenem Tab). Manueller "Neu analysieren"-Button in ActivityDetail.tsx umgeht den Claim bewusst (soll immer laufen)
- [x] Coach-Empfehlung gezielt in den Wochenplan übernehmen: Button "Empfehlung übernehmen" in ActivityDetail.tsx (nur Lauf/Rad — Kraft-Tage tragen einen festen "Workout I/II/III"-Namen, siehe WeeklyPlan-Sektion, in den keine Freitext-Empfehlung passt). `extractPlanRecommendation()` (`src/lib/planRecommendation.ts`) extrahiert die Empfehlung aus `claude_analysis` per `/api/analyse`-Call strukturiert als JSON (Tag/Dauer/Distanz/Intensität/Beschreibung); Zielwoche (aktuelle/nächste) wird deterministisch aus dem genannten Wochentag berechnet, nicht von Claude geraten. Bestätigungsdialog zeigt die Empfehlung editierbar, Tag-Dropdown nur mit Tagen, die im Zielplan bereits dieselbe Sportart tragen (`dayMatchesSport()`) — ändert nie die Trainingstag-Struktur, nur `duration_min`/`distance_km`/`intensity`/`description` eines bestehenden Tages. `applyPlanRecommendation()` speichert INSERT-only (version++) über `insertPlanVersion()` (`src/lib/weeklyPlan.ts`, geteilte Speicherlogik, extrahiert aus `WeeklyPlan.tsx`s `saveManualPlanChange()`), plus `coach_decisions`-Audit-Eintrag (`decision_type: 'plan_recommendation_applied'`, `related_activity_id` gesetzt). Laufen behält dabei immer `distance_km: null` (bestehende Invariante)
- [x] Gleiches Übernahme-Feature jetzt auch im globalen Coach-Chat (Chat.tsx): Button "In Plan übernehmen" unter der letzten Coach-Nachricht. `extractChatPlanRecommendation()` (`src/lib/planRecommendation.ts`) extrahiert zusätzlich zu Tag/Dauer/Distanz/Intensität/Beschreibung auch die Sportart selbst aus dem Chat-Fließtext (anders als bei der Aktivitäts-Analyse dort vorher nicht bekannt); liefert Claude `sport: null` (Kraft oder unklare Nachricht), bricht die Übernahme mit Fehlermeldung ab — gleiche Kraft-Invariante wie beim Aktivitäts-Analyse-Pfad. `applyPlanRecommendation()` wurde dafür generalisiert: `activityName`/`activityId` → optionales `source`-Freitext-Label (z. B. `"Chat-Empfehlung"` vs. `Analyse von "<Aktivitätsname>"`), `activityId` bleibt optional (aus dem Chat heraus gibt es keine Aktivität) — von beiden Einstiegspunkten (ActivityDetail.tsx UND Chat.tsx) genutzt
- [x] Der Coach behauptet im Chat NICHT, den Plan bereits gespeichert/aktualisiert zu haben ("Plan aktualisiert ✅" o.ä.) — Chat.tsx schreibt technisch nie in `weekly_plans` (nur `chat_messages`), ein solcher Claim wäre also immer eine Halluzination. Fester Prompt-Abschnitt in `coachPrompt.ts` (`buildCoachSystemPrompt()`, wirkt global für alle Claude-Calls inkl. Chat) verpflichtet den Coach stattdessen, die Empfehlung konkret zu formulieren und auf den "In Plan übernehmen"-Button zu verweisen
- [x] Von Strava selbst erkannte Bestzeiten (alle Standarddistanzen, nicht nur 5k) als Datenquelle: `saveStravaPrsIfPresent(athleteId, bestEfforts, activityDate)` (`strava.ts`) liest das `best_efforts`-Array aus der Strava Activity-Detail-Response (`fetchActivityDetail()`, dort um das Feld erweitert) und schreibt jeden Eintrag mit `pr_rank: 1` in `athletes.strava_prs` (JSON-Map, Key = Stravas Distanz-Name lowercased, z.B. `"5k"`, `"10k"`, `"half-marathon"`, `"marathon"` — vollständige Liste + km-Werte in `STANDARD_DISTANCES_KM`, `coachContext.ts`). `pr_rank: 1` heißt: athletenweite Bestzeit über diese Distanz zum Abfragezeitpunkt, direkt aus GPS/Zeit-Daten — nicht hochgerechnet. Read-modify-write pro Aktivität (bestehende Distanzen bleiben erhalten). Aufruf an beiden bestehenden `fetchActivityDetail()`-Stellen, die ohnehin schon `splits_metric` cache-first laden: `activityAnalysis.ts`s `analyzeActivity()` (automatischer Pfad nach jedem Sync) UND `ActivityDetail.tsx` (falls die Hintergrund-Analyse beim Seitenaufruf noch nicht gelaufen ist). Läuft nur beim *erstmaligen* Detail-Fetch einer Aktivität (cache-first über `splits_metric_json`); ältere, schon gecachte Aktivitäten erfasst `backfillStravaPrs()` (nächster Punkt). Für die 5k-Pace-Referenz priorisiert `buildCoachSystemPrompt()` weiterhin `best_5k_seconds` (manuell im Profil) > `strava_prs['5k']` > `estimateBest5kFromActivities()`-Riegel-Schätzung. Ersetzt die frühere 5k-spezifische `strava_best_5k_seconds`/`_at`-Speicherung (Spalten bleiben ungenutzt in der DB, nicht gedroppt, um den zum Umstellungszeitpunkt bereits live deployten Code nicht zu brechen)
- [x] `backfillStravaPrs(athleteId)` (`strava.ts`): einmaliger Nachhol-Check für genau die Lücke oben — holt für die letzten 20 Läufe (`BACKFILL_RUN_LIMIT`) parallel `fetchActivityDetail()` unabhängig vom `splits_metric_json`-Cache (ohne diesen zu verändern), führt alle gefundenen `pr_rank: 1`-Distanzen client-seitig zusammen und schreibt sie in EINEM Schreibzugriff (bewusst kein `Promise.all` von `saveStravaPrsIfPresent()`-Aufrufen — bei bis zu 20 gleichzeitigen read-modify-write-Zugriffen auf dieselbe Zeile würden sich gefundene Distanzen sonst gegenseitig überschreiben). Gate über `athletes.strava_prs_backfill_done` (athletenweit, nicht pro Aktivität wie `recovery_checked`/`stimulus_checked`, da einmaliger Vorgang) — wird erst nach erfolgreichem Durchlauf gesetzt, unabhängig davon ob ein PR gefunden wurde. Bei Fehlschlag (z. B. `getValidAccessToken()` wirft wegen abgelaufenem Refresh-Token) bleibt das Flag `false` und der nächste App-Start versucht es erneut — silent failure analog zu `syncPushSubscription()`. Getriggert fire-and-forget in `App.tsx`s Layout-`useEffect` direkt neben `syncPushSubscription()`, no-op sobald das Flag gesetzt ist
- [x] Strava-PR sichtbar im Profil (`Profile.tsx`, "5k Bestzeit"-Feld): ist `best_5k_seconds` leer, zeigt eine "Strava-PR erkannt: MM:SS (Datum) — übernehmen?"-Zeile den Wert aus `athlete.strava_prs['5k']` als Klick-Vorschlag (übernimmt nur ins Eingabefeld, speichert nicht automatisch — Auto-Save greift danach wie gewohnt). Gleiche Priorität wie in `buildCoachSystemPrompt()`: die Riegel-Schätzungs-Zeile ("Geschätzt aus deinen letzten Läufen") erscheint nur, wenn WEDER eine manuelle PB NOCH ein Strava-PR vorliegt — die zugehörige `estimateBest5kFromActivities()`-Query beim Laden von Profile.tsx läuft entsprechend auch nur in diesem Fall
- [x] Ziel-Detailseite (`src/pages/GoalDetail.tsx`, Route `/goals/:id`, von einer Ziel-Karte in `Goals.tsx` verlinkt): zeigt (1) eine 4-Segment-Phasen-Grafik (Readaptation/Grundlage/Wettkampfvorbereitung/Taper, aktuelle Phase hervorgehoben) aus `calculateSeasonPhase()` — bereits bestehende, rein deterministische Logik, kein neuer Code nötig — und (2) für Laufziele mit hinterlegter Distanz eine geschätzte Zielzeit. Komplett ohne Claude-Call — reine Arithmetik auf echten `activities`/`strava_prs`/HF-Daten (`coachContext.ts`), damit die Schätzung nie "erfunden" wirkt. `calculateSeasonPhase()` gibt zusätzlich `progressPct` zurück (0–100, aus dem Wochen-Countdown innerhalb der Phasengrenzen `PHASE_WEEK_BOUNDS`; `null` bei manuellem `season_phase_override`, da dort keine Zeitbasis existiert) — bereits durchlaufene Phasen zeigt die Balkengrafik grün gefüllt mit gelbem Stern (`IconStar`) statt der Ausgangsfarbe. Zwei Methoden, `GoalDetail.tsx` versucht sie in dieser Reihenfolge:
  - **Primär — `estimateGoalFinishTimeFromEfficiency()`** (Tempo-Puls-Effizienz, VO2max-Modell nach Daniels & Gilbert 1979 + ACSM-%HFR≈%VO2R-Beziehung): schätzt die aktuelle aerobe Fitness aus dem Verhältnis von Tempo zu Herzfrequenz während normaler, durchgehender Läufe (≥10 Min, 30–90% Herzfrequenzreserve — der von ACSM validierte Bereich) und rechnet daraus per Bisektion die Zielzeit für die Ziel-Distanz. Braucht dafür KEINEN Maximaleinsatz — funktioniert genauso aus einem bewusst ruhig gelaufenen Grundlagenlauf, weil Fitness über die Tempo/Puls-Relation abgelesen wird statt über die erreichte Zeit selbst. Löst damit gezielt die Schwäche der reinen Distanz-Hochrechnung (s.u.): in einer Grundlagenphase mit bewusst gedrosseltem Pulsbereich lieferte die alte Methode systematisch zu langsame Schätzungen, weil kein Trainingslauf ein echter Maximaleinsatz war. Nimmt den Median der 3 höchsten VO2max-Einzelschätzungen aus mind. 3 qualifizierenden Läufen der letzten 180 Tage (schlechte Tage — Hitze, Schlafmangel — drücken die implizierte VO2max fälschlich nach unten, bessere Tage liegen näher an der wahren Fitness). Braucht eine hinterlegte Ruhe-Herzfrequenz (Karvonen-Basis), sonst `null` → Fallback. `confidence` hängt von Datenmenge und ob die Maximal-HF gemessen (nicht nur Tanaka-geschätzt) ist ab.
  - **Fallback — `estimateGoalFinishTime()`** (Distanz-Anker + Riegel-Formel, ursprüngliche Methode): greift nur, wenn die Effizienz-Methode `null` liefert (keine Ruhe-HF hinterlegt oder zu wenige qualifizierende Läufe). Wählt als Rechen-Anker den Kandidaten (Strava-Bestzeit ODER echten Trainingslauf ≥ 3 km), dessen Distanz der Zieldistanz am nächsten kommt, und überbrückt die Differenz per Riegel-Formel (`riegelProject()`, geteilt mit `estimateBest5kFromActivities()`). Ist der nächstgelegene Kandidat mehr als 6x von der Zieldistanz entfernt: kein Wert statt einer faktisch geratenen Schätzung.

  Beide Methoden liefern denselben `GoalFinishEstimate`-Typ (inkl. fertig formatiertem `basisText` in Klartext, z.B. "Berechnet aus deiner Tempo-Puls-Effizienz der letzten X passenden Läufe" bzw. "Basierend auf deiner X-km-Bestzeit vom Datum") — `GoalDetail.tsx` muss dadurch nicht wissen, welche Methode gerade gegriffen hat, um sie anzuzeigen. Klick auf `basisText` öffnet ein Overlay mit einer laienverständlichen Erklärung der jeweiligen Methode + 1-2 Quellenangaben (`METHOD_EXPLANATION`, statischer Text in `GoalDetail.tsx`, kein Claude-Call).
- [x] Datenbasierte Phasenfortschritts-Beschreibung (`calculatePhaseProgressNarrative()`, `coachContext.ts`): ersetzt in der Phasen-Karte die reine `progressPct`-Prozentzahl (sagt nur etwas über verstrichene Kalenderzeit, nichts über tatsächliches Training) durch einen Satz aus echten Aktivitätsdaten, wo möglich — Hintergrund: bei zwei Athleten mit identischem Wochen-Countdown bis zum Event zeigte die reine Kalenderrechnung exakt denselben Fortschritt, unabhängig davon ob überhaupt trainiert wurde. Je Phase ein anderes Signal: **Grundlage** — Ø-Wochenkilometer letzte 4 Wochen vs. die 4 Wochen davor (braucht ≥2 Läufe je Fenster); **Wettkampfvorbereitung** — Anteil der Läufe der letzten 4 Wochen mit `avg_hr` ≥ der Z3-Untergrenze aus `calculateHRZoneBounds()` (braucht ≥3 Läufe mit HF-Daten), d.h. wie viele Einheiten im Tempo-/Schwellenbereich liefen; **Readaptation** — größte Trainingspause (≥14 Tage) in den letzten 180 Tagen plus Zeitpunkt der Rückkehr (nur relevant, wenn die Rückkehr ≤30 Tage zurückliegt), echte Wiedereinstiegs-Erkennung statt der reinen "mehr als X Wochen bis zum Event"-Annahme. **Taper** liefert bewusst immer `null` — die Trainingslehre plant den Taper kalendarisch VOR dem Rennen (gezielte Trainingsreduktion), es gibt kein Datensignal, das ihn sinnvoll ersetzen könnte. Gibt `null` zurück, wenn die jeweiligen Mindestdatenmengen fehlen — `GoalDetail.tsx` fällt dann auf die alte `progressPct`-Prozentzahl zurück (gleiches Fallback-Pattern wie bei der Zielzeit-Schätzung: primär datenbasiert, Kalender-Schätzung nur als Notlösung). Nur für Laufen (`g.sport_type === 'Laufen'`), analog zu den Zonen-/Pace-Referenzen im Rest des Projekts.

### Profil
- [x] Name, FTP, Max HF, Gewicht, Trainingstage (1–7)
- [x] Sportarten-Akkordeon mit Stepper — Invariante: `Σdays ≤ trainingDays` technisch erzwungen
  - [x] Pill-Klick: Overflow-Schutz in `toggleSport` (fügt nur hinzu wenn Kapazität vorhanden)
  - [x] Stepper − bei days=1: Sportart wird explizit entfernt, Stepper schließt
  - [x] Stepper + disabled wenn `totalDays >= trainingDaysNum`
  - [x] `clampSportDays(n)`: Training-Tage-Reduktion → Sport-Tage proportional reduzieren
- [x] Körperziele (Mehrfachauswahl), Coach-Stil, Coach-Fokus Freitext
- [x] Equipment-Sektion: Kurzhanteln/Bänder/Körpergewicht/Klimmzugstange/Gym (Gym = Mutex)
- [x] Ästhetik-Ziele: Drag & Drop Ranking (via @dnd-kit) — nur wenn "Muskelaufbau" oder "Gewicht reduzieren" aktiv
- [x] Trainingsphase: Auto-Anzeige + Segmented Control (Auto/Override); `season_phase_override` in DB
- [x] Auto-Save 800ms Debounce
- [x] Konto löschen: rot abgesetzte Sektion ganz unten, Bottom-Sheet-Modal mit Zwei-Stufen-Bestätigung ("Ja, endgültig löschen"); Ablauf: `deauthorizeStrava()` (POST `/api/strava-token` mit `grant_type: 'deauthorize'`, proxied zu `strava.com/oauth/deauthorize` — schlägt der Call fehl z.B. bei bereits abgelaufenem Token, wird trotzdem fortgefahren, Athlet bekommt am Ende Hinweis auf manuelles Trennen unter strava.com/settings/apps) → danach `supabase.rpc('delete_athlete_account', { p_athlete_id })`; Supabase-Funktion `delete_athlete_account(p_athlete_id UUID)` (SECURITY DEFINER, siehe Kapitel 18) löscht in einer Transaktion chat_messages → coach_decisions → weekly_plans → activities → season_goals → athletes (FK-Reihenfolge), Rückgabe = Anzahl gelöschter athletes-Zeilen (Client verifiziert `=== 1`); bei Fehler automatischer Rollback, Athlet bleibt eingeloggt mit Fehlermeldung im Modal; `p_athlete_id` kommt ausschließlich aus dem geladenen Session-Athleten, nie aus Query-Parametern; bei Erfolg identischer Cleanup wie Logout (`localStorage`/`sessionStorage`/`pf_athlete_id`-Cookie) + Redirect zu `/`

### Saison-Ziele
- [x] A/B/C-Priorität, Countdown in Tagen, Add/Edit-Modal
- [x] Deaktivieren (active = false, kein DELETE)

### Wochenplan
- [x] Plan-Generierung mit harten Constraints + sportwissenschaftlichen Regeln
- [x] Krafttraining-Rotation: Workout I → II → III → I (Prompt erzwingt via Self-Check)
- [x] DayCard: Kraft zeigt violettes Badge "Workout I/II/III" (kein Freitext), Laufen zeigt nie distance_km
- [x] Frontend-Constraint-Validierung + Violation-Banner
- [x] INSERT-only mit version++
- [x] Wochen-Navigation (±1 Woche), Wochenreview mit eigener Versionierung der bewerteten Woche (`review_notes`/`review_user_input`); gewählte Woche (`monday`) wird in `sessionStorage` (`weeklyplan_monday`) gespiegelt — überlebt damit Unmount/Remount beim Navigieren zu `/activity/:id` und zurück (sonst würde der "Zurück"-Sprung aus einer Aktivität immer in der aktuellen statt der zuvor betrachteten Woche landen), analog zum `dashboard_filter`-Pattern
- [x] Manuelles Verschieben von Trainingstagen: Drag & Drop (`swapDays()`, @dnd-kit) zum Tauschen zweier Tage + Long-Press-Kontextmenü (500ms, 8px Toleranz — "Als Ruhetag markieren"/"Verschieben nach..."/"Details anzeigen") als Fallback; Client-seitige Konflikt-Prüfung `checkPlanConflicts()` (kein Claude-Call); iOS-natives Textauswahl-Menü bei Long-Press unterdrückt via `select-none` + `WebkitTouchCallout: 'none'` auf der DayCard
- [x] ISO 8601 Wochengrenzen: getISOMonday/getISOSunday in dateUtils.ts; Lokalzeit statt UTC für week_start
- [x] Activity-Query mit vollen ISO-Timestamps (gte/lte) statt Datums-Strings — Sonntage korrekt der Vorwoche zugeordnet

### Chat
- [x] Supabase-persistente Messages, Supabase-first Flow
- [x] Thread-ID = `athlete.id` (nicht localStorage) — ein einziger persistenter `chat_type='global'`-Thread pro Athlet, überlebt PWA-Reinstalls (iOS "Icon entfernen + neu hinzufügen" leert `localStorage`, was vorher zu einer neuen Zufalls-Thread-ID und "verlorenem" Chat-Verlauf führte); "Neu"-Button in Chat.tsx leert nur die lokale Ansicht (kein neuer Thread), Verlauf bleibt in Supabase und erscheint nach Reload wieder
- [x] Message-Anzeige: lädt die neuesten 50 Nachrichten je Thread (`order('created_at', {ascending: false}).limit(50)`, danach für die chronologische Anzeige `.reverse()`) — vorher `ascending: true` + `limit(50)`, was bei >50 Nachrichten dauerhaft die **ältesten** 50 zeigte statt der neuesten (Bug: neue Nachrichten schienen nach dem Senden nicht anzukommen)
- [x] Typing-Indicator, Auto-resize Textarea
- [x] "In Plan übernehmen"-Button unter der letzten Coach-Nachricht — siehe Coach-System-Sektion oben

### Push Notifications
- [x] Zwei Vercel-Cron-Slots an die geplante Einheit des Tages, keine automatische DST-Anpassung: `?slot=morning` (`0 5 * * *` = 07:00 CEST, sendet immer bei Nicht-Ruhetag) und `?slot=evening` (`0 15 * * *` = 17:00 CEST, sendet nur wenn für den Athleten noch keine Strava-Aktivität "heute" erfasst wurde — geprüft über explizite Europe/Vienna-Tagesgrenzen via `Intl` `longOffset`, DST-sicher statt hartcodiertem Offset)
- [x] `push_subscriptions` braucht wie alle anderen Tabellen eine `"... : open for now"`-RLS-Policy (`USING (true) WITH CHECK (true)`) — RLS aktivieren allein reicht nicht, ohne Policy blockiert Postgres den Anon-Key-Insert lautlos (kein Fehler von `supabase-js`); `saveSubscription()` prüft seitdem zusätzlich den `error`-Rückgabewert des Upserts statt ihn zu ignorieren
- [x] `vite-plugin-pwa` von `generateSW` auf `injectManifest` umgestellt (Voraussetzung für eigenen `push`-Handler in `src/sw.ts`); Precaching/skipWaiting/clientsClaim/cleanupOutdatedCaches manuell in `sw.ts` statt automatisch generiert
- [x] iOS-Feature-Detection in `src/lib/push.ts` (`getPushSupport()`): Web Push funktioniert auf iOS ausschließlich für zum Home-Bildschirm hinzugefügte PWAs (`display-mode: standalone`), nie im Safari-Tab, erst ab iOS 16.4 — Profile.tsx zeigt bei fehlendem Standalone-Modus eine Anleitung statt eines wirkungslosen Buttons
- [x] Bekanntes iOS-Verhalten (Push-Subscriptions verfallen serverseitig nach Inaktivität, ohne dass Permission-State das anzeigt) abgefangen durch `syncPushSubscription()`: stiller Re-Subscribe-Check bei jedem App-Start (App.tsx Layout), sobald Permission bereits erteilt ist UND `athletes.push_opted_out = false` ist. Das Opt-out-Flag lebt bewusst serverseitig statt (nur) in `localStorage` — `Notification.permission` bleibt nach dem Abmelden `'granted'` (kann JS nicht zurücksetzen), und `localStorage.clear()` läuft sowohl beim Logout als auch beim iOS-Trick "Icon entfernen + neu hinzufügen"; ein rein lokales Flag hätte einen bewussten Abmelde-Klick in beiden Fällen wieder rückgängig gemacht (genau dieser Bug trat live auf: `disablePushNotifications()` löschte die Subscription, doch `syncPushSubscription()` legte sie beim nächsten Start klaglos neu an)
- [x] `push_subscriptions` (Supabase): ein Athlet kann mehrere Geräte/Endpoints haben; `api/send-daily-reminder.ts` löscht Einträge automatisch bei HTTP 404/410 (abgelaufene Subscription)
- [x] `api/send-daily-reminder.ts` berechnet "heute"/Wochenstart explizit über `Intl.DateTimeFormat(..., { timeZone: 'Europe/Vienna' })` statt `new Date().getDay()` — die Vercel-Cron-Runtime läuft in UTC, ein naiver Ansatz hätte denselben UTC-Slice-Bug-Typ reproduziert, der in diesem Projekt bereits mehrfach aufgetreten ist (siehe PEAKFORM_ROADMAP.md)
- [ ] Sync-Bestätigungs-Push (wenn neue Aktivität von Strava importiert wurde) — bewusst nicht in dieser ersten Runde, siehe Roadmap

### Kalender-Export (ICS)
- [x] `api/calendar/[athleteId].ts`: öffentlicher, abonnierbarer ICS-Feed (`text/calendar`) ohne Session-Auth — `athleteId` (UUID) in der URL dient als Capability-Token, konsistent mit der bereits offenen RLS-Policy im Rest des Projekts
- [x] `api/_lib/ics.ts` (`buildIcsFeed`): reine RFC-5545-Generierung, dedupliziert `weekly_plans` auf die neueste `version` je `week_start`; filtert Wochen vor der aktuellen Woche aus (`currentWeekStartVienna()`, Montag der laufenden Woche in Europe/Vienna, analog `viennaTodayInfo()` in `api/send-daily-reminder.ts`) — der Feed enthält damit nie Vergangenheits-Aktivitäten, nur die laufende und zukünftige Wochen; Ruhetage werden ausgelassen (kein Event); All-Day-Events (`DTSTART/DTEND;VALUE=DATE`) mit TZ-unabhängiger UTC-Datumsarithmetik (kein `new Date(y,m,d)` in Lokalzeit, da die Funktion sowohl in der Vercel-Function [UTC] als auch der Vite-Dev-Middleware läuft)
- [x] Titel-Schema: Kraft `💪🍑 Workout I/II/III` (description ist dort immer kurz), Lauf `🏃 Laufen · Xmin`, Rad `🚴 Radfahren · Xmin` — der freie Coaching-Fließtext aus `description` steht bei Lauf/Rad in `DESCRIPTION`, nicht im `SUMMARY` (sonst unlesbar langer Kalendertitel)
- [x] UID pro Event stabil (`${athleteId}-${week_start}-${Tag}@peakform.app`), damit wiederholtes Abo-Polling keine Duplikate erzeugt, sondern bestehende Events aktualisiert
- [x] Profile.tsx "Kalender"-Sektion: Button kopiert `webcal://<host>/api/calendar/<athleteId>` in die Zwischenablage + kurze Anleitung für Apple Kalender (Einstellungen → Accounts → Account hinzufügen → Andere → Kalenderabo hinzufügen)
- [x] Lokale Dev-Middleware `/api/calendar` in vite.config.ts (analog zu `/api/analyse` + `/api/strava-token`), nutzt dieselbe `buildIcsFeed()`-Logik aus `api/_lib/ics.ts`

### Sicherheit
- [x] STRAVA_CLIENT_SECRET und ANTHROPIC_API_KEY nie im Browser-Bundle
- [x] `/api/analyse`: Prompt-Size-Limit (80k), max_tokens Cap (4096), generische Fehler
- [x] Null-Guards für fehlende Athlete/Activity-Daten

### Deployment
- [x] Git-Repo: `abartmarkus-pixel/peakform` (privat), Branch `main`
- [x] Vercel: `peakform-wheat.vercel.app`, Auto-Deploy bei Push auf main
- [x] Git-Author-Email: `abart.markus@gmail.com` (global konfiguriert)

## Was fehlt noch (optional)
- Mehr als 10 Aktivitäten (Pagination)
- CTL / ATL / TSB Fitness-Kurve
- P3/P4 Code-Qualität: `select('*')` einschränken, OAuth State-Parameter

## Wichtige Implementierungsdetails
- Auth-State: `athlete_strava_id` in `localStorage` + `sessionStorage` (kein Supabase Auth)
- Session-Wiederherstellung: App.tsx prüft beim Start localStorage → sessionStorage → `restoreSessionFromSupabase()` (Supabase-Fallback: identifiziert den Athleten über das persistente `pf_athlete_id`-Cookie via `.eq('strava_athlete_id', …)`, kein `LIMIT 1` — jedes Gerät/Browser stellt so nur seinen eigenen Account wieder her, auch bei mehreren Athleten); Loading-Splash während Supabase-Check
- Logout: `localStorage.clear()` + `sessionStorage.clear()` → Redirect zu `/`
- Streams-Cache: `streams_json` in Supabase — wird beim ersten Aufruf gecacht
- Claude API wird **nie** direkt vom Browser aufgerufen — immer über `/api/analyse`
- Strava Token-Exchange/-Refresh: **nie** direkt vom Browser — immer über `/api/strava-token`
- `buildCoachSystemPrompt(athleteId)`: async, lädt bei jedem Call Athleten+A-Event aus DB; bei JEDEM fetch zu `/api/analyse` als `system` mitgeschickt
- `buildCoachContext()`: alle Queries parallel, niemals raw streams_json
- `weekly_plans`: INSERT-only Pattern (version++), niemals UPDATE
- `weekly_plans.week_start`: YYYY-MM-DD in Lokalzeit — NIEMALS `toISOString().slice(0,10)` verwenden (gibt UTC zurück, -1 Tag in CET/CEST). Stattdessen `getFullYear()/getMonth()/getDate()` nutzen (siehe `toDateStr` in WeeklyPlan.tsx und `mondayOf` in coachContext.ts)
- `weekly_plans` Activity-Query: `gte('date', monday.toISOString())` + `lte('date', getISOSunday(monday).toISOString())` — volle ISO-Timestamps, keine Datums-Strings
- `sport_types`: JSONB `[{type, days}]`; Invariante `Σdays ≤ training_days_per_week` technisch erzwungen
- `parseReviewJson()` und `parsePlanJson()`: beide mit Markdown-Code-Block-Fallback
- Postgres ENUM `goal_priority`: DO-Block-Pattern für idempotente Erstellung
- `activities.description`: Cache-first — bei WeightTraining erst Supabase prüfen, nur bei null von Strava holen
- WeeklyPlan Kraft-Einheiten: `description` = "Workout I/II/III" (nie Freitext); Laufen: `distance_km` immer null
- `coach_decisions.related_activity_id`: FK→activities, gesetzt bei `decision_type = 'recovery_required'` und `'stimulus_insufficient'`
- `activities.avg_watts`/`elevation_m`/`np_watts`: alle drei kommen aus Stravas Summary-Response (`syncActivitiesToSupabase()`), niemals lokal aus `streams_json` neu berechnet — lokale Mittelwertbildung über den rohen watts/altitude-Stream war die Ursache für einen Ø-Watt/Höhenmeter-Bug (Nullen im watts-Stream beim Mitteln ausgeklammert → zu hoher Ø-Watt; unsmoothe Barometer-Rohdaten → zu hohe Höhenmeter)
