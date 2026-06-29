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
-- Phase 1
athletes (id uuid PK, strava_athlete_id bigint UNIQUE, strava_access_token text,
          strava_refresh_token text, expires_at timestamptz,
          -- Phase 2 Felder:
          name text,
          ftp_watts int, max_hr int, weight_kg numeric,
          training_days_per_week int,
          sport_types jsonb,          ← SportConfig[] {type, days}; cycling/running/strength
          body_goals text[],          ← Mehrfachauswahl: Event/Muskelaufbau/Gewicht reduzieren/Nackt gut ausschauen
          coach_persona jsonb, 
          created_at timestamptz)

activities (id uuid PK, athlete_id uuid FK→athletes, strava_id bigint UNIQUE,
            name text, type text, date timestamptz,
            distance_m numeric, duration_s int, avg_hr numeric, max_hr numeric,
            np_watts numeric, tss numeric, streams_json jsonb,
            description text,       ← Strava description (Hevy-Daten); beim 1. Öffnen gecacht
            claude_analysis text, created_at timestamptz)

-- Phase 2
season_goals (id uuid PK, athlete_id uuid FK→athletes, event_name text,
              event_date date, distance_km numeric, elevation_m int,
              priority goal_priority ENUM('A','B','C'), sport_type text,
              notes text, active bool, created_at timestamptz)

weekly_plans (id uuid PK, athlete_id uuid FK→athletes, week_start date,
              version int, plan_json jsonb, review_notes text,
              change_reason text, plan_constraint_violation bool,
              created_at timestamptz)
-- INSERT-only, niemals UPDATE bestehender Pläne; version wird inkrementiert

coach_decisions (id uuid PK, athlete_id uuid FK→athletes, decision_type text,
                 decision_summary text, reasoning text,
                 related_plan_id uuid FK→weekly_plans, created_at timestamptz)

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
│   ├── pages/
│   │   ├── Home.tsx        # Strava-Connect-Button
│   │   ├── AuthCallback.tsx # OAuth Code → /api/strava-token → Supabase upsert
│   │   ├── Dashboard.tsx   # 4 Nav-Kacheln (Coach/Plan/Ziele/Profil) + Letzte Aktivitäten + Filter (🏋️🚴🏃)
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Übungstabelle + Claude-Analyse
│   │   ├── Profile.tsx     # "Profil" — Name, FTP/HF/Gewicht, Sportarten (JSONB accordion), Ziele, Coach; Auto-Save 800ms
│   │   │                   # Sportarten-Stepper: − bei 1 Tag entfernt Sportart (days→0 = remove)
│   │   ├── Goals.tsx       # Saisonziele A/B/C, Countdown in Tagen, Add/Edit-Modal
│   │   ├── WeeklyPlan.tsx  # Wochenplan + Constraint-Prompt + Validation-Banner + Wochenreview
│   │   └── Chat.tsx        # Globaler Coach-Chat mit Supabase-Persistenz
│   ├── lib/
│   │   ├── supabase.ts     # Supabase Client + Types (Athlete, Activity, SportConfig, SeasonGoal, WeeklyPlan, ...)
│   │   ├── strava.ts       # OAuth URL, Token Exchange via /api/strava-token, Activities, Streams, Laps
│   │   ├── coachContext.ts # buildCoachContext(): 8 Abschnitte inkl. [HARTE TRAININGS-CONSTRAINTS]
│   │   └── coachPrompt.ts  # COACH_SYSTEM_PROMPT — wird bei JEDEM Claude-Call als system-Parameter übergeben
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

### Phase 1
- [x] React + Vite + Tailwind + PWA (theme_color: #1D9E75)
- [x] Supabase-Tabellen + RLS
- [x] Strava OAuth 2.0 Flow (code → /api/strava-token server-side → Supabase)
- [x] Strava Token-Refresh (automatisch, 60s Buffer, via /api/strava-token)
- [x] Dashboard: letzte 10 Aktivitäten, in Supabase gecacht
- [x] Dashboard: 4 quadratische Nav-Kacheln (💬 Coach / 📅 Plan / 🎯 Ziele / 👤 Profil)
- [x] Dashboard: Filter nach Trainingsart (🏋️🚴🏃), Logout-Icon
- [x] Aktivitäts-Detail: Stats-Grid, Charts, Rundentabelle, Claude-Analyse
- [x] Markdown-Renderer

### Krafttraining-Detailansicht (WeightTraining) ✅
- Hevy → Strava description Parser (`parseHevyDescription`)
- Übungskarten mit Volumen-Pill + Muskelgruppe-Pill
- Claude-Prompt mit Athleten-Name, Übungen, Gesamtvolumen

### Phase 2 — Coach Core + Memory Architecture ✅
- [x] DB-Schema: 4 neue Tabellen + athletes-Profilfelder
- [x] coachContext.ts: `buildCoachContext(athleteId, threadId)` — 8 Abschnitte parallel
- [x] Profile.tsx: Name, FTP/HF/Gewicht, Sportarten-Akkordeon (Stepper, − bei 1 = entfernen), body_goals, Coach-Stil
- [x] Goals.tsx: Saisonziele A/B/C, Countdown in Tagen
- [x] WeeklyPlan.tsx: Constraint-Prompt + Frontend-Validation + Violation-Banner + Wochenreview
- [x] Chat.tsx: Globaler Coach-Chat, Supabase-first Flow
- [x] **COACH_SYSTEM_PROMPT** (`src/lib/coachPrompt.ts`): bei jedem Claude-Call als `system`-Parameter
  - Athleten-Profil (Markus, 40+, Innsbruck, FTP 229W, Schulter beachten)
  - Primärziel: 8k-Laufevent 1. Oktober 2026, Zielpace 5:08–5:22 min/km
  - 14-Wochen-Periodisierung (Phase 1–4: Readaptation/Grundlage/Wettkampf/Taper)
  - HF-Zonen (Max HF 182), Pace-Referenz, Coaching-Prinzipien
  - buildCoachContext() bleibt als User-Message-Inhalt (nicht im system)

### Sicherheit & Stabilität (nachträglich gepatcht) ✅
- [x] Strava Client Secret aus Browser-Bundle entfernt → `/api/strava-token` (server-side)
- [x] `/api/analyse`: Prompt-Size-Limit, max_tokens-Cap (4096), generische Fehler
- [x] ActivityDetail: Null-Guard für fehlende Athlete/Activity-Daten
- [x] WeeklyPlan: `parseReviewJson()` mit Markdown-Fallback statt rohem `JSON.parse()`
- [x] WeeklyPlan: Constraint-Check auch für Review-generierten Folgewochenplan
- [x] WeeklyPlan: training_days Default 0 + Fehlermeldung statt stillem Default 7
- [x] Profile Stepper: Sportart-Tage können auf 0 (= Entfernen der Sportart)

### UX & Feature-Updates (2026-06-27) ✅
- [x] Home.tsx: Auto-Redirect zu `/dashboard` wenn `athlete_strava_id` in localStorage
- [x] activities: Spalte `description text` — Strava/Hevy-Description wird beim ersten Öffnen gecacht
- [x] ActivityDetail: Cache-first für description (Supabase → Strava-API Fallback)
- [x] WeeklyPlan — Kraft-Rotation: Workout I → II → III → I, Prompt erzwingt Reihenfolge via Self-Check
- [x] WeeklyPlan — DayCard: Kraft zeigt kein Freitext-Description; violettes Badge "Workout I/II/III"

### Deployment ✅
- [x] Git-Repo: `abartmarkus-pixel/peakform` (privat), Branch `main`
- [x] Vercel: `peakform-wheat.vercel.app`, Auto-Deploy bei Push auf main
- [x] Strava Callback-Domain: `peakform-wheat.vercel.app`
- [x] Git-Author-Email: `abart.markus@gmail.com` (global konfiguriert)

## Was fehlt noch (optional)
- Mehr als 10 Aktivitäten (Pagination)
- CTL / ATL / TSB Fitness-Kurve
- P3/P4 Code-Qualität: `select('*')` einschränken, OAuth State-Parameter

## Wichtige Implementierungsdetails
- Auth-State: `athlete_strava_id` in `localStorage` (kein Supabase Auth)
- Streams-Cache: `streams_json` in Supabase — wird beim ersten Aufruf gecacht
- Claude API wird **nie** direkt vom Browser aufgerufen — immer über `/api/analyse`
- Strava Token-Exchange/-Refresh: **nie** direkt vom Browser — immer über `/api/strava-token`
- `buildCoachContext()`: alle 8 Queries parallel, niemals raw streams_json
- `weekly_plans`: INSERT-only Pattern (version++), niemals UPDATE
- `sport_types`: JSONB `[{type, days}]`, Stepper-Minimum ist 0 (entfernt Eintrag)
- `COACH_SYSTEM_PROMPT`: importiert aus `src/lib/coachPrompt.ts`, bei jedem fetch zu `/api/analyse` als `system` mitgeschickt
- `parseReviewJson()` und `parsePlanJson()`: beide mit Markdown-Code-Block-Fallback
- Postgres ENUM `goal_priority`: DO-Block-Pattern für idempotente Erstellung
- `activities.description`: Cache-first — bei WeightTraining erst Supabase prüfen, nur bei null von Strava holen und speichern
- WeeklyPlan Kraft-Einheiten: `description` = "Workout I" / "Workout II" / "Workout III" (nie Freitext); Rotation wird im Prompt mit Self-Check erzwungen; DayCard zeigt Badge statt Paragraph
