# PeakForm — Produktspezifikation

> Verbindliche Spezifikation der PeakForm App.
> Beschreibt ausschließlich den tatsächlich implementierten Stand.
> Letzte Aktualisierung: 29. Juni 2026

---

## 1. Produkt-Überblick

PeakForm ist eine PWA (Progressive Web App) die als KI-Trainingscoach fungiert. Sie verbindet Strava-Aktivitätsdaten (Ausdauer + Krafttraining via Hevy-Description) mit Claude als Coach-Intelligenz und Supabase als persistentem Datenspeicher.

**Kernversprechen:** Der Coach kennt den Athleten, erinnert sich an Plan-History und Reviews, plant vorausschauend und gibt konkrete, datenbasierte Analyse-Antworten.

**Zielgruppe:** Aktuell 1 Nutzer (Markus). Architektur erlaubt mehrere Nutzer über `athlete_id`-Pattern, aber es gibt weder Supabase Auth noch öffentliches Onboarding.

**Live URL:** peakform-wheat.vercel.app  
**Repository:** github.com/abartmarkus-pixel/peakform (privat)  
**Branch:** `main` → Auto-Deploy auf Vercel  

---

## 2. Tech-Stack

| Layer | Technologie | Version |
|---|---|---|
| Frontend | React | 18.3 |
| Build | Vite | 5.3 |
| Styling | Tailwind CSS | 3.4 |
| Routing | React Router v6 | 6.24 |
| Charts | Recharts | 2.12 |
| Sprache | TypeScript | 5.2 |
| Backend/DB | Supabase (PostgreSQL) | @supabase/supabase-js 2.43 |
| Hosting | Vercel (Fluid Compute) | — |
| PWA | vite-plugin-pwa | 0.20 |
| KI | Claude Sonnet (claude-sonnet-4-6) via `/api/analyse` | — |
| Ausdauer/Kraft | Strava API v3 (scope: `read,activity:read_all`) | — |

**Kein Hevy API** — Krafttraining-Daten kommen aus der Strava-`description`-Spalte (Hevy schreibt Workouts automatisch in Strava-Beschreibungen).

---

## 3. Projektstruktur

```
peakform/
├── api/
│   ├── analyse.ts          # Vercel Serverless Function — Claude API Proxy
│   │                         Params: { prompt, max_tokens?, system? }
│   │                         Limits: 80.000 Zeichen, max_tokens Cap 4.096
│   └── strava-token.ts     # Vercel Serverless Function — Strava OAuth Token Exchange/Refresh
│                             STRAVA_CLIENT_SECRET ausschließlich server-seitig
├── src/
│   ├── App.tsx             # Router (8 Routen, alle ohne Supabase Auth)
│   ├── pages/
│   │   ├── Home.tsx           # Strava-Connect-Button; Auto-Redirect zu /dashboard
│   │   ├── AuthCallback.tsx   # OAuth-Code → /api/strava-token → Supabase upsert → localStorage
│   │   ├── Dashboard.tsx      # 4 Nav-Kacheln + letzte 10 Aktivitäten + Typ-Filter
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Hevy-Übungen + Claude-Analyse
│   │   ├── Profile.tsx        # Athleten-Profil mit 800ms Auto-Save
│   │   ├── Goals.tsx          # Saison-Ziele A/B/C + Countdown + Add/Edit-Modal
│   │   ├── WeeklyPlan.tsx     # Wochenplan-Generator + Constraint-Validierung + Review
│   │   └── Chat.tsx           # Globaler Coach-Chat mit Supabase-Persistenz
│   └── lib/
│       ├── supabase.ts        # Supabase Client + TypeScript-Types
│       ├── strava.ts          # OAuth URL, Token Exchange/Refresh via /api/strava-token, Activities, Streams, Laps
│       ├── coachContext.ts    # buildCoachContext(athleteId, threadId?) — 7 Abschnitte, alle parallel
│       └── coachPrompt.ts     # COACH_SYSTEM_PROMPT — statischer Export, aktuell hardcoded für Markus
├── vite.config.ts          # PWA-Config + /api/analyse + /api/strava-token Middleware für lokales Dev
├── vercel.json             # SPA Rewrites + SW Cache-Header
└── .env                    # Credentials (nicht committen)
```

---

## 4. Authentifizierung & Session

**Kein Supabase Auth.** Die App nutzt Strava OAuth 2.0 als einzigen Login-Mechanismus.

**Login-Flow:**
1. User klickt "Mit Strava verbinden" → `STRAVA_AUTH_URL` (scope: `read,activity:read_all`)
2. Strava redirectet zu `/auth/callback?code=...`
3. `AuthCallback.tsx` ruft `/api/strava-token` auf (POST, server-side)
4. Server tauscht Code gegen Token (`STRAVA_CLIENT_SECRET` bleibt server-seitig)
5. `athletes` Upsert in Supabase via `strava_athlete_id` als Konflikt-Key
6. `localStorage.setItem('athlete_strava_id', stravaId)` → Basis für alle weiteren Seiten

**Session-Check:** Jede Seite liest `localStorage.getItem('athlete_strava_id')` und navigiert zu `/` wenn null.

**Logout:** `localStorage.clear()` → Redirect zu `/`

**Token-Refresh:** Automatisch in `getValidAccessToken()` — 60s Buffer vor Ablauf, neuer Token via `/api/strava-token` (grant_type: `refresh_token`), Update in Supabase.

**athletes.id** ist eine eigene UUID (kein `auth.uid()`). RLS ist aktiv, aber auf offener Policy (kein User-Auth-Binding via auth.uid()).

---

## 5. Datenbankschema (Supabase PostgreSQL)

### athletes
```sql
id                    UUID PRIMARY KEY (eigene UUID, nicht auth.uid())
strava_athlete_id     BIGINT UNIQUE        -- Login-Identifier, in localStorage
strava_access_token   TEXT
strava_refresh_token  TEXT
expires_at            TIMESTAMPTZ
name                  TEXT
ftp_watts             INTEGER
max_hr                INTEGER
weight_kg             DECIMAL
training_days_per_week INTEGER             -- Gesamtzahl Trainingstage/Woche (1–7)
sport_types           JSONB                -- Format: [{type, days}]
coach_persona         JSONB                -- Format: {style, focus}
body_goals            TEXT[]               -- Mehrfachauswahl-Array
created_at            TIMESTAMPTZ
```

**sport_types JSONB Format (tatsächlich):**
```json
[
  { "type": "cycling",  "days": 2 },
  { "type": "running",  "days": 2 },
  { "type": "strength", "days": 1 }
]
```
- `type`: `"cycling"` | `"running"` | `"strength"`
- `days`: exakte Anzahl Einheiten pro Woche (Integer ≥ 1)
- Eintrag mit `days: 0` wird entfernt (nicht gespeichert)

**coach_persona JSONB Format:**
```json
{ "style": "analytisch", "focus": "Ich neige zu Übertraining..." }
```
- `style`: `"motivierend"` | `"analytisch"` | `"direkt"` | `"empathisch"` (oder leer)
- `focus`: Freitext-Anweisung an den Coach

**body_goals mögliche Werte:** `"Event"` | `"Muskelaufbau"` | `"Gewicht reduzieren"` | `"Nackt gut ausschauen"`

---

### activities
```sql
id              UUID PRIMARY KEY
athlete_id      UUID → athletes.id
strava_id       BIGINT UNIQUE
name            TEXT
type            TEXT               -- 'Ride','VirtualRide','Run','VirtualRun','WeightTraining',…
date            TIMESTAMPTZ
distance_m      NUMERIC
duration_s      INTEGER
avg_hr          NUMERIC
max_hr          NUMERIC
np_watts        NUMERIC            -- Normalized Power (nur Rad)
tss             NUMERIC            -- Training Stress Score (selten befüllt)
streams_json    JSONB              -- Cache: time,heartrate,altitude,velocity_smooth,watts,cadence
description     TEXT               -- Cache: Strava-Description (für WeightTraining / Hevy)
claude_analysis TEXT               -- gespeichert nach erstem Analyse-Run
created_at      TIMESTAMPTZ
```

**Cache-first Logik:**
- `streams_json`: beim ersten Öffnen von ActivityDetail von Strava geholt + in Supabase gespeichert; danach immer aus Supabase
- `description`: bei WeightTraining beim ersten Öffnen von Strava Detail-Endpoint geholt + gespeichert; danach immer aus Supabase

---

### season_goals
```sql
id          UUID PRIMARY KEY
athlete_id  UUID → athletes.id
event_name  TEXT
event_date  DATE
distance_km DECIMAL
elevation_m INTEGER
priority    ENUM('A','B','C')
sport_type  TEXT
notes       TEXT
active      BOOLEAN DEFAULT true
created_at  TIMESTAMPTZ
```
- Ziele werden nie gelöscht — `active = false` statt DELETE
- `priority`: A = Hauptziel, B = wichtig, C = Nebenziel

---

### weekly_plans
```sql
id                       UUID PRIMARY KEY
athlete_id               UUID → athletes.id
week_start               DATE              -- immer Montag (YYYY-MM-DD)
version                  INTEGER           -- startet bei 1, inkrementiert bei Neugenerierung
plan_json                JSONB             -- PlanJson: {summary, days: {Mo…So: DayPlan}}
review_notes             TEXT              -- Review-Text der Vorwoche (aus startReview())
change_reason            TEXT
plan_constraint_violation BOOLEAN DEFAULT false
created_at               TIMESTAMPTZ
```

**plan_json Format:**
```json
{
  "summary": "Einzeiliger Wochen-Überblick (max 120 Zeichen)",
  "days": {
    "Mo": { "type": "Laufen", "duration_min": 45, "distance_km": 7, "intensity": "Z2", "description": "Ruhiger Z2-Lauf" },
    "Di": { "type": "Kraft",  "duration_min": 60, "distance_km": null, "intensity": null, "description": "Workout I" },
    "Mi": { "type": "Ruhetag","duration_min": 0,  "distance_km": null, "intensity": null, "description": "Regeneration" }
  }
}
```

**Kraft-description:** NUR `"Workout I"`, `"Workout II"` oder `"Workout III"` — Rotation I→II→III→I

**Invariante:** INSERT-only. Neue Version = neuer Datensatz. Niemals UPDATE auf bestehende Plans.

---

### coach_decisions
```sql
id               UUID PRIMARY KEY
athlete_id       UUID → athletes.id
decision_type    TEXT    -- 'plan_generated' | 'weekly_review'
decision_summary TEXT
reasoning        TEXT
related_plan_id  UUID nullable → weekly_plans.id
created_at       TIMESTAMPTZ
```

---

### chat_messages
```sql
id          UUID PRIMARY KEY
thread_id   UUID               -- aus localStorage (coach_thread_id), pro Gesprächsfaden
athlete_id  UUID → athletes.id
role        TEXT               -- 'user' | 'assistant'
content     TEXT
chat_type   TEXT DEFAULT 'global'
activity_id UUID nullable
created_at  TIMESTAMPTZ
```

---

## 6. Umgebungsvariablen

```bash
# Client-seitig (VITE_ Prefix → im Browser-Bundle)
VITE_SUPABASE_URL=https://thjihbyyelqrrvdinzti.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_STRAVA_CLIENT_ID=260874
VITE_STRAVA_REDIRECT_URI=https://peakform-wheat.vercel.app/auth/callback

# Server-seitig (kein VITE_ Prefix → niemals im Browser-Bundle)
STRAVA_CLIENT_SECRET=...      # nur in /api/strava-token
ANTHROPIC_API_KEY=...         # nur in /api/analyse
```

---

## 7. API-Endpoints (Vercel Serverless Functions)

### POST `/api/analyse`
Claude API Proxy — niemals direkt vom Browser aufrufen.

**Request:**
```json
{ "prompt": "...", "max_tokens": 1024, "system": "..." }
```
**Limits:** Prompt max 80.000 Zeichen, max_tokens Cap 4.096  
**Response:** `{ "text": "..." }`  
**Modell:** `claude-sonnet-4-6`

---

### POST `/api/strava-token`
Strava OAuth Token Exchange & Refresh — STRAVA_CLIENT_SECRET bleibt server-seitig.

**Request (Exchange):** `{ "grant_type": "authorization_code", "code": "..." }`  
**Request (Refresh):** `{ "grant_type": "refresh_token", "refresh_token": "..." }`  
**Response:** Strava Token Response (access_token, refresh_token, expires_at, athlete)

---

## 8. Routen & Seiten

| Route | Komponente | Beschreibung |
|---|---|---|
| `/` | Home.tsx | Strava-Connect-Button; Auto-Redirect zu `/dashboard` wenn eingeloggt |
| `/auth/callback` | AuthCallback.tsx | OAuth-Code verarbeiten, athletes upsert, localStorage setzen |
| `/dashboard` | Dashboard.tsx | 4 Nav-Kacheln + letzte 10 Aktivitäten + Filter |
| `/activity/:id` | ActivityDetail.tsx | Detail-Ansicht mit Charts, Hevy-Übungen, Claude-Analyse |
| `/profile` | Profile.tsx | Athleten-Profil mit Auto-Save |
| `/goals` | Goals.tsx | Saison-Ziele verwalten |
| `/plan` | WeeklyPlan.tsx | Wochenplan generieren + Review |
| `/chat` | Chat.tsx | Globaler Coach-Chat |

---

## 9. Seiten im Detail

### Home.tsx
- Zeigt Strava-Connect-Button
- `useEffect`: wenn `athlete_strava_id` in localStorage → sofortiger Redirect zu `/dashboard`

### AuthCallback.tsx
- Liest `?code=` aus URL
- Ruft `/api/strava-token` auf (server-side Token Exchange)
- Upsert in `athletes` via `strava_athlete_id` als Konflikt-Key
- Setzt `athlete_strava_id` in localStorage
- Redirect zu `/dashboard`

### Dashboard.tsx
- Lädt `athletes` by `strava_athlete_id` aus Supabase
- Holt letzte 10 Aktivitäten von Strava API (`per_page=10`)
- Upsert in `activities` (ohne `tss`, ohne `description`)
- 4 quadratische Nav-Kacheln: Coach / Plan / Ziele / Profil
- Filter-Buttons: WeightTraining 🏋️, Ride 🚴, Run 🏃 (VirtualRide/VirtualRun werden mitgefiltert)
- Logout-Icon: `localStorage.clear()` + Redirect

### ActivityDetail.tsx
**Ausdauer (Ride/Run):**
- Stats-Grid: Dauer, Ø HF, Distanz, Höhenmeter, Ø/Max Tempo, Max HF, NP, Ø/Max Watt, Trittfrequenz (kontextabhängig)
- Charts (Recharts AreaChart): Watt, Herzfrequenz, Höhenprofil
- Rundentabelle: Dauer, Distanz, Ø Watt, Ø HF, Ø RPM
- Claude-Analyse-Button → `/api/analyse` → gespeichert in `activities.claude_analysis`

**Krafttraining (WeightTraining):**
- Hevy-Description aus `activities.description` (Cache-first, dann Strava Detail-Endpoint)
- Parser `parseHevyDescription()`: parst Sets mit Gewicht×Wiederholungen oder Körpergewicht-Wiederholungen
- Übungskarten: Name, Muskelgruppe-Pill (aus 50+ Keyword-Lookup), Volumen-Pill, Set-Tags
- Gesamtvolumen-Banner
- Claude-Analyse: Volumen & Intensität / Übungsanalyse / Stärken / Empfehlung

**Markdown-Renderer** (`renderMarkdown`): h1-h3, Bullet-Lists, Blockquotes, `**fett**`, HR, Skip-Tabellen und Code-Blöcke

### Profile.tsx
**Felder:**
- Name (Text)
- Leistungsdaten: FTP (W), Max HF (bpm), Gewicht (kg)
- Trainingstage pro Woche: Button-Grid 1–7
- Sportarten: Pills (Radfahren / Laufen / Krafttraining) mit Akkordeon-Stepper
  - Pill-Klick: Öffnet Stepper für die gewählte Sportart
  - Stepper − bei 1 Tag: Sportart wird aus `sport_types` entfernt (days→0 = remove)
  - Stepper + deaktiviert wenn `totalDays >= trainingDaysNum`
  - Warnung wenn `totalDays > trainingDaysNum`
- Ziele (Mehrfachauswahl): Event / Muskelaufbau / Gewicht reduzieren / Nackt gut ausschauen
- Coach-Stil (Einfachauswahl): Motivierend / Analytisch / Direkt / Empathisch
- Coach-Fokus: Freitext-Textarea

**Auto-Save:** 800ms Debounce nach jeder Änderung. Kein manueller Save-Button. Status-Indikator (Speichert… / ✓ Gespeichert).

### Goals.tsx
- Lädt alle `season_goals` mit `active = true`, sortiert nach `event_date`
- A-Event Countdown (größter Block wenn vorhanden, nur für zukünftige Events)
- Ziel-Liste: sortiert A → B → C
- Add/Edit-Modal: Event-Name, Datum, Priorität A/B/C, Sportart, Distanz, Höhenmeter, Notizen
- Deaktivieren: `active = false` (kein DELETE)
- Sportarten im Modal: Radfahren / Laufen / Triathlon / Schwimmen / Wandern / Krafttraining

### WeeklyPlan.tsx
→ Eigener Abschnitt 10.

### Chat.tsx
- Thread-ID aus `localStorage` (`coach_thread_id`); `crypto.randomUUID()` beim ersten Besuch
- Lädt letzte 50 Messages aus `chat_messages` für aktuellen Thread
- Supabase-first Flow:
  1. User-Message → INSERT in `chat_messages`
  2. Reload aus DB
  3. `buildCoachContext(athleteId, threadId)` aufrufen
  4. Claude-Call via `/api/analyse` (max_tokens: 1024)
  5. Assistant-Response → INSERT in `chat_messages`
  6. Reload aus DB
- "Neues Gespräch": neue UUID in localStorage, leere Messages
- Textarea: auto-resize bis max 128px; Enter = senden, Shift+Enter = neue Zeile
- Typing-Indicator (3 springende Dots) während API-Call

---

## 10. Wochenplan-Architektur (WeeklyPlan.tsx)

### Plan-Generierung (`generatePlan()`)

**Inputs:**
- `buildCoachContext(athleteId)` → vollständiger Coach-Kontext als User-Message
- `COACH_SYSTEM_PROMPT` → als `system`-Parameter
- Woche (Montag-Datum als Referenz)
- `athlete.training_days_per_week` und `athlete.sport_types`

**Prompt-Struktur:**
```
{context}
---
Erstelle den Wochenplan für die Woche vom {monday} bis {sunday}.

HARTE REGELN (nicht verhandelbar):
1. Gesamttage: exakt {trainingDays} Trainingstage und {7 - trainingDays} Ruhetage (Mo–So = 7 Tage).
2. Sportarten-Verteilung:
   - Laufen: exakt 2 Tage
   - Radfahren: exakt 2 Tage
   - Krafttraining: exakt 1 Tag

SPORTWISSENSCHAFTLICHE REIHENFOLGE-REGELN:
3–6. Keine zwei intensiven Tage hintereinander; Kraft nie vor intensiver Ausdauer; etc.

KRAFTTRAINING-ROTATION:
7. Rotation IMMER Workout I → II → III → I
8. description-Feld bei Kraft: NUR "Workout I", "Workout II" oder "Workout III"
9. Kontext für letztes Kraft-Workout prüfen

SELF-CHECK VOR AUSGABE: ...

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt...
```

**Response:** Claude gibt `PlanJson` zurück  
**max_tokens:** 2048

---

### Constraint-Validierung (`validateConstraints()`)

```typescript
// Trainingstage: alle Tage die NICHT rest-keywords enthalten
const trainingCount = dayValues.filter(d =>
  !['ruhetag','erholung','regeneration'].some(k => d.type.toLowerCase().includes(k))
).length

// Pro Sportart: Keyword-Matching
const SPORT_KEYWORDS = {
  cycling:  ['ride', 'radfahren', 'cycling'],
  running:  ['run', 'laufen', 'running'],
  strength: ['kraft', 'weighttraining', 'krafttraining'],
}
```

**Fehlerfall:** Violations-Banner mit "Neu generieren" (nochmal API-Call) oder "Trotzdem speichern" (speichert mit `plan_constraint_violation: true`).

---

### Wochenreview (`startReview()` + `saveReviewData()`)

**Inputs:**
- `buildCoachContext(athleteId)` → vollständiger Coach-Kontext
- `weekActivities`: alle Aktivitäten der Woche aus `activities`
- `reviewFeedback`: Freitext-Input des Athleten
- Aktueller Wochenplan-Summary (optional)

**Review-Prompt enthält:**
- Absolvierte Aktivitäten der Woche (Name, Typ, Dauer, Distanz, Ø HF, NP)
- Freitext-Feedback
- Gleiche HARTE REGELN wie bei `generatePlan()` für den Folgeplan
- SELF-CHECK für `next_week_plan`

**Claude-Output (JSON):**
```json
{
  "review": "Wochenbewertung 3-4 Sätze",
  "coach_decision_reason": "Begründung Anpassungen 1-2 Sätze",
  "next_week_plan": { "summary": "...", "days": { "Mo": {...}, ... } }
}
```

**max_tokens:** 3000

**Violation-Handling:**
- `validateConstraints()` auf `next_week_plan`
- Bei Violations: Amber-Banner mit "Neu generieren" / "Trotzdem speichern" (Supabase-Save wird gehalten)
- Bei keinen Violations: `saveReviewData(parsed, false)` direkt

**`saveReviewData()`:**
- INSERT in `weekly_plans` (nächste Woche, version++): `review_notes = data.review`
- INSERT in `coach_decisions`: `decision_type = 'weekly_review'`
- Setzt `reviewResult` für Anzeige-State

**`review_notes` Semantik:** Die Bewertung der Woche W wird in `weekly_plans.review_notes` der Woche W+1 gespeichert. `buildCoachContext()` liest diesen Wert beim Generieren eines neuen Plans.

---

### Week-Navigation
- Buttons ‹/› für ±1 Woche
- Wochenreview-Section nur sichtbar für aktuelle + vergangene Wochen

---

### Plan-Speicherung (`savePlanJson()`)
- `select('version')` → nextVersion = max(version) + 1
- INSERT in `weekly_plans`
- INSERT in `coach_decisions` mit `decision_type = 'plan_generated'`
- Niemals UPDATE

---

## 11. Coach-Kontext-Architektur (`buildCoachContext`)

Funktion in `src/lib/coachContext.ts`. Wird bei JEDEM Claude-Call als User-Message-Inhalt aufgebaut.

**Alle 7 Queries laufen parallel (Promise.all).**

```
[ATHLETEN-PROFIL]                      ~200 tokens
  Name, FTP, Max HF, Gewicht, Trainingstage, Sportarten, Ziele, Coach-Persona

[HARTE TRAININGS-CONSTRAINTS]          ~100 tokens
  Gesamte Trainingstage (von 7 Wochentagen), Ruhetage, Pflicht-Verteilung pro Sportart
  → "Diese Constraints sind nicht verhandelbar."

[SAISON-ZIELE]                         ~300 tokens
  Alle aktiven season_goals sortiert nach event_date
  Countdown zum nächsten A-Event in Tagen

[AKTUELLER WOCHENPLAN]                 ~400 tokens
  Neueste Version der laufenden Woche (week_start = Montag heute)
  + review_notes der Vorwoche (falls vorhanden)
  + plan_json als JSON

[TRAININGSHISTORIE — LETZTE 4 WOCHEN]  ~600 tokens
  Aggregiert aus activities: Anzahl, km, Stunden, TSS, Ø HF, NP max — pro Woche

[PLAN-HISTORY — LETZTE 3 VERSIONEN]   ~300 tokens
  week_start, version, change_reason, plan summary
  + review_notes Snippet (max 250 Zeichen)

[COACH-ENTSCHEIDUNGEN — LETZTE 5]     ~300 tokens
  decision_type, decision_summary, reasoning, created_at

[AKTUELLE CHAT-SESSION]                ~500 tokens  (nur wenn threadId übergeben)
  Letzte 10 Messages des threadId, chronologisch
```

**Ziel: unter ~2.700 tokens, immer gleiche Struktur.**

---

## 12. Coach-System-Prompt (`COACH_SYSTEM_PROMPT`)

Statischer Export in `src/lib/coachPrompt.ts`. Aktuell hardcoded für Markus.

**Inhalt:**
- Athlet: Markus, 40+, Innsbruck, FTP ~229W, Max HF 182, Laufreconvalescent
- Primärziel: 8k-Laufevent 1. Oktober 2026, Zielpace 5:08–5:22 min/km
- 14-Wochen-Periodisierung (Phase 1–4: Readaptation/Grundlage/Wettkampf/Taper)
- HF-Zonen (basierend auf Max HF 182)
- Laufpace-Referenz
- Coaching-Prinzipien (Verletzungsprävention, Schulter berücksichtigen)
- Antwortformat: Deutsch, datengetrieben, kein leeres Motivationsgeschwätz

**Übermittlung:** Jeder Claude-Call via `/api/analyse` erhält `system: COACH_SYSTEM_PROMPT`.

**Wichtig:** Der System-Prompt ist nicht dynamisch — er spiegelt nicht die `athletes`-Tabellen-Felder wider. Saisonziel, Periodisierung, HF-Zonen sind hardcoded, nicht aus DB generiert.

---

## 13. Architektur-Invarianten (tatsächlich eingehalten)

1. **Supabase ist Source of Truth** — kein Plan, keine Entscheidung, keine Chat-Message lebt nur im React-State
2. **Claude-Antworten werden sofort in Supabase gespeichert** bevor sie im UI erscheinen (Chat, ActivityDetail, WeeklyPlan)
3. **weekly_plans: INSERT-only** — niemals UPDATE; neue Version = neuer Row
4. **buildCoachContext() ohne rohe Stream-Daten** — nur aggregierte Wochenwerte aus activities
5. **Kein direkter Claude-Call vom Browser** — ausschließlich über `/api/analyse`
6. **Kein Strava Client Secret im Browser** — ausschließlich über `/api/strava-token`
7. **Auto-Save mit 800ms Debounce** in Profile.tsx (kein manueller Save-Button)
8. **Cache-first für Streams und Descriptions** — Supabase zuerst, Strava-API nur bei null

---

## 14. Lokale Entwicklung

```bash
npm run dev     # Vite Dev-Server auf localhost:5173
                # /api/analyse und /api/strava-token als Vite-Middleware (kein Vercel CLI nötig)
```

**Env-Variablen lokal:** Alle in `.env` (gitignored), Vite liest sie via `loadEnv()` auch für die Middleware.

---

## 15. PWA-Konfiguration

- `theme_color`: `#1D9E75` (brand-500)
- `background_color`: `#0f172a` (slate-900)
- `display`: `standalone`
- `registerType`: `autoUpdate`
- SW Cache-Header in `vercel.json`: `Cache-Control: no-cache`

---

## 16. Implementierungsstand

### Umgesetzt ✅

**Foundation:**
- React + Vite + Tailwind + TypeScript
- PWA (vite-plugin-pwa, theme_color #1D9E75)
- Vercel Hosting + Auto-Deploy auf main
- Supabase Schema (6 Tabellen)
- Strava OAuth 2.0 (Code-Exchange + Auto-Refresh)

**Dashboard & Aktivitäten:**
- Letzte 10 Aktivitäten von Strava, gecacht in Supabase
- 4 Nav-Kacheln (Coach / Plan / Ziele / Profil)
- Aktivitäten-Filter nach Typ (Rad/Lauf/Kraft)
- Logout

**ActivityDetail:**
- Stats-Grid (kontextabhängig je Aktivitätstyp)
- Recharts: Watt-Chart, HF-Chart, Höhenprofil
- Strava Rundentabelle (Dauer, Distanz, Ø Watt, Ø HF, Ø RPM)
- Hevy-Workout-Parser (aus Strava description)
- Übungskarten mit Muskelgruppe-Pill und Volumen-Pill
- Cache-first für streams_json und description
- Claude-Analyse (gespeichert in activities.claude_analysis)
- Markdown-Renderer (h1-h3, Bullets, Blockquotes, bold)

**Profil:**
- Name, FTP, Max HF, Gewicht
- Trainingstage-Auswahl (1–7)
- Sportarten-Akkordeon mit Stepper (− bei 1 = entfernt Sportart)
- Körperziele (Mehrfachauswahl)
- Coach-Stil + Coach-Fokus-Freitext
- 800ms Auto-Save

**Saison-Ziele:**
- A/B/C-Priorität
- Countdown in Tagen (für A-Event prominent)
- Add/Edit-Modal
- Deaktivieren (active = false, kein DELETE)

**Wochenplan:**
- Plan-Generierung mit harten Constraints + sportwissenschaftlichen Regeln
- Krafttraining-Rotation Workout I/II/III
- Frontend-Constraint-Validierung + Violation-Banner ("Neu generieren" / "Trotzdem speichern")
- INSERT-only mit version++
- Wochen-Navigation (±1 Woche)
- Wochenreview mit Aktivitäts-Summary + Freitext-Feedback
- Folgeplan-Generierung aus Review (mit gleichen Constraint-Checks)
- Review-Violations werden dem User angezeigt (nicht still gespeichert)
- review_notes in coach context für Plan-Generierung der nächsten Woche
- coach_decisions Logging

**Coach-Chat:**
- Supabase-persistente Messages (chat_messages)
- Thread-ID aus localStorage
- buildCoachContext() + COACH_SYSTEM_PROMPT bei jedem Message
- Typing-Indicator
- Neue-Gespräch-Button
- Auto-resize Textarea

**Sicherheit:**
- STRAVA_CLIENT_SECRET nie im Browser-Bundle
- ANTHROPIC_API_KEY nie im Browser-Bundle
- Prompt-Size-Limit (80k Zeichen)
- max_tokens Cap (4.096)
- Null-Guards für fehlende Athlete/Activity-Daten

---

### Nicht implementiert ❌

- **Supabase Auth / Multi-User-Login** — kein Registrierungsformular, kein E-Mail/Passwort-Login; nur Strava OAuth
- **Dynamischer System-Prompt** — `COACH_SYSTEM_PROMPT` ist hardcoded (nicht aus athletes-Tabelle generiert)
- **Hevy API-Integration** — Hevy-Daten kommen ausschließlich via Strava description; kein `hevy_api_key`, keine eigene `strength_workouts`-Tabelle
- **Body Check-in** — kein Foto-Upload, keine Claude Vision, keine body_checkins-Tabelle, keine PWA-Erinnerung
- **Aktivitäts-Matching** — DayCards zeigen kein Grün/Orange/Grau-Status ob eine Aktivität zum Plan-Tag passt
- **Pagination** — nur immer die letzten 10 Aktivitäten (kein "Mehr laden")
- **CTL/ATL/TSB Fitness-Kurve**
- **Push Notifications**
- **Bottom-Navigation Mobile**
- **Aktivitäts-spezifischer Chat-Thread**
- **Coach-Persönlichkeiten pro Sportart**
- **OAuth State-Parameter** (CSRF-Schutz bei OAuth-Flow)

---

## 17. Supabase-Projektdetails

- **Name:** peakform
- **Project ID:** `thjihbyyelqrrvdinzti`
- **URL:** `https://thjihbyyelqrrvdinzti.supabase.co`
- **Region:** eu-central-1
- **RLS:** Aktiv auf allen Tabellen, aktuell offene Policy (kein auth.uid()-Binding)
