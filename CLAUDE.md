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
          best_5k_seconds int,         ← 5k-Bestzeit in Sekunden (Basis für Pace-Berechnung)
          created_at timestamptz)

activities (id uuid PK, athlete_id uuid FK→athletes, strava_id bigint UNIQUE,
            name text, type text, date timestamptz,
            distance_m numeric, duration_s int, avg_hr numeric, max_hr numeric,
            np_watts numeric, tss numeric, streams_json jsonb,
            description text,       ← Strava description (Hevy-Daten); beim 1. Öffnen gecacht
            claude_analysis text, created_at timestamptz,
            laps_json jsonb, splits_metric_json jsonb,
            recovery_checked bool,   ← true nach erstem Recovery-Check, unabhängig vom Ergebnis;
                                      -- verhindert wiederholten Mini-Claude-Call bei jedem Seitenaufruf
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
                 related_activity_id uuid FK→activities,  ← gesetzt bei 'recovery_required'
                 created_at timestamptz)

chat_messages (id uuid PK, thread_id uuid, athlete_id uuid FK→athletes,
               role text CHECK('user','assistant'), content text,
               chat_type text, activity_id uuid, created_at timestamptz)
```
RLS aktiv, aktuell offene Policy (für persönlichen Einsatz ok).

## Projektstruktur
```
peakform/
├── api/
│   ├── analyse.ts          # Vercel Serverless Function → Claude API Proxy
│   │                       # Params: prompt, max_tokens?, system?
│   │                       # Limits: 80k Zeichen, max_tokens Cap 4096, generische Fehler
│   └── strava-token.ts     # Vercel Serverless Function → Strava OAuth Token Exchange/Refresh
│                           # (STRAVA_CLIENT_SECRET serverseitig, nie im Browser-Bundle)
├── src/
│   ├── App.tsx             # Router: / | /auth/callback | /dashboard | /activity/:id
│   │                       #         /profile | /goals | /plan | /chat
│   │                       # Session-Guard in Layout: localStorage → sessionStorage → restoreSessionFromSupabase()
│   │                       # Loading-Splash "PeakForm wird geladen…" während Supabase-Check
│   ├── pages/
│   │   ├── Home.tsx        # Strava-Connect-Button; Auto-Redirect zu /dashboard (prüft localStorage + sessionStorage)
│   │   ├── AuthCallback.tsx # OAuth Code → /api/strava-token → Supabase upsert → localStorage + sessionStorage
│   │   ├── Dashboard.tsx   # 4 Nav-Kacheln + Letzte Aktivitäten + Filter (🏋️🚴🏃) + Echtzeit-Alert
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Übungstabelle + Claude-Analyse
│   │   ├── Profile.tsx     # Name, FTP/HF/Gewicht, Sportarten, Equipment, Ästhetik, Trainingsphase; Auto-Save 800ms
│   │   │                   # Sportarten-Stepper: Invariante Σdays ≤ trainingDays technisch erzwungen
│   │   ├── Goals.tsx       # Saisonziele A/B/C, Countdown in Tagen, Add/Edit-Modal
│   │   ├── WeeklyPlan.tsx  # Wochenplan + Constraint-Prompt + Validation-Banner + Wochenreview
│   │   └── Chat.tsx        # Globaler Coach-Chat mit Supabase-Persistenz
│   ├── lib/
│   │   ├── supabase.ts     # Supabase Client + Types (Athlete, Activity, SportConfig, SeasonGoal, WeeklyPlan, CoachDecision, ...)
│   │   ├── strava.ts       # OAuth URL, Token Exchange via /api/strava-token, Activities, Streams, Laps
│   │   │                   # restoreSessionFromSupabase(): Session-Wiederherstellung aus Supabase (Single-User)
│   │   ├── dateUtils.ts    # ISO 8601 Datums-Helpers: getISOMonday(date), getISOSunday(monday), formatWeekRange(monday)
│   │   │                   # Woche beginnt Montag; toDateStr nutzt Lokalzeit (nicht UTC) — kritisch für CET/CEST
│   │   ├── coachContext.ts # buildCoachContext(): 8 Abschnitte inkl. [HARTE TRAININGS-CONSTRAINTS]
│   │   │                   # buildSpecialistContext(athleteId, sport): sportart-spezifische Historien
│   │   │                   # calculateSeasonPhase(), calculateHRZones(), calculatePaceReference() (exportiert)
│   │   └── coachPrompt.ts  # buildCoachSystemPrompt(athleteId): Promise<string> — dynamisch aus DB
│   │                       # LAUF_COACH_PROMPT | RAD_COACH_PROMPT | KRAFT_COACH_PROMPT (statisch)
│   └── vite-env.d.ts       # Env-Variable-Types
├── vite.config.ts          # PWA-Config + /api/analyse + /api/strava-token Middleware für lokales Dev
├── vercel.json             # SPA Rewrites + SW Cache-Header + Build-Config
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
- [x] Dashboard: Filter nach Trainingsart (🏋️🚴🏃), Logout-Icon
- [x] Home.tsx: Auto-Redirect zu `/dashboard` wenn `athlete_strava_id` in localStorage
- [x] Dashboard: Echtzeit-Alert (Claude-Konflikt-Check nach Strava-Sync, sessionStorage-Gate, Amber-Banner + Modal)
- [x] Aktivitäts-Detail: Stats-Grid, Charts, Rundentabelle, Claude-Analyse
- [x] Markdown-Renderer

### Krafttraining-Detailansicht (WeightTraining)
- [x] Hevy → Strava description Parser (`parseHevyDescription`)
- [x] Übungskarten mit Volumen-Pill + Muskelgruppe-Pill
- [x] activities.description: Cache-first (Supabase → Strava Detail-API Fallback)

### Coach-System
- [x] `buildCoachSystemPrompt(athleteId): Promise<string>` — dynamisch aus DB (FTP, Max HF, Saison-Phase, HF-Zonen, Pace-Referenz, A-Event)
- [x] `buildCoachContext(athleteId, threadId?)`: 8 Abschnitte parallel
- [x] `buildSpecialistContext(athleteId, sport)`: Lauf/Rad/Kraft-spezifische Historien
- [x] `LAUF_COACH_PROMPT` / `RAD_COACH_PROMPT` / `KRAFT_COACH_PROMPT`: statische Spezialcoaches
- [x] Coach-Routing (`getSpecialistPrompt(activityType)`) in ActivityDetail.tsx
- [x] `calculateSeasonPhase()`, `calculateHRZones()`, `calculatePaceReference()` in coachContext.ts
- [x] Recovery-Extraktion: `triggerRecoveryExtraction(analysisText, athleteId, activityId)` — fire-and-forget nach Analyse ODER beim Laden bestehender Analyse (on-load check: `if (act.claude_analysis && !act.recovery_checked)`); setzt `activities.recovery_checked=true` nach jedem Lauf unabhängig vom Ergebnis, bleibt bei Fehler `false` für Retry
- [x] Automatische Analyse nach Sync (`syncActivitiesToSupabase()` fire-and-forget-Sweep über `claude_analysis IS NULL`, sowie `WeeklyPlan.tsx`s `closeOutstandingAnalyses()`-Fallback) läuft pro Aktivität exakt einmal: `claimActivityForAnalysis(activityId)` claimt atomar über `analysis_claimed_at` (conditional UPDATE), bevor `analyzeActivity()` aufgerufen wird — verhindert doppelte Claude-Calls bei gleichzeitigen Syncs (React StrictMode Doppel-Mount, Dashboard+WeeklyPlan). Claim wird nach Erfolg/Fehlschlag zurückgesetzt; nach 2 Min als abgelaufen behandelt (Selbstheilung bei abgebrochenem Tab). Manueller "Neu analysieren"-Button in ActivityDetail.tsx umgeht den Claim bewusst (soll immer laufen)

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

### Saison-Ziele
- [x] A/B/C-Priorität, Countdown in Tagen, Add/Edit-Modal
- [x] Deaktivieren (active = false, kein DELETE)

### Wochenplan
- [x] Plan-Generierung mit harten Constraints + sportwissenschaftlichen Regeln
- [x] Krafttraining-Rotation: Workout I → II → III → I (Prompt erzwingt via Self-Check)
- [x] DayCard: Kraft zeigt violettes Badge "Workout I/II/III" (kein Freitext), Laufen zeigt nie distance_km
- [x] Frontend-Constraint-Validierung + Violation-Banner
- [x] INSERT-only mit version++
- [x] Wochen-Navigation (±1 Woche), Wochenreview mit eigener Versionierung der bewerteten Woche (`review_notes`/`review_user_input`)
- [x] Manuelles Verschieben von Trainingstagen: Drag & Drop (`swapDays()`, @dnd-kit) zum Tauschen zweier Tage + Long-Press-Kontextmenü (500ms, 8px Toleranz — "Als Ruhetag markieren"/"Verschieben nach..."/"Details anzeigen") als Fallback; Client-seitige Konflikt-Prüfung `checkPlanConflicts()` (kein Claude-Call); iOS-natives Textauswahl-Menü bei Long-Press unterdrückt via `select-none` + `WebkitTouchCallout: 'none'` auf der DayCard
- [x] ISO 8601 Wochengrenzen: getISOMonday/getISOSunday in dateUtils.ts; Lokalzeit statt UTC für week_start
- [x] Activity-Query mit vollen ISO-Timestamps (gte/lte) statt Datums-Strings — Sonntage korrekt der Vorwoche zugeordnet

### Chat
- [x] Supabase-persistente Messages, Supabase-first Flow
- [x] Thread-ID aus localStorage, Typing-Indicator, Auto-resize Textarea

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
- Session-Wiederherstellung: App.tsx prüft beim Start localStorage → sessionStorage → `restoreSessionFromSupabase()` (Supabase-Fallback, Single-User LIMIT 1); Loading-Splash während Supabase-Check
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
- `coach_decisions.related_activity_id`: FK→activities, gesetzt bei `decision_type = 'recovery_required'`
