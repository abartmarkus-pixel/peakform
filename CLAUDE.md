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
| Hosting | Vercel (noch nicht deployed) |
| PWA | vite-plugin-pwa |

## Supabase-Projekt
- **Name:** peakform
- **Project ID:** `thjihbyyelqrrvdinzti`
- **URL:** `https://thjihbyyelqrrvdinzti.supabase.co`
- **Region:** eu-central-1

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
│   └── analyse.ts          # Vercel Serverless Function → Claude API Proxy (max_tokens optional)
├── src/
│   ├── App.tsx             # Router: / | /auth/callback | /dashboard | /activity/:id
│   │                       #         /profile | /goals | /plan | /chat
│   ├── pages/
│   │   ├── Home.tsx        # Strava-Connect-Button
│   │   ├── AuthCallback.tsx # OAuth Code → Token Exchange → Supabase upsert
│   │   ├── Dashboard.tsx   # 4 Nav-Kacheln (Coach/Plan/Ziele/Profil) + Letzte Aktivitäten + Filter (🏋️🚴🏃)
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Übungstabelle + Claude-Analyse
│   │   ├── Profile.tsx     # "Profil" — Name, FTP/HF/Gewicht, Sportarten (JSONB accordion), Ziele, Coach; Auto-Save 800ms
│   │   ├── Goals.tsx       # Saisonziele A/B/C, Countdown in Tagen, Add/Edit-Modal
│   │   ├── WeeklyPlan.tsx  # Wochenplan + Constraint-Prompt + Validation-Banner + Wochenreview
│   │   └── Chat.tsx        # Globaler Coach-Chat mit Supabase-Persistenz
│   ├── lib/
│   │   ├── supabase.ts     # Supabase Client + Types (Athlete, Activity, SportConfig, SeasonGoal, WeeklyPlan, ...)
│   │   ├── strava.ts       # OAuth URL, Token Exchange, Activities, Streams, Laps, ActivityDetail
│   │   └── coachContext.ts # buildCoachContext(): 8 Abschnitte inkl. [HARTE TRAININGS-CONSTRAINTS]
│   └── vite-env.d.ts       # Env-Variable-Types
├── vite.config.ts          # PWA-Config + /api/analyse Middleware für lokales Dev
├── vercel.json             # SPA Rewrites + SW Cache-Header
└── .env                    # Credentials (nicht committen!)
```

## Env-Variablen (.env)
```
VITE_SUPABASE_URL=https://thjihbyyelqrrvdinzti.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_STRAVA_CLIENT_ID=260874
VITE_STRAVA_CLIENT_SECRET=...
VITE_STRAVA_REDIRECT_URI=http://localhost:5173/auth/callback  ← nach Deploy anpassen!
ANTHROPIC_API_KEY=...   ← kein VITE_ Prefix (nur serverseitig)
```

## Lokale Entwicklung
```bash
npm run dev       # Vite Dev-Server auf localhost:5173
                  # /api/analyse wird als Vite-Middleware gehandelt (kein vercel dev nötig)
```

## Was ist implementiert ✅

### Phase 1
- [x] React + Vite + Tailwind + PWA (theme_color: #1D9E75)
- [x] Supabase-Tabellen + RLS
- [x] Strava OAuth 2.0 Flow (code → token → Supabase)
- [x] Strava Token-Refresh (automatisch, 60s Buffer, `expires_at` in athletes-Tabelle)
- [x] Dashboard: letzte 10 Aktivitäten, in Supabase gecacht
- [x] Dashboard: 4 quadratische Nav-Kacheln (💬 Coach / 📅 Plan / 🎯 Ziele / 👤 Profil) unter PeakForm-Logo
- [x] Dashboard: Filter nach Trainingsart (🏋️ Krafttraining / 🚴 Radfahren / 🏃 Laufen), Toggle, rechts neben Heading
- [x] Dashboard: Logout-Icon (kein Text) oben rechts neben PeakForm
- [x] Aktivitäts-Detail:
  - Stats-Grid (Distanz, Dauer, Höhenmeter, Ø/Max Tempo, HF, Watt, Trittfrequenz, NP)
  - Watt-Chart (gelb), HF-Chart (rot, nur bei Nicht-Krafttraining), Höhenprofil (grün)
  - Rundentabelle (via Strava Laps API)
  - Claude-Analyse mit Rundenanalyse wenn Runden vorhanden
  - Analyse-Ergebnis in Supabase gespeichert (kein Re-Fetch nötig)
- [x] Markdown-Renderer (fett, Überschriften, Bullets, Blockquotes, Divider)

### Krafttraining-Detailansicht (WeightTraining) ✅
- Übungsdaten kommen via Hevy → Strava-Sync als `description` im Activity-Detail-Endpoint
- `fetchActivityDetail` ruft `/api/v3/activities/{id}` ab (nicht gecacht, frisch bei jedem Aufruf)
- Parser (`parseHevyDescription`) extrahiert Übungen, Sätze, Gewicht × Wiederholungen
- Übungskarten: Name | Volumen-Pill (amber) + Muskelgruppe-Pill (sky-blau) | Set-Chips
- Gesamtvolumen als dritte Kachel im Stats-Grid + Banner unter der Übungsliste
- Claude-Prompt enthält Athleten-Name, alle Übungen mit Sätzen + Gesamtvolumen

### Phase 2 — Coach Core + Memory Architecture ✅
- [x] **Step 1 — DB-Schema:** 4 neue Tabellen + athletes-Profilfelder
- [x] **Step 2 — coachContext.ts:** `buildCoachContext(athleteId, threadId)` — 8 Abschnitte parallel:
  - [ATHLETEN-PROFIL] mit Name
  - [HARTE TRAININGS-CONSTRAINTS] — Gesamttage, Ruhetage, Sportarten-Verteilung (neu)
  - [SAISON-ZIELE] mit A-Event Countdown in Tagen
  - [AKTUELLER WOCHENPLAN], [TRAININGSHISTORIE — LETZTE 4 WOCHEN]
  - [PLAN-HISTORY — LETZTE 3 VERSIONEN], [COACH-ENTSCHEIDUNGEN — LETZTE 5]
  - [AKTUELLE CHAT-SESSION]
- [x] **Step 3 — Profile.tsx:** "Profil"-Seite:
  - Allgemein: Name-Feld (fließt in alle Claude-Prompts)
  - Leistungsdaten: FTP, Max HF, Gewicht
  - Training: Trainingstage/Woche (Toggle 1–7), Sportarten (Single-Select Akkordeon mit Tage-Stepper, Gesamtzähler)
  - Sportarten-Struktur: `SportConfig[] = [{type: 'cycling'|'running'|'strength', days: number}]`, JSONB in DB
  - Ziele: Event / Muskelaufbau / Gewicht reduzieren / Nackt gut ausschauen (Mehrfachauswahl, body_goals text[])
  - Coach-Stil + Fokus; Debounce-Auto-Save 800ms
- [x] **Step 4 — Goals.tsx:** Saisonziele A/B/C, Countdown in **Tagen** (nicht Wochen), Deaktivieren statt Löschen
- [x] **Step 5 — WeeklyPlan.tsx:** Wochennavigation, Plan-Generierung mit:
  - Hartem Constraint-Prompt (exakte Tage pro Sportart, sportwissenschaftliche Reihenfolge, Self-Check)
  - Frontend-Validation: zählt Trainingstage + Sportarten-Tage im JSON
  - Violation-Banner: "Neu generieren" | "Trotzdem speichern" (speichert mit `plan_constraint_violation: true`)
- [x] **Step 6 — Wochenreview:** In WeeklyPlan integriert
- [x] **Step 7 — Chat.tsx:** Globaler Coach-Chat, 6-Schritt Supabase-first Flow

## Was fehlt noch (Priorität)

### 1. Vercel Deploy
- `vercel deploy --prod` oder via Vercel Dashboard
- Env-Variablen auf Vercel setzen (ohne `VITE_` für `ANTHROPIC_API_KEY`)
- `VITE_STRAVA_REDIRECT_URI` auf `https://peakform.vercel.app/auth/callback` setzen
- In Strava API Settings: Authorization Callback Domain `peakform.vercel.app` hinzufügen

### 2. Phase 3 (optional)
- Mehr als 10 Aktivitäten (Pagination)
- CTL / ATL / TSB Fitness-Kurve
- Wochenübersicht mit Volumen und Load

## Wichtige Implementierungsdetails
- Auth-State: `athlete_strava_id` in `localStorage` (kein Supabase Auth)
- Streams-Cache: `streams_json` in Supabase — wird beim ersten Aufruf von Strava geladen und gecacht
- Claude API wird **nie** direkt vom Browser aufgerufen — immer über `/api/analyse`
- Für lokales Dev: `/api/analyse` als Vite-Middleware in `vite.config.ts`
- Für Produktion: `api/analyse.ts` als Vercel Serverless Function
- `buildCoachContext()`: alle 8 Queries parallel via `Promise.all`, niemals raw streams_json
- `weekly_plans`: INSERT-only Pattern (version inkrementieren), niemals bestehende Pläne updaten
- `sport_types` in athletes: JSONB, Format `[{type, days}]`, Schlüssel: cycling/running/strength
- `body_goals` in athletes: `text[]`, Mehrfachauswahl
- `countdown()` in Goals.tsx + coachContext.ts: gibt Tage zurück (nicht Wochen)
- `validateConstraints()` in WeeklyPlan.tsx: prüft Trainingstage + Sportarten nach Plan-Generierung
- `plan_constraint_violation: true` wenn User "Trotzdem speichern" wählt
- `thread_id` für Chat: localStorage-Key `coach_thread_id`
- Postgres ENUM `goal_priority`: DO-Block-Pattern für idempotente Erstellung
