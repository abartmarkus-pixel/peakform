# PeakForm — Produktspezifikation

> **Für Claude Code:** Halte diese Datei nach jeder Session aktuell.
> SPEC.md beschreibt immer den tatsächlich implementierten Stand — nicht was geplant war.
> Committe SPEC.md zusammen mit dem Feature-Code.

> Letzte Aktualisierung: 2. Juli 2026 (Feature: Automatische Aktivitäts-Analyse nach Strava-Sync — kein manueller Klick auf „Analysieren" mehr nötig, Button heißt jetzt „Neu analysieren", Analyse-Logik in `src/lib/activityAnalysis.ts` extrahiert, siehe Kapitel 9 „Auto-Analyse" und Kapitel 10 „Fallback: `closeOutstandingAnalyses()`"; davor Bugfix: Datumsfehler in Coach-Analysen — falsches Aktivitätsdatum bei Mid-Week-Feedback, fehlende Kalenderdaten im Wochenplan-Kontext, UTC-Slice statt Lokalzeit-Formatierung, siehe Kapitel 11 „Bugfix 2. Juli 2026")

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
| Icons | react-icons (Font Awesome 6 Free) | 5.6 |
| Charts | Recharts | 2.12 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities | 6.3 / 10.0 / 3.2 |
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
│   │                         Params: { prompt, max_tokens?, system?, images? }
│   │                         Limits: 80.000 Zeichen, max_tokens Cap 4.096, max. 10 Bilder, max. 2M Base64-Zeichen/Bild
│   └── strava-token.ts     # Vercel Serverless Function — Strava OAuth Token Exchange/Refresh
│                             STRAVA_CLIENT_SECRET ausschließlich server-seitig
├── public/
│   ├── peakform-logo.png        # Schriftzug Header (1x, max 320×80)
│   ├── peakform-logo@2x.png     # Schriftzug Header (2x Retina)
│   ├── favicon-16.png           # Favicon 16×16
│   ├── favicon-32.png           # Favicon 32×32
│   ├── apple-touch-icon.png     # iOS Home-Screen Icon 180×180
│   ├── icon-192.png             # PWA Icon 192×192
│   ├── icon-512.png             # PWA Icon 512×512 (auch maskable)
│   ├── splash.png               # PWA Splash 1024×1024
│   └── splash-bg.jpg            # Home.tsx Hintergrundbild, max 1200px, JPEG 80%
├── src/
│   ├── App.tsx             # Router (10 Routen) + Layout-Wrapper mit BottomNav
│   │                       # Splash-Screen: NUR wenn eingeloggt (athlete_strava_id in localStorage/sessionStorage)
│   │                       # Dauer: 2000ms + 400ms Fade-out; bg-slate-900; splash.png zentriert 80% Breite, CSS peakform-pulse; kein Logo
│   │                       # Session-Guard: nach Session-Herstellung wird athletes.onboarding_completed geprüft
│   │                       # → false: Redirect zu /onboarding (unabhängig von der ursprünglich angeforderten Route)
│   ├── components/
│   │   ├── AppHeader.tsx   # Fixierter Header (h-14); Props: rightAction?: React.ReactNode
│   │                       # Logo links (Link zu /dashboard, cursor-pointer), rightAction rechts (justify-between); jede Page rendert ihn selbst
│   │   └── BottomNav.tsx   # Fix-positionierte 5-Tab Navigation (Home|Plan|Coach|Ziele|Profil)
│   │                         Sichtbar auf allen Seiten außer /, /auth/callback und /onboarding
│   ├── pages/
│   │   ├── Home.tsx           # bg-slate-900 + Logo zentriert + Strava-Button; Auto-Redirect zu /dashboard (kein splash-bg.jpg)
│   │   ├── AuthCallback.tsx   # OAuth-Code → /api/strava-token → Supabase upsert → localStorage
│   │   ├── Onboarding.tsx     # Verpflichtender 6-Schritte-Wizard, einmalig nach erstem Login (siehe Kapitel 9)
│   │   ├── Dashboard.tsx      # letzte 10 Aktivitäten + Typ-Filter; AppHeader mit Logout-Icon rechts
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Hevy-Übungen + Claude-Analyse
│   │   ├── Profile.tsx        # Athleten-Profil mit 800ms Auto-Save
│   │   ├── Goals.tsx          # Saison-Ziele A/B/C + Countdown + Add/Edit-Modal; AppHeader mit "+" rechts
│   │   ├── WeeklyPlan.tsx     # Wochenplan-Generator + Constraint-Validierung + Review
│   │   │                      # Wochen-Navigation: Prev | Datum (center) | Next (right) — keine Versionsnummer
│   │   └── Chat.tsx           # Globaler Coach-Chat mit Supabase-Persistenz
│   │                          # AppHeader mit "Neu"-Button rechts; Container: mt-[72px], h=calc(100vh-136px)
│   └── lib/
│       ├── supabase.ts        # Supabase Client + TypeScript-Types
│       ├── strava.ts          # OAuth URL, Token Exchange/Refresh via /api/strava-token, Activities, Streams, Laps
│       │                        getValidAccessToken(): setzt set_athlete_context RPC (RLS-Vorbereitung)
│       │                        syncActivitiesToSupabase(): Upsert + fire-and-forget Auto-Analyse unanalysierter Aktivitäten (siehe Kapitel 9 „Auto-Analyse")
│       ├── activityAnalysis.ts # analyzeActivity(activity, athleteId): Promise<{success, error?}> — vollständige Claude-Analyse
│       │                        (Specialist-Routing, Streams/Laps/Description cache-first nachladen, Prompt, Speichern, Recovery-Extraktion)
│       │                        triggerRecoveryExtraction() + Chart/Stats/Hevy-Helper (auch von ActivityDetail.tsx für Anzeige importiert)
│       │                        Einzige Implementierung — genutzt vom „Neu analysieren"-Button, vom Sync-Hintergrundjob und vom Plan/Review-Fallback
│       ├── features.ts        # FeatureFlags Interface, DEFAULT_FEATURES, useFeatures(athlete)
│       ├── icons.ts           # Zentrale Icon-Exports (FA6 via react-icons/fa6) + SPORT_DISPLAY Konstante
│       │                        SPORT_DISPLAY: { cycling, running, strength, rest } → { color, label }
│       ├── dateUtils.ts       # ISO 8601 Datums-Helpers (Woche beginnt Montag, Sonntag ist letzter Tag)
│       │                        getISOMonday(date): Date — Montag der Woche in Lokalzeit
│       │                        getISOSunday(monday): Date — Sonntag 23:59:59.999 in Lokalzeit
│       │                        formatWeekRange(monday): string — z. B. "29.6. – 5.7.2026"
│       │                        toLocalDateStr(date): string — "TT.MM.JJJJ" in Lokalzeit (nicht ISO-String-Slice)
│       │                        toLocalWeekdayDateStr(date): string — z. B. "Di 30.6.2026"
│       ├── coachContext.ts    # buildCoachContext(athleteId, threadId?, activeSport?) — 7 Abschnitte, alle parallel
│       │                        Datums-sichere Formatierung überall via toLocalDateStr()/toLocalWeekdayDateStr()
│       │                        (nie date.slice(0,10) auf rohem UTC-ISO-String), siehe Kapitel 11
│       │                        buildSpecialistContext(athleteId, sport) — sportart-spezifische Historien
│       ├── coachPrompt.ts     # buildCoachSystemPrompt(athleteId, activeSport?): Promise<string> (Hauptcoach, dynamisch aus DB)
│       │                        LAUF_COACH_PROMPT | RAD_COACH_PROMPT | KRAFT_COACH_PROMPT (Spezialcoaches, statisch)
│       └── markdown.tsx       # renderMarkdown(text): React.ReactNode[] — geteilter Markdown-Lite-Renderer
│                                (h1-h3, Bullets, Blockquotes, **fett**, HR; genutzt von ActivityDetail)
├── vite.config.ts          # PWA-Config + /api/analyse + /api/strava-token Middleware für lokales Dev
├── vercel.json             # SPA Rewrites + SW Cache-Header
└── .env                    # Credentials (nicht committen)
```

---

## 4. Authentifizierung & Session

**Kein Supabase Auth.** Die App nutzt Strava OAuth 2.0 als einzigen Login-Mechanismus.

**Login-Flow:**
1. User klickt "Mit Strava verbinden" → `Home.tsx` ruft `generateOAuthState()` auf (erzeugt `crypto.randomUUID()`, speichert sie in `sessionStorage.oauth_state`) und baut die Auth-URL via `getStravaAuthUrl(state)` (scope: `read,activity:read_all`, inkl. `&state=...`)
2. Strava redirectet zu `/auth/callback?code=...&state=...`
3. `AuthCallback.tsx` prüft **vor** dem Token-Exchange: `state` aus der Callback-URL muss mit `sessionStorage.oauth_state` übereinstimmen. Bei Mismatch/Fehlen → Redirect zu `/` mit `navigate('/', { state: { error: '...' } })`, kein Token-Exchange (CSRF-Schutz)
4. Bei gültigem State: `sessionStorage.removeItem('oauth_state')`, dann `/api/strava-token` (POST, server-side)
5. Server tauscht Code gegen Token (`STRAVA_CLIENT_SECRET` bleibt server-seitig)
6. `athletes` Upsert in Supabase via `strava_athlete_id` als Konflikt-Key
7. `localStorage.setItem('athlete_strava_id', stravaId)` + `sessionStorage.setItem(...)` + `document.cookie = 'pf_athlete_id=' + stravaId + '; max-age=31536000; path=/; SameSite=Lax'` — Basis für alle weiteren Seiten

**Home.tsx Fehleranzeige:** Falls über `navigate('/', { state: { error } })` ein Fehler übergeben wurde (z.B. OAuth state mismatch), zeigt Home.tsx eine rote Fehlermeldung über dem Strava-Button (`location.state.error`).

**Session-Wiederherstellung beim App-Start** (`App.tsx → Layout`):
1. Öffentliche Pfade (`/`, `/auth/callback`): keine Prüfung nötig
2. `localStorage` oder `sessionStorage` enthält `athlete_strava_id`: Session gültig, `localStorage` wird bei Bedarf nachgefüllt
3. Beides leer → `restoreSessionFromSupabase()`: identifiziert den Athleten über das `pf_athlete_id`-Cookie, refresht Token falls abgelaufen, schreibt `athlete_strava_id` zurück in `localStorage` + `sessionStorage`
4. Kein Cookie, kein passender Athleten-Eintrag oder kein `refresh_token` → Redirect zu `/` (echter Strava-Login nötig)
5. Session gültig (egal ob aus Storage oder wiederhergestellt) → `athletes.onboarding_completed` wird per Query geladen; bei `false` (und aktuelle Route ≠ `/onboarding`) → `navigate('/onboarding', { replace: true })`, unabhängig von der ursprünglich angeforderten Route

Splash-Screen: erscheint **nur wenn eingeloggt** (`athlete_strava_id` in localStorage oder sessionStorage beim App-Start). Dauer: 2000ms sichtbar + 400ms Fade-out. Design: `bg-slate-900` + `splash.png` zentriert (80% Breite, max-w-sm), sanft pulsierend via CSS `peakform-pulse` (scale 1→1.05, opacity 1→0.85, 1.5s). Kein PeakForm Logo. Kein Overlay, kein Dots-Indicator. Auf PUBLIC_PATHS (/ und /auth/callback) kein Splash. Nicht eingeloggt auf geschützter Route → Session-Check läuft still, kein Splash.

**`restoreSessionFromSupabase()`** (in `src/lib/strava.ts`):
- Liest `pf_athlete_id` aus `document.cookie`; ohne Cookie → `return false`
- `SELECT id, strava_athlete_id, strava_access_token, strava_refresh_token, expires_at FROM athletes WHERE strava_athlete_id = <cookie-wert>`
- Falls Eintrag mit `refresh_token`: `getValidAccessToken()` aufrufen → `localStorage` + `sessionStorage` setzen → `return true`
- Sonst: `return false`
- Ersetzt das frühere `LIMIT 1`-Pattern: bei mehreren Athleten-Einträgen bekommt jeder Browser (mit eigenem Cookie) den korrekten Account statt eines zufälligen

**Logout:** `localStorage.clear()` + `sessionStorage.clear()` + Cookie löschen (`document.cookie = 'pf_athlete_id=; max-age=0; path=/'`) → Redirect zu `/`

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
equipment             JSONB                -- Format: {dumbbells:{active,max_kg?},bands:{active},bodyweight:{active},pullup_bar:{active},gym:{active}}
aesthetic_goals       JSONB                -- Format: {priorities:string[],notes:string}
season_phase_override TEXT DEFAULT NULL   -- 'readaptation'|'base'|'race'|'taper'|NULL (NULL = automatisch aus event_date)
best_5k_seconds       INTEGER DEFAULT NULL -- 5k-Bestzeit in Sekunden; Basis für Pace-Berechnung
ftp_updated_at        TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten FTP-Eingabe
max_hr_updated_at     TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten Max HF-Eingabe
weight_updated_at     TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten Gewicht-Eingabe
best_5k_updated_at    TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten 5k-Bestzeit-Eingabe
-- Persönliche Daten
gender                TEXT CHECK (gender IN ('male', 'female', 'diverse')) DEFAULT NULL
birth_year            INTEGER CHECK (birth_year BETWEEN 1940 AND 2010) DEFAULT NULL
resting_hr            INTEGER CHECK (resting_hr BETWEEN 30 AND 100) DEFAULT NULL
-- Feature-Flags
features              JSONB DEFAULT '{"cycling":true,"running":true,"strength":true,"weekly_plan":true,"coach_chat":true,"goals":true}'
-- Onboarding
onboarding_completed  BOOLEAN DEFAULT false -- true = Wizard durchlaufen; false = Redirect zu /onboarding bei jedem Login
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

**body_goals mögliche Werte:** `"Event"` | `"Muskelaufbau"` | `"Gewicht reduzieren"`

**Migration (1. Juli 2026):** Der frühere Wert `"Nackt gut ausschauen"` wurde entfernt. Beim Profil-Load in `Profile.tsx` wird ein noch in der DB vorhandener Legacy-Wert automatisch migriert: Eintrag wird aus dem Array entfernt; war er der einzige Eintrag, wird `"Muskelaufbau"` als Ersatz hinzugefügt (sonst bleibt das Array wie es ist). Die Migration läuft rein im Code (kein DB-Skript), das Ergebnis wird beim nächsten Auto-Save persistiert.

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
streams_json         JSONB              -- Cache: time,heartrate,altitude,velocity_smooth,watts,cadence
laps_json            JSONB DEFAULT NULL -- Cache: Strava Laps Array (StravaLap[]), beim ersten Öffnen gecacht
splits_metric_json   JSONB DEFAULT NULL -- Cache: Strava splits_metric (StravaSplitMetric[]), nur Runs
description          TEXT               -- Cache: Strava-Description (für WeightTraining / Hevy)
claude_analysis      TEXT               -- gespeichert nach erstem Analyse-Run
created_at      TIMESTAMPTZ
```

**Cache-first Logik:**
- `streams_json`: beim ersten Öffnen von ActivityDetail von Strava geholt + in Supabase gespeichert; danach immer aus Supabase
- `laps_json`: beim ersten Öffnen parallel zu `streams_json` von Strava Laps-Endpoint geholt + gespeichert; danach immer aus Supabase
- `splits_metric_json`: bei Lauf-Aktivitäten beim ersten Öffnen via `GET /activities/{id}` → `splits_metric` Feld geholt + gespeichert; danach immer aus Supabase
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
    "Mo": { "type": "Laufen", "duration_min": 45, "distance_km": null, "intensity": "Z2", "description": "Ruhiger Z2-Lauf" },
    "Di": { "type": "Kraft",  "duration_min": 60, "distance_km": null, "intensity": null, "description": "Workout I" },
    "Mi": { "type": "Ruhetag","duration_min": 0,  "distance_km": null, "intensity": null, "description": "Regeneration" }
  }
}
```

**Lauf-Regel:** Bei type `"Laufen"` / `"Run"` ist `distance_km` immer `null`. Die HF-Zone ist die einzige Vorgabe — Distanz ergibt sich automatisch. DayCard zeigt für Laufeinheiten nur die Dauer, nie Kilometer.

**Kraft-description:** NUR `"Workout I"`, `"Workout II"` oder `"Workout III"` — Rotation I→II→III→I

**Invariante:** INSERT-only. Neue Version = neuer Datensatz. Niemals UPDATE auf bestehende Plans.

---

### coach_decisions
```sql
id                   UUID PRIMARY KEY
athlete_id           UUID → athletes.id
decision_type        TEXT    -- 'plan_generated' | 'weekly_review' | 'recovery_required' | 'midweek_feedback'
decision_summary     TEXT
reasoning            TEXT
related_plan_id      UUID nullable → weekly_plans.id
related_activity_id  UUID nullable → activities.id   -- gesetzt bei 'recovery_required'
created_at           TIMESTAMPTZ
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
STRAVA_CLIENT_SECRET=...         # nur in /api/strava-token
ANTHROPIC_API_KEY=...            # nur in /api/analyse
```

---

## 7. API-Endpoints (Vercel Serverless Functions)

### POST `/api/analyse`
Claude API Proxy — niemals direkt vom Browser aufrufen.

**Request:**
```json
{ "prompt": "...", "max_tokens": 1024, "system": "...", "images": [{ "base64": "...", "mediaType": "image/jpeg", "label": "Aktuell — Frontal" }] }
```
`images` ist optional (generischer Claude Vision Support, aktuell von keinem Feature genutzt — Body Check-in, der ursprüngliche Anwendungsfall, wurde entfernt). Content-Blocks werden dann als `[label?, image, label?, image, ..., prompt]` an die Anthropic Messages API gebaut (Label-Text direkt vor dem zugehörigen Bild). Ohne `images` bleibt `content` ein reiner String wie bisher.

**Limits:** Prompt max 80.000 Zeichen, max_tokens Cap 4.096, max. 10 Bilder, max. 2.000.000 Base64-Zeichen pro Bild  
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
| `/onboarding` | Onboarding.tsx | Verpflichtender 6-Schritte-Wizard; nicht über BottomNav erreichbar, kein AppHeader/Logout, kein Skip |
| `/dashboard` | Dashboard.tsx | Letzte 10 Aktivitäten + Filter + Alert-Banner |
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
- Redirect zu `/dashboard` (Layout-Guard in App.tsx leitet bei `onboarding_completed = false` sofort weiter zu `/onboarding`)

### Onboarding.tsx

Verpflichtender Wizard, läuft **einmalig** nach dem ersten Strava-Login. Kein Skip, kein "Später einrichten", kein "Zurück zum Dashboard" während des Flows. Kein AppHeader (kein Logout), keine BottomNav.

**State:** `currentStep` (1–6), lokale Formular-Daten für alle Schritte (Supabase-Save erst am Ende in Schritt 6). Fortschrittsanzeige: 6 Segmente, aktueller Schritt in `bg-brand-500` hervorgehoben. Navigation: "Weiter" (disabled bis Pflichtfelder erfüllt, via `canProceed()`), "Zurück" (außer Schritt 1, Daten bleiben im State).

| Schritt | Titel | Inhalt | Pflicht für "Weiter" |
|---|---|---|---|
| 1 | Willkommen | Logo, Willkommenstext, Name-Feld | Name ≥ 2 Zeichen |
| 2 | Sportarten | Trainingstage 1–7, Sportarten-Pills (alle drei, frei wählbar) mit Tage-Stepper; Amber-Warnung bei Σdays > Trainingstage (kein Blocker) | Trainingstage gesetzt + ≥1 Sportart |
| 3 | Erstes Ziel | Event-Name, Datum (muss in Zukunft liegen), Sportart-Dropdown (nur aus Schritt 2 gewählte Sportarten), Distanz/Höhenmeter/Notizen optional; Priorität automatisch `A` | Event-Name, Datum, Sportart |
| 4 | Leistungsdaten | Geschlecht, Geburtsjahr, Max HF (+ Tanaka-Button), Ruhe-HF, Gewicht, FTP (nur wenn Radfahren gewählt), 5k-Bestzeit MM:SS (nur wenn Laufen gewählt) — alles optional | keine (immer aktiv) |
| 5 | Coach-Stil | 4 Presets (Motivierend/Analytisch/Direkt/Empathisch, Default "Analytisch"), Freitext-Fokus optional | ein Stil gewählt |
| 6 | Zusammenfassung | Kompakte Übersicht aller Eingaben; Button "Los geht's" | — |

**"Los geht's" (Schritt 6):**
1. `season_goals` INSERT (Ziel aus Schritt 3, `priority: 'A'`, `active: true`)
2. `athletes` UPDATE: `name, gender, birth_year, max_hr, resting_hr, weight_kg, ftp_watts, best_5k_seconds, sport_types, training_days_per_week, coach_persona, onboarding_completed: true`
3. Bei Erfolg: `navigate('/dashboard', { replace: true })`
4. Bei Fehler (INSERT oder UPDATE schlägt fehl): Fehlermeldung unter der Zusammenfassung, User bleibt auf Schritt 6, State bleibt erhalten, erneuter Versuch möglich. `onboarding_completed` wird nur `true` gesetzt wenn beide Schreibvorgänge erfolgreich waren.

**Migration für Bestandsuser:** Beim Hinzufügen des Feldes wurden alle bestehenden `athletes`-Zeilen mit `name IS NOT NULL` per `UPDATE` auf `onboarding_completed = true` gesetzt — damit werden bereits eingerichtete Athleten (Markus) beim nächsten Login nicht in den Wizard geschickt.

**Sportarten-Auswahl ist von Feature-Flags entkoppelt:** Schritt 2 zeigt immer alle drei Sportarten zur Auswahl, unabhängig vom `features`-Feld in `athletes`. Grund: `features` kann erst gesetzt werden, wenn der `athletes`-Eintrag existiert (nach erstem Login), der Wizard startet aber sofort danach — ein Feature-Flag-Gate hier würde ein Henne-Ei-Problem erzeugen. Die Sichtbarkeit sportartspezifischer UI (FTP-Feld, Krafttraining-Sektion im Profil, Dashboard-Filter etc.) wird stattdessen ausschließlich durch die eigene `sport_types`-Wahl gesteuert — wählt der User eine Sportart nicht, bleiben die zugehörigen Bereiche automatisch ausgeblendet. `useFeatures()` bleibt für alle anderen Zwecke (z.B. komplettes Sperren von `coach_chat`, `goals`, `weekly_plan`) unverändert bestehen.

### Dashboard.tsx
- Lädt `athletes` by `strava_athlete_id` aus Supabase
- Holt letzte 10 Aktivitäten von Strava API (`per_page=10`)
- `syncActivitiesToSupabase(acts, athlete.id)` (aus `src/lib/strava.ts`): Upsert in `activities` (ohne `tss`, ohne `description`, ohne `claude_analysis` — `onConflict: 'strava_id'` fasst `claude_analysis` beim Update nie an, bestehende Analysen bleiben also unangetastet)
- Filter-Buttons: WeightTraining / Ride / Run mit FA6-Icons (VirtualRide/VirtualRun werden mitgefiltert)
- Logout-Icon: `localStorage.clear()` + Redirect
- Keine Nav-Kacheln mehr (ersetzt durch BottomNav)

**Auto-Analyse nach Sync (`syncActivitiesToSupabase()`, 2. Juli 2026):**
- Nach dem Upsert startet fire-and-forget (nicht `await`et — Dashboard/WeeklyPlan laden sofort normal weiter) ein Hintergrundjob: `SELECT * FROM activities WHERE athlete_id = ... AND claude_analysis IS NULL ORDER BY date ASC`
- Jede gefundene Aktivität wird **sequenziell** (nicht `Promise.all`) mit `analyzeActivity()` analysiert — sequenziell, damit eine Recovery-Entscheidung aus `coach_decisions` bei der Analyse der nächsten Aktivität bereits im Kontext verfügbar ist
- Fehlgeschlagene Einzel-Analysen werden geloggt (`console.error`), blockieren aber weder die Schleife noch den Aufrufer — die Aktivität bleibt einfach ohne `claude_analysis` (siehe „Fallback" in Kapitel 10 und „Polling" in Kapitel 9)
- Die gesamte fire-and-forget-IIFE ist in `try/catch` gewrappt, damit auch ein Fehler beim initialen `SELECT` nicht als unhandled promise rejection auftaucht
- Genutzte Implementierung: `analyzeActivity()` aus `src/lib/activityAnalysis.ts` — dieselbe Funktion, die auch der „Neu analysieren"-Button in `ActivityDetail.tsx` und der Plan/Review-Fallback in `WeeklyPlan.tsx` aufrufen

**Echtzeit-Alert nach Strava-Sync:**
- Einmal pro Session (via `sessionStorage`, Key: `peakform_alert_{weekStart}`)
- Lädt aktuellen Wochenplan + neueste Aktivität dieser Woche parallel aus Supabase
- Claude-Call (`max_tokens: 150`) zur Konflikt-Erkennung — antwortet ausschließlich JSON: `{"conflict": bool, "message": string|null}`
- Bei Konflikt: Amber-Banner mit Claude-generierter Erklärung
- Banner-Buttons: "Plan anpassen" (→ Claude-Call + Modal) / "Verwerfen"
- "Plan anpassen": Claude-Call mit Plan-JSON + Konflikt-Beschreibung → Text-Modal

### ActivityDetail.tsx

**Identifier-Konvention Aktivitäts-Navigation:** Die Route `/activity/:id` erwartet in `:id` immer die **Strava-BIGINT-ID** (`activities.strava_id`), niemals die Supabase-UUID (`activities.id`). Grund: `ActivityDetail.tsx` lädt die Aktivität via `useParams()` → `.eq('strava_id', Number(id))` (nicht `.eq('id', id)`). Jede Stelle, die zu `/activity/:id` navigiert, muss `strava_id` übergeben:
- `Dashboard.tsx`: `act.id` ist hier bereits die Strava-ID, da `act` vom Typ `StravaActivity` (direkt von der Strava API) ist — kein Widerspruch zur Konvention.
- `WeeklyPlan.tsx` (`DayCard`-`onPress`): `match.activity` ist hier vom Typ `Activity` (Supabase-Row) — es muss explizit `match.activity.strava_id` verwendet werden, **nicht** `match.activity.id`. (War Ursache eines Bugs: Klick auf absolvierte Aktivität im Wochenplan führte zu "Aktivität konnte nicht geladen werden", weil `Number(<uuid>)` zu `NaN` wird.)

**Sportartabhängige Darstellung** (`isRun` = `['Run', 'VirtualRun', 'TrailRun']`):

**Lauf (Run / VirtualRun / TrailRun):**
- Stats-Grid Zeile 1: **Distanz** | **Dauer** | **Ø Pace** (min/km)
- Stats-Grid Zeile 2: **Ø HF** | **Max HF** | **Ø Kadenz** (wenn cadence-Stream vorhanden, sonst 5 Kacheln)
  - Ø Kadenz: `stats.avgCadence * 2` spm (Strava-Stream gibt einseitige Schritte → mal 2 = Schritte/min); Format: `"172 spm"`
  - Pace-Formel: `paceMinKm = 60 / speedKmh`; Anzeige: `"6:58 min/km"`
  - Kein Max Pace (velocity_smooth-Stream unzuverlässig), *kein* Höhenmeter, *kein* NP
- Charts: **Herzfrequenz** (rot) — *kein* Pace-Chart, *kein* Watt-Chart, *kein* Höhenprofil
- **Kilometer-Splits-Tabelle** (unterhalb Charts, oberhalb KI-Analyse)
  - Spalten: KM | ZEIT | PACE | Ø HF
  - Ganze Kilometer: `"km 1"`, `"km 2"` etc.; Letzter unvollständiger Split (`distance < 900m`): tatsächliche Distanz `"0.13 km"`, PACE = `"—"`
  - ZEIT: `moving_time` via `formatDuration`; PACE: `"M:SS min/km"` via `formatPace(moving_time / (distance/1000))`; Ø HF: `"{wert} bpm"` oder `"—"`
  - Datenquelle: **`splits_metric_json`** (Cache-first aus Supabase; beim ersten Öffnen via `GET /activities/{id}` → `splits_metric` Feld → in Supabase gecacht)
  - `moving_time` statt `elapsed_time` → Pausen korrekt ausgeblendet, identisch zur Strava-Anzeige
  - State: `runSplits: RunSplit[]` (wird in useEffect befüllt)
  - Card-Design: `bg-slate-800 rounded-xl`, abwechselnd `bg-slate-700/20`
- Claude-Analyse-Button → `/api/analyse` → gespeichert in `activities.claude_analysis`

**Rad (Ride / VirtualRide / MountainBikeRide / GravelRide):**
- Stats-Grid: Dauer, Ø HF, Distanz, Höhenmeter, Ø/Max Tempo (km/h), Max HF, NP, Ø/Max Watt, Trittfrequenz (kontextabhängig)
- Charts: Watt (amber), Herzfrequenz (rot), Höhenprofil (grün)
- Rundentabelle: #, Dauer, Distanz, Ø Watt, Ø HF, Ø RPM
- Claude-Analyse-Button → `/api/analyse` → gespeichert in `activities.claude_analysis`

**Krafttraining (WeightTraining):**
- Hevy-Description aus `activities.description` (Cache-first, dann Strava Detail-Endpoint)
- Parser `parseHevyDescription()`: parst Sets mit Gewicht×Wiederholungen oder Körpergewicht-Wiederholungen
- Übungskarten: Name, Muskelgruppe-Pill (aus 50+ Keyword-Lookup), Volumen-Pill, Set-Tags
- Gesamtvolumen-Banner
- Claude-Analyse: Volumen & Intensität / Übungsanalyse / Stärken / Empfehlung

**Coach-Routing (`getSpecialistPrompt(activityType)`, in `src/lib/activityAnalysis.ts`):**
- Gibt `{ specialist: string|null, sport: string|null }` zurück
- `specialist` = sportspezifischer Spezialist-Prompt (wird auf `buildCoachSystemPrompt()` aufgesattelt)
- `sport` = `'running'` | `'cycling'` | `'strength'` | `null`
- `analyzeActivity()` lädt `buildCoachSystemPrompt(aId, sport)` + `buildCoachContext()` + `buildSpecialistContext()` parallel

**Recovery-Extraktion (`triggerRecoveryExtraction(analysisText, athleteId, activityId)`, in `src/lib/activityAnalysis.ts`):**
- Fire-and-forget Helper — läuft nach jeder erfolgreichen `analyzeActivity()` ODER beim Laden einer bestehenden Analyse
- Mini-Claude-Call (`max_tokens: 150`): extrahiert `{has_restriction, restriction_until, description}` als JSON
- Bei `has_restriction: true` → INSERT in `coach_decisions` (`decision_type = 'recovery_required'`, `related_activity_id = activityId`)
- **On-load Recovery-Check:** Wenn `claude_analysis` existiert aber kein `coach_decisions`-Eintrag mit `related_activity_id = act.id` und `type = 'recovery_required'` → Extraction wird automatisch nachgeholt

**Auto-Analyse (2. Juli 2026):**
- Neue Aktivitäten werden nicht mehr manuell per Klick analysiert, sondern automatisch im Hintergrund direkt nach dem Strava-Sync (siehe `syncActivitiesToSupabase()` in Dashboard.tsx oben) — der Analyse-Button heißt jetzt durchgängig **„Neu analysieren"** und bleibt jederzeit verfügbar (überschreibt bestehende `claude_analysis` bei Klick), unabhängig davon ob bereits eine Analyse existiert
- `runAnalysis()` in `ActivityDetail.tsx` ruft dafür nur noch `analyzeActivity(activity, athleteId)` aus `src/lib/activityAnalysis.ts` auf und lädt danach `claude_analysis` neu für die Anzeige — die eigentliche Analyse-Logik lebt vollständig in der Lib (reines Refactoring, kein Verhaltensunterschied für die UI)
- **Polling bei laufender Hintergrund-Analyse:** Ist `claude_analysis` beim Laden der Seite noch `null`, wird `awaitingBackgroundAnalysis` gesetzt; ein `useEffect` pollt danach alle 3s (max. 10 Versuche = 30s) erneut `claude_analysis`. Solange gepollt wird, zeigt die Seite statt eines leeren Zustands den Hinweis „Analyse läuft im Hintergrund…" (Spinner). Nach 10 erfolglosen Versuchen fällt die UI automatisch in den normalen „Neu analysieren"-Zustand zurück. Ein manueller Klick auf „Neu analysieren" bricht laufendes Polling sofort ab.

**Markdown-Renderer** (`renderMarkdown`): h1-h3, Bullet-Lists, Blockquotes, `**fett**`, HR, Skip-Tabellen und Code-Blöcke

### Profile.tsx

**Struktur:** Alle Sektionen als einklappbares `AccordionSection`-Akkordeon. Reihenfolge:

| # | Sektion | defaultOpen | Bedingung |
|---|---|---|---|
| 1 | ALLGEMEIN | true | immer |
| 2 | TRAINING | true | immer |
| 3 | LEISTUNGSDATEN | false | immer |
| 4 | ZIEL & COACH | false | immer |
| 5 | TRAININGSPHASE | false | immer |
| 6 | KRAFTTRAINING | false | nur wenn `strength` in sport_types |

**`AccordionSection`-Komponente** (in Profile.tsx, kontrolliert):
- Props: `title`, `subtitle`, `open`, `onToggle`, `children`
- Header: Titel (uppercase, xs) links + Subtitle (truncated, rechts vom Titel) + Chevron rechts
- Subtitle nur sichtbar wenn eingeklappt
- `maxHeight`-Transition 300ms beim Aufklappen
- `min-h-[3rem]` für Touch-Target ≥ 48px
- `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` wenn Sektion neu geöffnet wird (via `prevOpenRef`)
- Accordion-Zustand in Profile verwaltet (6 useState: `generalOpen`, `trainingOpen`, `performanceOpen`, `goalCoachOpen`, `phaseOpen`, `strengthOpen`)

**Subtitles (werden als Preview angezeigt wenn eingeklappt):**
- ALLGEMEIN: `name || "—"`
- TRAINING: `"5 Tage/Woche · Radfahren, Laufen, Krafttraining"`
- LEISTUNGSDATEN: `"FTP 229W · Max HF 182 · 76kg · 5k 25:51"` (nur nicht-null Felder)
- ZIEL & COACH: `"Event, Muskelaufbau · Coach: Analytisch"`
- TRAININGSPHASE: `"Phase 2 — Grundlage (automatisch)"` oder `"… (manuell gesetzt) ⚠"`
- KRAFTTRAINING: Equipment-Liste `"Kurzhanteln 32kg, Bänder"` + `"Schultern, Brust, Arme (Priorität)"`

**Sektionsinhalte:**

*ALLGEMEIN:*
- Name (Textfeld)
- Geschlecht: Segmented Control (Männlich / Weiblich / Divers) → speichert `'male'|'female'|'diverse'`
- Geburtsjahr: Number Input (1940–2010), Hint: "Wird für Altersberechnung und Max HF Schätzung verwendet"

*TRAINING:*
- Trainingstage pro Woche: Button-Grid 1–7
- Sportarten: Pills (Radfahren / Laufen / Krafttraining) mit Akkordeon-Stepper
  - Pill zeigt aktiv (brand-Farben) wenn Sportart in `sport_types`
  - Pill-Klick: Öffnet/schließt den Stepper; fügt Sportart mit 1 Tag hinzu wenn noch nicht vorhanden — aber nur wenn `totalDays < trainingDaysNum`
  - Stepper − bei 1 Tag: Sportart wird entfernt, `focusedSport` → null
  - Stepper + deaktiviert wenn `totalDays >= trainingDaysNum`; Tooltip: "Maximale Trainingstage erreicht"
  - Trainingstage reduzieren → Amber-Warnung wenn `totalDays > trainingDaysNum`; kein Auto-Save

*LEISTUNGSDATEN:*
- Max HF (bpm): immer sichtbar; "Tanaka berechnen"-Button neben dem Feld (nur sichtbar wenn Geburtsjahr eingetragen); Button triggert direkten Save ohne Debounce; Hint: "Gemessener Wert empfohlen. Ohne Wert: Tanaka-Formel (208 − 0.7 × Alter) als Schätzung."
- Ruheherzfrequenz (bpm): immer sichtbar, Hint: "Morgens vor dem Aufstehen messen"
- Gewicht (kg): immer sichtbar
- FTP (W): nur wenn cycling aktiv
- 5k Bestzeit (MM:SS): nur wenn running aktiv — konvertiert zu/von `best_5k_seconds`
  - Validierung live: Format MM:SS, Minuten 10–59, Sekunden 0–59
- **"Zuletzt aktualisiert"** unter jedem Feld (NULL → kein Text; veraltet → amber ⚠)
  - Schwellwerte: FTP > 60 Tage, Max HF > 365 Tage, Gewicht > 30 Tage, 5k > 90 Tage
- **`_updated_at` Auto-Update:** `field_updated_at = NOW()` wenn Wert geändert und nicht null (`origFtp/origMaxHr/origWeight/origBest5k` Refs)

*ZIEL & COACH:*
- Ziele (Mehrfachauswahl): Event / Muskelaufbau / Gewicht reduzieren
- Coach-Stil (Einfachauswahl): Motivierend / Analytisch / Direkt / Empathisch
- Coach-Fokus: Freitext-Textarea

*TRAININGSPHASE:*
- Auto-berechnete Phase anzeigen
- Segmented Control: Auto | Readaptation | Grundlage | Wettkampf | Taper
- Amber-Hinweis wenn Override aktiv

**Feature-Gates (via `useFeatures(athlete)` aus `src/lib/features.ts`):**
- Sportart-Pill Radfahren: nur wenn `features.cycling`
- Sportart-Pill Krafttraining: nur wenn `features.strength`
- Laufen ist immer sichtbar (Basis-Feature)
- KRAFTTRAINING-Sektion: nur wenn `hasStrength && features.strength`
- Dashboard Filter-Button WeightTraining: nur wenn `features.strength`
- Dashboard Filter-Button Radfahren: nur wenn `features.cycling`

*KRAFTTRAINING (nur wenn `hasStrength && features.strength`):*
- **Teil A — Equipment:** Checkboxen (Kurzhanteln / Bänder / Körpergewicht / Klimmzugstange + Gym als Mutex)
  - Bei Kurzhanteln aktiv: Number-Input `bis X kg`
  - Gym aktiv → alle anderen disabled + ausgegraut
- **Teil B — Körperziele** (nur wenn `showAesthetic` = `"Muskelaufbau"` oder `"Gewicht reduzieren"` in bodyGoals):
  - Drag & Drop Muskelgruppen-Ranking (7 Gruppen, via @dnd-kit)
  - Freitext-Feld für Besonderheiten
- **Auto-Open:** Wenn Krafttraining neu aktiviert wird → `setStrengthOpen(true)` direkt in `toggleSport` (nicht via useEffect, damit kein ungewolltes Aufklappen beim initialen DB-Load)

**Auto-Save:** 800ms Debounce. Kein manueller Save-Button. Status-Indikator (`fixed top-4 right-4 z-50`, Speichert… / ✓ Gespeichert).
- `hasSportViolation`, `totalDays`, `trainingDaysNum` werden **vor** dem Auto-Save-`useEffect` deklariert
- `hasSportViolation` in der Dep-Liste — Debounce-Timer startet neu wenn Verletzung aufgelöst wird

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

### Wochenstart-Logik (ISO 8601)

Alle Wochengrenzen werden über `src/lib/dateUtils.ts` berechnet:
- **Woche beginnt Montag** (ISO 8601) — `getISOMonday(date)` liefert den Montag in Lokalzeit
- **Woche endet Sonntag** 23:59:59.999 — `getISOSunday(monday)` für Abfrage-Obergrenze
- **`week_start`-Schlüssel** (YYYY-MM-DD) wird via `getFullYear()/getMonth()/getDate()` aus Lokalzeit gebildet — nicht `toISOString()`, das UTC-Datum zurückgibt (Bug in CET/CEST)
- **Activity-Query** nutzt volle ISO-Timestamps: `gte('date', monday.toISOString())` und `lte('date', getISOSunday(monday).toISOString())` — damit fallen Sonntags-Aktivitäten korrekt in die Vorwoche
- **Plan-Lade-Query** nutzt `.in('week_start', [weekStr, weekStrFallback])` mit Fallback auf Vortag — defensiv für allfällige alte UTC-Einträge (kann nach 4 Wochen entfernt werden)

**Supabase-Migration (30.6.2026):** Alle `week_start`-Werte mit DOW=0 (Sonntag, falsch durch UTC-Bug) wurden um +1 Tag korrigiert:
`2026-06-21→06-22`, `2026-06-28→06-29`, `2026-07-05→07-06`

### Fallback: `closeOutstandingAnalyses()` (2. Juli 2026)

Sicherheitsnetz für den Fall, dass die fire-and-forget Hintergrund-Analyse aus `syncActivitiesToSupabase()` (siehe Kapitel 9 „Auto-Analyse") noch nicht fertig war oder für eine Aktivität fehlgeschlagen ist. Wird von **`generatePlan()` und `startReview()` jeweils als erstes im `try`-Block** aufgerufen — noch vor `buildCoachContext()` —, damit `[LETZTE AKTIVITÄTS-ANALYSE]` garantiert aktuell ist.

**Ablauf:**
1. `SELECT * FROM activities WHERE athlete_id = ... AND claude_analysis IS NULL AND date >= (heute − 7 Tage)`
2. Bei Treffern: `loadingMessage` wird gesetzt (`"Schließe {n} ausstehende Analyse(n) ab…"`) und im Generate-/Review-Button anstelle des generischen „Generiere Plan…"/„Review läuft…" angezeigt
3. Jede gefundene Aktivität wird sequenziell mit `analyzeActivity()` nachanalysiert
4. Fehlgeschlagene Einzel-Analysen werden geloggt, blockieren aber weder die Schleife noch den nachfolgenden Plan-/Review-Call
5. Die gesamte Funktion ist in `try/catch/finally` gewrappt — ein Fehler bereits beim `SELECT` darf die eigentliche Plan-/Review-Generierung (das primäre Feature) nicht verhindern; `finally` setzt `loadingMessage` in jedem Fall zurück

---

### Plan-Generierung (`generatePlan()`)

**Inputs:**
- `closeOutstandingAnalyses()` (Fallback, siehe oben) → zuerst, awaited
- `buildCoachContext(athleteId)` + `coach_decisions[type=recovery_required, letzte 7 Tage]` → parallel
- `COACH_SYSTEM_PROMPT` → als `system`-Parameter
- Woche (Montag-Datum als Referenz)
- `athlete.training_days_per_week` und `athlete.sport_types`

**Prompt-Struktur:**
```
{context}                             ← enthält [LETZTE AKTIVITÄTS-ANALYSE] Block
---
Erstelle den Wochenplan für die Woche vom {monday} bis {sunday}.

HARTE REGELN (nicht verhandelbar):
1. Gesamttage: exakt {trainingDays} Trainingstage und {7 - trainingDays} Ruhetage (Mo–So = 7 Tage).
2. Sportarten-Verteilung:
   - Laufen: exakt 2 Tage
   - Radfahren: exakt 2 Tage
   - Krafttraining: exakt 1 Tag

AKTUELLE ERHOLUNGS-EINSCHRÄNKUNGEN (höchste Priorität — überschreiben alle anderen Regeln):
- {date}: {reasoning}                 ← aus coach_decisions, type='recovery_required'

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
- `closeOutstandingAnalyses()` (Fallback, siehe oben) → zuerst, awaited
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

### Mid-Week Check-in (Feedback direkt an absolvierten Aktivitäten)

Erlaubt sofortiges Feedback zu einer Einheit, ohne auf das Wochenreview zu warten — kein zusätzlicher Claude-Call.

- **UI:** Jede `DayCard` mit `match.status === 'completed'` zeigt neben dem ✓-Icon einen Feedback-Button (`IconCommentOutline` — noch kein Feedback vorhanden, oder `IconCommentFilled` in `text-brand-400` — Feedback bereits gespeichert). Klick öffnet ein Bottom-Sheet-Modal (`fixed inset-0 bg-black/70`, Klick auf Backdrop schließt) mit Freitextfeld, "Speichern" (disabled bei leerem Text) und "Abbrechen".
- **Speicherung:** Klick auf "Speichern" → INSERT in `coach_decisions` (`decision_type: 'midweek_feedback'`, `decision_summary`: erste 100 Zeichen, `reasoning`: vollständiger Text, `related_activity_id: activity.id`). Existiert für diese `related_activity_id` bereits ein Eintrag (aus `feedbackMap`, geladen parallel zu den Wochen-Aktivitäten), wird stattdessen ein UPDATE auf `decision_summary`/`reasoning` ausgeführt — kein Duplikat.
- **Erneutes Öffnen:** Modal wird mit dem vorherigen `reasoning`-Text vorausgefüllt.
- **Toast:** Erfolg → "Danke — wird beim nächsten Plan berücksichtigt ✓" (`bg-brand-500`, 2.5s, `fixed top-4` zentriert). Fehler → "Feedback konnte nicht gespeichert werden" (`bg-red-500`), Modal bleibt offen, Text bleibt erhalten.
- **Sichtbarkeit im Coach-Kontext:** Kein Extra-Code nötig — `buildCoachContext()` lädt die letzten 5 `coach_decisions` ohne Filter auf `decision_type` (siehe Kapitel 11), `midweek_feedback`-Einträge erscheinen dort automatisch.
- **State:** `feedbackMap: Record<activityId, {id, reasoning}>` wird in derselben Woche-Lade-Query wie `weekActivities` befüllt (`coach_decisions` gefiltert auf `decision_type = 'midweek_feedback'` und `related_activity_id IN (...)`).

---

## 11. Coach-Kontext-Architektur (`buildCoachContext`)

Funktion in `src/lib/coachContext.ts`. Signatur: `buildCoachContext(athleteId: string, threadId?: string, activeSport?: 'running' | 'cycling' | 'strength' | null)`. Wird bei JEDEM Claude-Call als User-Message-Inhalt aufgebaut.

**Alle 7 Hauptqueries laufen parallel (Promise.all).** Eine zusätzliche, davon abhängige Query löst für `[COACH-ENTSCHEIDUNGEN]` die Daten verknüpfter Aktivitäten auf (kann erst nach der `coach_decisions`-Query laufen, siehe unten).

```
[ATHLETEN-PROFIL]                      ~200 tokens
  Name, FTP, Max HF, Gewicht, Trainingstage, Sportarten, Ziele, Coach-Persona
  FTP nur wenn activeSport === 'cycling' oder activeSport ist undefined/null (kontextuelle
  Blindheit — bei 'running'/'strength' fehlt die FTP-Zeile komplett, nicht nur unerwähnt)

[HARTE TRAININGS-CONSTRAINTS]          ~100 tokens
  Gesamte Trainingstage (von 7 Wochentagen), Ruhetage, Pflicht-Verteilung pro Sportart
  → "Diese Constraints sind nicht verhandelbar."

[SAISON-ZIELE]                         ~300 tokens
  Alle aktiven season_goals sortiert nach event_date
  Countdown zum nächsten A-Event in Tagen

[AKTUELLER WOCHENPLAN]                 ~400 tokens
  Neueste Version der laufenden Woche (week_start = Montag heute)
  + review_notes der Vorwoche (falls vorhanden)
  + plan_json als JSON — die Mo–So-Tageskürzel in `days` werden über `planJsonWithDates()`
    um das konkrete Kalenderdatum ergänzt (z. B. Schlüssel "Do 2.7.2026" statt nur "Do"),
    damit Claude die Wochentag↔Datum-Zuordnung nicht selbst berechnen muss (Fehlerquelle
    für falsche Datums-/Wochentagsnennungen in Empfehlungen, siehe Bugfix 2. Juli 2026)

[LETZTE AKTIVITÄTS-ANALYSE]            ~300 tokens  (nur wenn claude_analysis vorhanden)
  Neueste Aktivität mit claude_analysis aus activities
  Format: "{name} ({date}, {type}):\n{claude_analysis}" — {date} via `toLocalDateStr()`
  (Lokalzeit-sicher; NICHT `date.slice(0, 10)` auf dem rohen UTC-ISO-String, siehe Bugfix
  2. Juli 2026)
  → "Diese Analyse MUSS bei der Wochenplanung berücksichtigt werden."

[TRAININGSHISTORIE — LETZTE 4 WOCHEN]  ~600 tokens
  Aggregiert aus activities: Anzahl, km, Stunden, TSS, Ø HF, NP max — pro Woche

[PLAN-HISTORY — LETZTE 3 VERSIONEN]   ~300 tokens
  week_start, version, change_reason, plan summary
  + review_notes Snippet (max 250 Zeichen)

[COACH-ENTSCHEIDUNGEN — LETZTE 5]     ~300 tokens
  decision_type, decision_summary, reasoning, created_at, related_activity_id
  Bei gesetztem related_activity_id wird das Aktivitätsdatum separat aufgelöst (activities.name
  + activities.date, lokal formatiert via `toLocalWeekdayDateStr()`) und getrennt von
  `created_at` ausgewiesen — Format: "[{decision_type} zu {activity_name}, {Wochentag
  TT.MM.JJJJ} — eingegeben am {TT.MM.JJJJ}]: {decision_summary}". Ohne related_activity_id:
  "[{decision_type}] {TT.MM.JJJJ}: {decision_summary}" (created_at, lokal formatiert).
  Grund: `created_at` ist der Logging-/Eingabe-Zeitpunkt (z. B. beim Mid-Week-Feedback oft
  erst am Folgetag erfasst), nicht das Datum der Aktivität selbst — Claude hat beide vor dem
  Bugfix vom 2. Juli 2026 verwechselt (siehe unten).

[AKTUELLE CHAT-SESSION]                ~500 tokens  (nur wenn threadId übergeben)
  Letzte 10 Messages des threadId, chronologisch
```

### Bugfix 2. Juli 2026 — Datumsfehler in Coach-Analysen

**Symptom:** Ein Lauf vom Di 30.6. wurde in der Analyse eines späteren Laufs als "1.7." referenziert; eine "nächster Lauf"-Empfehlung nannte "Do, 3.7." (3.7.2026 ist tatsächlich ein Freitag).

**Root Causes (zwei unabhängige Fehlerquellen, kein Timezone-Bug bei `activities.date` selbst — `start_date` (UTC) wird korrekt gespeichert und von `toLocaleDateString()`/`toLocalDateStr()` korrekt lokal aufgelöst):**
1. `[COACH-ENTSCHEIDUNGEN]` zeigte bei `midweek_feedback`-Einträgen `created_at` (Zeitpunkt der Feedback-Eingabe im Wochenplan) als vermeintliches Ereignisdatum — wurde vom Coach mit dem tatsächlichen Aktivitätsdatum verwechselt, wenn Feedback erst am Folgetag eingegeben wurde.
2. `[AKTUELLER WOCHENPLAN]` gab Claude nur Wochentags-Kürzel (Mo–So) ohne Kalenderdatum mit — die Zuordnung musste Claude selbst berechnen und hat sich dabei verrechnet.

**Fix:** `[COACH-ENTSCHEIDUNGEN]` löst jetzt zusätzlich das Datum der `related_activity_id` auf und weist es getrennt von `created_at` aus (siehe Format oben). `[AKTUELLER WOCHENPLAN]` bekommt über `planJsonWithDates()` das Kalenderdatum direkt in die Tages-Schlüssel eingebettet. `[LETZTE AKTIVITÄTS-ANALYSE]` nutzt zusätzlich `toLocalDateStr()` statt `date.slice(0, 10)` (war bislang unauffällig, da kein Testfall die lokale Mitternachtsgrenze kreuzte, aber derselbe Bug-Typ wie der bereits behobene Wochengrenzen-Bug). Neue Helper `toLocalDateStr()` / `toLocalWeekdayDateStr()` in `dateUtils.ts`.

**Ziel: unter ~3.000 tokens, immer gleiche Struktur.**

Nur `ActivityDetail.tsx` (`runAnalysis()`) reicht `activeSport` durch; Chat/WeeklyPlan rufen weiterhin ohne dritten Parameter auf (kein einzelner Sport-Fokus, FTP bleibt sichtbar).

### `buildSpecialistContext(athleteId, sport)`

Ergänzende Funktion, die sportart-spezifische Historien-Daten liefert. Wird parallel zu `buildCoachContext()` geladen und als zweiter Block in die User-Message eingefügt.

```
sport = 'running':
  Letzte 10 Run/VirtualRun/TrailRun Aktivitäten (60 Tage)
  Datum | km | Pace (min/km) | Ø HF

sport = 'cycling':
  FTP aus athletes-Tabelle
  Letzte 10 Ride/VirtualRide/MountainBikeRide/GravelRide (60 Tage)
  Datum | km | NP (W + % FTP) | TSS | Ø HF

sport = 'strength':
  Equipment aus athletes.equipment (aktive Geräte)
  Ästhetik-Prioritäten aus athletes.aesthetic_goals (nur wenn "Muskelaufbau" oder "Gewicht reduzieren" in body_goals)
  Letzte 5 WeightTraining/Workout Aktivitäten (60 Tage)
  Datum | Name | Description-Snippet (max 200 Zeichen)
```

---

## 12. Coach-Prompts (`coachPrompt.ts`)

Siehe Kapitel 18 für Details zur Coach-Architektur.

**Implementierter Stand:**

**`buildCoachSystemPrompt(athleteId, activeSport?: 'running' | 'cycling' | 'strength' | null)`** (Hauptcoach — async, dynamisch):
- Lädt bei jedem Aufruf Athleten-Profil + A-Event aus Supabase (inkl. `gender`, `birth_year`, `resting_hr`)
- Dynamische Abschnitte: Name, Geschlecht, Alter, Gewicht, Leistungsgewicht (W/kg), FTP, Max HF (gemessen od. geschätzt: Tanaka-Formel 208−0.7×Alter), Ruhe-HF, HF-Reserve (Karvonen), Sportarten, Equipment, Ästhetik-Ziele, Coach-Stil/Fokus, Saisonziel, Wochen-Countdown, aktuelle Phase, HF-Zonen, Pace-Referenz
- **`activeSport`-Parameter (kontextuelle Blindheit auf Kontext-Ebene):** Leistungsgewicht (W/kg) und FTP werden NUR in den `[ATHLETEN-PROFIL]`-Block aufgenommen wenn `activeSport === 'cycling'` oder `activeSport` ist `undefined`/`null` (kein Sport-Fokus — Chat, Wochenplan, Dashboard). Bei `activeSport === 'running'` oder `'strength'` fehlen FTP/W-kg vollständig im Kontext — nicht nur als Anweisung "nicht erwähnen", sondern schlicht nicht vorhanden.
- Statische Abschnitte: Coaching-Prinzipien (8 Regeln), Datennutzung, Review-Format, Antwortformat (inkl. Du-Form-Pflicht: niemals über den Athleten in der dritten Person)
- Hilfsfunktionen in `coachContext.ts` (exportiert):
  - `calculateSeasonPhase(weeksUntilEvent, override)` — Phase aus Wochen-Countdown oder manuellem Override
  - `calculateHRZones(maxHR, restingHR?)` — Z1–Z5: Karvonen-Methode wenn `restingHR` vorhanden, sonst %-Methode als Fallback
  - `calculatePaceReference(best5kSeconds, targetEventKm)` — Zielpace, Z2-Tempo, Schwellenpace aus 5k-PB
- Wird bei JEDEM Claude-Call als `system`-Parameter übergeben (alle 4 Consumer: ActivityDetail, Chat, WeeklyPlan, Dashboard). Nur `ActivityDetail.tsx` (`runAnalysis()`) reicht `activeSport` durch (aus `getSpecialistPrompt(activityType)`-Routing); Chat/WeeklyPlan/Dashboard rufen weiterhin ohne zweiten Parameter auf, da dort kein einzelner Sport-Fokus besteht.

**`LAUF_COACH_PROMPT`** / **`RAD_COACH_PROMPT`** / **`KRAFT_COACH_PROMPT`** (Spezialcoaches — statisch):
- Sportart-spezifisch, nicht athleten-spezifisch → bleiben statische Exports
- Werden auf `buildCoachSystemPrompt()` aufgesattelt (`basePrompt + '\n\n' + SPECIALIST_PROMPT`)
- Routing über `getSpecialistPrompt(activityType)` in `ActivityDetail.tsx`
- Lauf: Zonen-Audit, Pace-Konsistenz, HF-Drift, Verletzungssignale
- Rad: Power-Zonen (FTP-basiert), NP/VI-Analyse, TSS/IF-Einordnung
- Kraft: Hevy-Volumen-Analyse, Schulter-Check, Laufsynergie, Equipment- + Ästhetik-Kontext

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

**Onboarding:**
- `athletes.onboarding_completed BOOLEAN DEFAULT false` — neues Feld (Migration angewendet, Bestandsuser auf `true` migriert)
- Verpflichtender 6-Schritte-Wizard (`Onboarding.tsx`) — Name, Sportarten+Trainingstage, erstes Saisonziel, optionale Leistungsdaten, Coach-Stil, Zusammenfassung
- App.tsx Layout-Guard: `onboarding_completed = false` → Redirect zu `/onboarding`, unabhängig von der angeforderten Route
- Kein Skip möglich; `/onboarding` nicht über BottomNav erreichbar, kein AppHeader/Logout

**Navigation & Icons:**
- Bottom-Navigation (5 Tabs: Home / Plan / Coach / Ziele / Profil) — fix positioniert, außer auf /, /auth/callback und /onboarding
- AppHeader (Logo links, h-14, frosted-glass) — Logo ist `Link` zu `/dashboard` (cursor-pointer); `rightAction?: React.ReactNode` Slot rechts; jede Page rendert ihn selbst
- FA6 Icon-System (react-icons/fa6): alle Lucide/Emoji-Icons ersetzt
- SPORT_DISPLAY Konstante in icons.ts (cycling/running/strength/rest → Farbe + Label)
- page-content CSS-Klasse (padding-top: 72px + padding-bottom: 80px) auf allen Hauptseiten außer Chat

**Branding / Assets:**
- Favicon-Set in public/: favicon-16.png, favicon-32.png, apple-touch-icon.png (180×180), icon-192.png, icon-512.png
- PWA Manifest Icons: apple-touch-icon.png (180×180), icon-192.png (standard + maskable), icon-512.png
- Logo: public/peakform-logo.png (1x) + peakform-logo@2x.png (Retina) — im AppHeader + Splash + Home.tsx
- Home-Hintergrund: keiner — Home.tsx nutzt bg-slate-900 (splash-bg.jpg entfernt)
- Splash-Screen: App.tsx zeigt splash.png zentriert (80% Breite, max-w-sm) NUR wenn eingeloggt; bg-slate-900; CSS peakform-pulse; kein Logo; 2000ms + 400ms Fade-out
- Seitenüberschriften entfernt: Dashboard, Chat, Goals, Profile, WeeklyPlan — AppHeader ersetzt sie

**AppHeader rightAction-Slots:**
- Dashboard: Logout-Icon (`IconLogout size=18`, `p-2`)
- Goals: "+" Icon (`IconAdd size=18`, `p-2`)
- Chat: "Neu"-Button (Pill-Style, `rounded-full border border-slate-700`, Icon + Text)
- WeeklyPlan / Profile / ActivityDetail: kein rightAction

**Dashboard & Aktivitäten:**
- Letzte 10 Aktivitäten von Strava, gecacht in Supabase
- Nav-Kacheln entfernt (durch BottomNav ersetzt)
- Aktivitäten-Filter nach Typ (Rad/Lauf/Kraft) mit FA6-Icons
- Logout
- `syncActivitiesToSupabase()`: Upsert lässt `claude_analysis` beim Update unangetastet + stößt fire-and-forget Auto-Analyse aller Aktivitäten mit `claude_analysis IS NULL` an (2. Juli 2026, siehe Kapitel 9)

**ActivityDetail:**
- **Sportartabhängige Darstellung** (Lauf vs. Rad vs. Kraft)
- Lauf: Pace statt km/h, kein NP, kein Höhenmeter, kein Watt-Chart, kein Pace-Chart
- Lauf: Kilometer-Splits-Tabelle (KM | ZEIT | PACE | Ø HF); Datenquelle: `splits_metric_json` (Strava `GET /activities/{id}` → `splits_metric`), Cache-first in Supabase
- Rad: Watt-Chart, HF-Chart, Höhenprofil, Rundentabelle unverändert
- Cache-first für streams_json, laps_json und description
- Hevy-Workout-Parser (aus Strava description)
- Übungskarten mit Muskelgruppe-Pill und Volumen-Pill
- Claude-Analyse (gespeichert in activities.claude_analysis) — Analyse-Logik ausgelagert in `src/lib/activityAnalysis.ts` (`analyzeActivity()`), von Button, Sync-Hintergrundjob und Plan/Review-Fallback gemeinsam genutzt (2. Juli 2026)
- Analyse läuft automatisch im Hintergrund nach dem Sync; Button heißt durchgängig „Neu analysieren"; Polling (3s-Intervall, max. 10 Versuche) zeigt „Analyse läuft im Hintergrund…" solange keine Analyse vorliegt (2. Juli 2026)
- Markdown-Renderer (h1-h3, Bullets, Blockquotes, bold)

**Profil:**
- Alle 6 Sektionen als einklappbares Akkordeon (`AccordionSection`-Komponente)
- Reihenfolge: ALLGEMEIN → TRAINING → LEISTUNGSDATEN → ZIEL & COACH → TRAININGSPHASE → KRAFTTRAINING
- ALLGEMEIN + TRAINING standardmäßig aufgeklappt; Rest eingeklappt
- KRAFTTRAINING nur sichtbar wenn `strength` in sport_types; klappt automatisch auf wenn Krafttraining neu aktiviert
- Subtitles zeigen Preview-Inhalt wenn Sektion eingeklappt
- Status-Indikator (Speichert… / ✓ Gespeichert) fixed top-right
- Smooth scrollIntoView beim Aufklappen auf kleinen Screens
- Touch-Targets ≥ 48px (`min-h-[3rem]`)
- 800ms Auto-Save für alle Felder inkl. equipment, aesthetic_goals, season_phase_override

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
- **Aktivitäts-Matching:** DayCards zeigen Status completed (grün) / missed (amber) / pending (neutral)
  - `matchActivityToDay()`: Typ-Matching Laufen→Run/VirtualRun/TrailRun, Radfahren→Ride/..., Kraft→WeightTraining/Workout
  - completed: grüner linker Rand + ✓ Icon + Aktivitätsname + Dauer; Tap → `/activity/{strava_id}` (**nicht** `activity.id`/Supabase-UUID — `ActivityDetail.tsx` lädt via `.eq('strava_id', Number(id))`, siehe Kapitel 9 „Identifier-Konvention Aktivitäts-Navigation")
  - missed: amber linker Rand + ✗ Icon + "Nicht absolviert" (nur vergangene Tage)
  - pending: neutrales Erscheinungsbild; Ruhetage haben keinen Status
  - Mini-Sync: beim Laden des Wochenplans werden zuerst die letzten 10 Strava-Aktivitäten via `syncActivitiesToSupabase()` in Supabase gesynct (silent, non-blocking bei Fehler) — stößt dabei automatisch auch die Hintergrund-Analyse unanalysierter Aktivitäten an (siehe Kapitel 9 „Auto-Analyse")
- **Mid-Week Check-in:** Feedback-Button an completed DayCards, Modal, `coach_decisions` Insert/Update (`decision_type = 'midweek_feedback'`), Toast, kein zusätzlicher Claude-Call — siehe Kapitel 10
- **Fallback `closeOutstandingAnalyses()`** (2. Juli 2026): `generatePlan()` und `startReview()` holen unanalysierte Aktivitäten der letzten 7 Tage synchron nach, bevor der Plan-/Review-Call startet — Sicherheitsnetz falls die Hintergrund-Analyse aus dem Sync noch nicht fertig war; `loadingMessage` zeigt währenddessen „Schließe X ausstehende Analyse(n) ab…" im Button — siehe Kapitel 10

**Coach-Chat:**
- Supabase-persistente Messages (chat_messages)
- Thread-ID aus localStorage
- buildCoachContext() + COACH_SYSTEM_PROMPT bei jedem Message
- Typing-Indicator
- Neue-Gespräch-Button
- Auto-resize Textarea

**Coach-System (Kapitel 18):**
- Equipment-Sektion in Profile.tsx (Checkboxen + max_kg für Kurzhanteln, Gym-Mutex-Logik)
- Ästhetik-Ziele in Profile.tsx (Drag-and-drop Ranking via @dnd-kit, nur bei "Muskelaufbau" oder "Gewicht reduzieren")
- athletes-Schema: `equipment JSONB` + `aesthetic_goals JSONB`
- LAUF_COACH_PROMPT, RAD_COACH_PROMPT, KRAFT_COACH_PROMPT in coachPrompt.ts
- buildSpecialistContext(athleteId, sport) in coachContext.ts
- Coach-Routing in ActivityDetail.tsx (getCoachPrompts, parallel context build)
- Echtzeit-Alert in Dashboard.tsx (Claude-Konfliktcheck, sessionStorage-Gate, Amber-Banner + Modal)
- `coach_decisions.related_activity_id UUID` (FK→activities) — DB-Migration angewendet
- `triggerRecoveryExtraction(analysisText, athleteId, activityId)` Helper in ActivityDetail
- On-load Recovery-Check: fehlende Extractions für bestehende Analysen werden nachgeholt
- `buildCoachSystemPrompt(athleteId): Promise<string>` — dynamischer Hauptcoach-Prompt
- `calculateSeasonPhase()`, `calculateHRZones()`, `calculatePaceReference()` — exportierte Helpers in coachContext.ts
- `athletes.season_phase_override` + `athletes.best_5k_seconds` — neue DB-Felder (Migration angewendet)
- Trainingsphase-Sektion in Profile.tsx mit Segmented Control (Auto/Override)
- `activeSport`-Parameter in `buildCoachSystemPrompt()` + `buildCoachContext()`: FTP/W-kg technisch aus dem Kontext entfernt bei Lauf-/Kraft-fokussierten Analysen (kontextuelle Blindheit strukturell statt nur per Prompt-Anweisung)
- **Bugfix Datumsfehler in Coach-Analysen (2. Juli 2026):** `[COACH-ENTSCHEIDUNGEN]` weist Aktivitätsdatum (via `related_activity_id`) getrennt von `created_at` aus; `[AKTUELLER WOCHENPLAN]` bettet Kalenderdatum direkt in die Mo–So-Tagesschlüssel ein (`planJsonWithDates()`); `[LETZTE AKTIVITÄTS-ANALYSE]` nutzt `toLocalDateStr()` statt `date.slice(0,10)` — siehe Kapitel 11

**Nutzerdaten & Feature-Flags:**
- `athletes.gender`, `athletes.birth_year`, `athletes.resting_hr` — neue DB-Felder (Migration angewendet)
- `athletes.features JSONB` — Feature-Flags pro User (Migration angewendet)
- `src/lib/features.ts`: `FeatureFlags`, `DEFAULT_FEATURES`, `useFeatures()`
- Profil ALLGEMEIN: Geschlecht (Segmented Control) + Geburtsjahr (Number Input)
- Profil LEISTUNGSDATEN: Ruheherzfrequenz nach Max HF
- BottomNav: selbst-ladendes Feature-Gate (Plan/Coach/Ziele bedingt)
- Dashboard: Filter-Buttons Rad/Kraft bedingt
- WeeklyPlan/Chat/Goals: Redirect zu /dashboard wenn Feature disabled
- `buildCoachSystemPrompt`: Alter, W/kg, HF-Reserve, Karvonen-Zonen wenn `resting_hr` vorhanden

**Multi-User Vorbereitung (RLS):**
- `set_athlete_context` Supabase-Funktion (SECURITY DEFINER)
- RLS-Policies auf allen 6 Tabellen (athletes, activities, season_goals, weekly_plans, coach_decisions, chat_messages)
- `getValidAccessToken()` + `restoreSessionFromSupabase()`: fire-and-forget `set_athlete_context` RPC
- Hinweis: pgBouncer Transaction Mode limitiert die Effektivität (Session-Variablen persistent nur in Session Mode)

**Sicherheit:**
- STRAVA_CLIENT_SECRET nie im Browser-Bundle
- ANTHROPIC_API_KEY nie im Browser-Bundle
- Prompt-Size-Limit (80k Zeichen)
- max_tokens Cap (4.096)
- Null-Guards für fehlende Athlete/Activity-Daten

---

### Nicht implementiert ❌

- **Supabase Auth / Multi-User-Login** — kein Registrierungsformular, kein E-Mail/Passwort-Login; nur Strava OAuth
- **Dynamischer System-Prompt** — ✅ Implementiert: `buildCoachSystemPrompt(athleteId)` lädt Athleten-Daten + A-Event aus Supabase; HF-Zonen, Pace-Referenz und Saison-Phase werden dynamisch berechnet
- **Hevy API-Integration** — Hevy-Daten kommen ausschließlich via Strava description; kein `hevy_api_key`, keine eigene `strength_workouts`-Tabelle
- **Body Check-in** — implementiert (Foto-Upload + Claude Vision + `body_checkins`-Tabelle) und am 1. Juli 2026 vollständig wieder entfernt (Produktentscheidung, kein Bugfix) — nicht Teil der App, siehe Hinweis am Ende der Datei
- **Kraftcoach-Ästhetik-Bewertung** — Equipment + aesthetic_goals werden zwar als Kontext mitgeschickt, aber es gibt kein automatisches Übungs-Matching / Lücken-Identifikation (Phase D aus Kap. 18)
- **Aktivitäts-Matching** ✅ — DayCards zeigen Status completed/missed/pending; Tap auf completed → ActivityDetail
- **Recovery-Extraktion für bestehende Analysen** — ✅ Behoben: ActivityDetail prüft beim Laden einer bestehenden `claude_analysis` ob bereits ein `coach_decisions`-Eintrag mit `related_activity_id = act.id` und `decision_type = 'recovery_required'` existiert. Falls nicht → fire-and-forget Extraction wird nachträglich getriggert.
- **Pagination** — nur immer die letzten 10 Aktivitäten (kein "Mehr laden")
- **CTL/ATL/TSB Fitness-Kurve**
- **Push Notifications**
- ~~Bottom-Navigation Mobile~~ ✅ Implementiert
- **Aktivitäts-spezifischer Chat-Thread**
- **OAuth State-Parameter** (CSRF-Schutz bei OAuth-Flow)

---

## 17. Feature-Flags

Feature-Flags steuern pro User welche Funktionen sichtbar und zugänglich sind. Keine eigene Verwaltungs-UI — Flags werden direkt in Supabase gesetzt.

### Felder

```typescript
// src/lib/features.ts
interface FeatureFlags {
  cycling: boolean      // Radfahren Tab/Filter/Sportart-Pill
  running: boolean      // immer true — Basis-Feature, nicht abschaltbar per UI
  strength: boolean     // Krafttraining Tab/Filter/Sportart-Pill/Sektion
  weekly_plan: boolean  // /plan Route (Redirect zu /dashboard wenn false)
  coach_chat: boolean   // /chat Route (Redirect zu /dashboard wenn false)
  goals: boolean        // /goals Route (Redirect zu /dashboard wenn false)
}
```

### Feature-Flags per User anpassen

1. Supabase Dashboard → Table Editor → athletes
2. Zeile des Users finden (via `name` oder `strava_athlete_id`)
3. `features` Spalte editieren (JSON direkt im Table Editor)
4. Speichern — wirkt sofort beim nächsten App-Load

**Beispiel Nur-Lauf-User:**
```json
{
  "cycling": false,
  "running": true,
  "strength": false,
  "weekly_plan": true,
  "coach_chat": true,
  "goals": true
}
```

### Auswirkungen

| Flag | Effekt bei `false` |
|---|---|
| `cycling` | Kein Rad-Tab in BottomNav; kein Rad-Filter im Dashboard; kein Radfahren-Pill in Profil |
| `strength` | Kein Krafttraining-Pill; KRAFTTRAINING-Sektion versteckt; kein Kraft-Filter im Dashboard |
| `weekly_plan` | `/plan` → Redirect zu `/dashboard` |
| `coach_chat` | `/chat` → Redirect zu `/dashboard` |
| `goals` | `/goals` → Redirect zu `/dashboard` |

### Implementierung

- `src/lib/features.ts`: `FeatureFlags` Interface, `DEFAULT_FEATURES` (alle true), `useFeatures(athlete)` Funktion
- `useFeatures(athlete)`: merged DEFAULT_FEATURES mit `athlete.features` aus DB (Spread — neue Flags haben automatisch default true)
- `BottomNav.tsx`: selbst-lädt features aus Supabase (einmalig per mount); filtert Tabs
- Seiten mit Redirect: laden athlete inkl. features und navigieren zu `/dashboard` wenn Feature disabled

---

## 18. Multi-User Vorbereitung (RLS)

Datentrennung via PostgreSQL Row Level Security. Basis für zukünftigen Multi-User-Betrieb.

### Konzept

Die App nutzt kein Supabase Auth. Als Ersatz wird `app.strava_athlete_id` als PostgreSQL-Session-Variable gesetzt und in RLS-Policies referenziert.

**Einschränkung:** Supabase verwendet pgBouncer im Transaction Mode. Session-Variablen (via `set_config`) sind in diesem Modus nicht persistent über Requests hinweg. Die Policies sind daher eine Vorbereitung für Session-Mode-Pooling oder direkten DB-Zugriff (Multi-User-Implementierung würde Supabase Auth oder eigene JWT-Claims erfordern).

**Praktische Konsequenz:** Bis Supabase Auth eingeführt wird, ist der Datenschutz zwischen mehreren Athleten ausschließlich auf Anwendungsebene (WHERE athlete_id = X in jeder Query) sichergestellt — nicht auf Datenbankebene. Das reicht für eine kleine, vertrauenswürdige Nutzergruppe (2-3 Personen), ist aber kein Schutz vor gezieltem Zugriff über die Supabase anon key API. Vor öffentlichem Multi-User Onboarding: Supabase Auth zwingend erforderlich (siehe Roadmap).

### Supabase Funktion

```sql
CREATE OR REPLACE FUNCTION set_athlete_context(athlete_id TEXT)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.strava_athlete_id', athlete_id, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### RLS Policies

Alle 6 Datentabellen haben restrictive Policies:
- `athletes`: `strava_athlete_id = NULLIF(current_setting('app.strava_athlete_id', true), '')::bigint`
- Alle anderen: `athlete_id IN (SELECT id FROM athletes WHERE strava_athlete_id = ...)`

### Client-seitige Aktivierung

In `src/lib/strava.ts`:
- `getValidAccessToken()`: ruft `set_athlete_context` als fire-and-forget vor Token-Rückgabe
- `restoreSessionFromSupabase()`: ruft `set_athlete_context` nach Restore des stravaId

```typescript
void supabase.rpc('set_athlete_context', { athlete_id: String(athlete.strava_athlete_id) })
```

---

## 19. Supabase-Projektdetails

- **Name:** peakform
- **Project ID:** `thjihbyyelqrrvdinzti`
- **URL:** `https://thjihbyyelqrrvdinzti.supabase.co`
- **Region:** eu-central-1
- **RLS:** Aktiv auf allen Tabellen; Policy basiert auf `app.strava_athlete_id` Session-Variable via `set_athlete_context()` RPC (siehe Kapitel 18)

---

## 18. Coach-System

### 18.1 Architektur-Überblick

PeakForm verwendet ein zweistufiges Coach-System:

**Hauptcoach (immer aktiv)**
- Kennt alle Athleten-Daten: FTP, Lauf-PB, Kraftvolumen, Gewichte, Ästhetik-Ziele
- Kennt alle aktiven Saison-Ziele (A/B/C-Priorität, alle Sportarten)
- Kennt die gesamte Trainingshistorie (letzte 8 Wochen, alle Sportarten)
- Kennt den aktuellen und geplanten Wochenplan
- Überwacht Übertraining, fehlende Variation, Konflikte zwischen Sportarten
- Greift aktiv ein bei kritischen Konflikten (Echtzeit-Alert)
- Gibt vollständige Gesamtbewertung beim wöchentlichen Review
- Delegiert Aktivitätsanalysen unsichtbar an den jeweiligen Spezialcoach

**Spezialcoaches (dynamisch, an aktive Sportarten gebunden)**
- Nur für aktive Sportarten im Athleten-Profil vorhanden
- Aktuell möglich: Laufcoach, Radcoach, Kraftcoach
- Jeder Coach hat tiefes domänenspezifisches Wissen
- Kontextuelle Blindheit: jeder Coach wertet NUR seine Sportart
- Kennt den Gesamtkontext (via Hauptcoach-Kontext-Schicht) aber interpretiert ihn nur aus seiner Sportart-Perspektive
- Analyse-Output ist eine einzige kohärente Antwort (nicht zwei separate Blöcke)

---

### 18.2 Coach-Routing

**Aktivitätsanalyse:**
```
Aktivitätstyp → Spezialcoach
'Run' | 'VirtualRun'        → Laufcoach
'Ride' | 'VirtualRide'      → Radcoach
'WeightTraining'            → Kraftcoach
Alle anderen Typen          → Hauptcoach (generisch)
```

**Chat (global):** Immer Hauptcoach

**Wochenplan-Generierung:** Hauptcoach koordiniert, kennt alle Sportarten-Constraints

**Wochenreview:** Hauptcoach — vollständige Gesamtbewertung aller Sportarten

**Echtzeit-Alerts:** Hauptcoach — bei kritischen Konflikten nach neuer Aktivität

---

### 18.3 Echtzeit-Alert Logik

Nach jedem Strava-Sync in `Dashboard.tsx`:

**Ablauf (einmal pro Session via `sessionStorage`):**
1. `sessionStorage.getItem('peakform_alert_{weekStart}')` prüfen
2. Wenn nicht gesetzt: aktuellen Wochenplan (`weekly_plans`) + neueste Aktivität dieser Woche aus Supabase laden (parallel)
3. Claude-Call (`max_tokens: 150`): Prompt enthält Plan-JSON + Aktivitätsdaten; Claude antwortet AUSSCHLIESSLICH mit `{"conflict": bool, "message": string|null}`
4. `sessionStorage` als gecheckt markieren (verhindert wiederholten Call bei Reload)
5. Bei `conflict: true`: Amber-Banner mit Claude-Message anzeigen

**Alert-Format (Amber-Banner):**
```
⚠  [Claude-generierte Konflikterklärung — max 20 Wörter]
   [Plan anpassen]   [Verwerfen]
```

**"Plan anpassen":**
- Claude-Call (`max_tokens: 600`) mit Plan-JSON + Konflikt-Beschreibung
- Ergebnis in Bottom-Sheet Modal — "Schließen" Button

**Nicht-kritische Abweichungen:** Kein Alert — wird beim wöchentlichen Review besprochen.

---

### 18.4 Spezialcoach-Prompts

#### Laufcoach

**Expertise:**
- Periodisierungsmodelle für Laufen (Daniels Running Formula, Lydiard-Methode)
- HF-Zonen-basiertes Training, Pace-Entwicklung
- Laufökonomie, Kadenz, Technik
- Verletzungsprävention: Achillessehne, Knie, Hüftbeuger, IT-Band
- Readaptation nach Laufpause

**Kontextuelle Blindheit:**
- Wertet niemals FTP oder Wattwerte direkt
- Verwendet niemals die Begriffe "FTP" oder "% FTP" in einer Laufanalyse — auch nicht wenn die Aktivität eigene Watt-Werte enthält (explizit im Prompt verankert, siehe unten)
- Erwähnt Radausdauer nur aus Laufperspektive: "Deine aerobe Basis vom Radfahren hilft dir beim Z2-Laufen"
- Kommentiert kein Krafttraining direkt — nur wie es die Laufleistung beeinflusst
- FTP/W-kg sind bei Lauf-Analysen technisch nicht im Kontext vorhanden (siehe Kapitel 11/12, `activeSport`-Parameter) — die Blindheit ist damit nicht nur eine Prompt-Anweisung, sondern strukturell erzwungen

**Laufleistungsmesser (Stryd o.ä.):**
Falls die Lauf-Aktivität eigene Leistungsdaten (Watt) liefert, sind diese Werte NICHT mit Rad-FTP vergleichbar (andere Watt-Skala). Der Prompt weist den Laufcoach explizit an, solche Watt-Werte ausschließlich für Trend-Vergleiche mit früheren Läufen zu nutzen — niemals als Prozent einer FTP-Zahl.

**Analyse-Fokus:**
- Pace vs. HF-Relation (Effizienz)
- HF-Zonen-Verteilung der Einheit
- Vergleich mit Zielpace (8k-Event)
- Wochenkm-Trend
- Gesamtkontext: Wo steht diese Einheit im 14-Wochen-Plan?

---

#### Radcoach

**Expertise:**
- Trainingszonen nach Coggan (FTP-basiert)
- Normalized Power (NP), Intensity Factor (IF), Training Stress Score (TSS)
- Periodisierung für Granfondos und Rennradrennen
- Zwift-Training vs. Outdoor-Training
- Höhenmeter-spezifische Belastungssteuerung

**Kontextuelle Blindheit:**
- Kommentiert keine Laufpace oder Lauf-HF direkt
- Erwähnt Lauftraining nur aus Rad-Perspektive: "Die Laufeinheiten belasten die Beine zusätzlich — halte den NP heute unter 75% FTP"
- Bewertet kein Krafttraining direkt

**Analyse-Fokus:**
- NP vs. FTP (Intensity Factor)
- TSS und kumulativer Stress
- HF-Drift über die Einheit
- Watt-Kurve: Peaks, Einbrüche, Gleichmäßigkeit
- Vergleich mit letzten vergleichbaren Rides

---

#### Kraftcoach

**Expertise:**
- Hypertrophie-Protokolle (Progressive Overload, RPE-basiertes Training)
- Laufunterstützung durch Krafttraining (Hüftstabilität, Core, Beinkraft)
- Ästhetik-orientiertes Training (Muskelgruppen-spezifisch)
- Home-Gym Übungsalternativen basierend auf verfügbarem Equipment
- Workout-Progression über Wochen (Workout I / II / III Rotation)

**Kontextuelle Blindheit:**
- Bewertet keine Lauf-Pace oder Rad-Watt
- Erwähnt Ausdauertraining nur aus Kraftperspektive: "Nach dem gestrigen langen Ride empfehle ich heute leichteres Gewicht — Muskelermüdung beeinflusst die Kraftleistung"
- Kennt aktuelle Saison-Phase und gewichtet automatisch:
  - Phase 1–2 (Readaptation/Grundlage): Laufstabilität dominiert
  - Phase 3–4 (Wettkampf/Taper): Erhaltung, kein neues Volumen
  - Off-Season: Hypertrophie dominiert

**Ästhetik-Integration:**
- Kennt die Ästhetik-Ziele des Athleten (Muskelgruppen-Prioritäten + Freitext)
- Bewertet jede Einheit: "Workout II hatte 3 Übungen für Po/Hüfte — das zahlt auf dein primäres Ästhetik-Ziel ein"
- Identifiziert Lücken: welche priorisierten Muskelgruppen werden in Workout I/II/III zu wenig trainiert
- Gibt konkrete Ersetzungsvorschläge (nicht komplette Workout-Umschreibungen):
  "Ersetze in Workout II die Beinpresse durch Hip Thrusts 4×10 — direkterer Po-Fokus, gleiche Belastung"
- Berücksichtigt verfügbares Equipment bei jedem Vorschlag

---

### 18.5 Athleten-Profil Erweiterungen

#### Equipment (neues Feld: `equipment` JSONB in athletes-Tabelle)

```json
{
  "dumbbells": { "active": true, "max_kg": 32 },
  "bands": { "active": true },
  "bodyweight": { "active": true },
  "pullup_bar": { "active": true },
  "gym": { "active": false }
}
```

**UI:** Checkbox-Liste mit Gewichtsangabe nur bei Kurzhanteln.  
Wenn "Gym" aktiv → alle anderen Felder werden deaktiviert (Gym = alles verfügbar).

#### Ästhetik-Ziele (neues Feld: `aesthetic_goals` JSONB in athletes-Tabelle)

```json
{
  "priorities": ["glutes", "shoulders", "arms", "core", "chest", "back", "legs"],
  "notes": "Linker Bizeps schwächer als rechter — ausgleichen"
}
```

**Muskelgruppen (Mehrfachauswahl + Drag & Drop Ranking):**
- Po / Hüfte (glutes)
- Schultern (shoulders)
- Arme (arms)
- Core / Bauch (core)
- Brust (chest)
- Rücken (back)
- Beine (legs)

**Reihenfolge = Priorität** — erste Position = höchste Priorität für Kraftcoach.  
Plus Freitext-Feld für Nuancen.

---

### 18.6 Technische Implementierung

#### `buildSpecialistContext(athleteId, sport)` — implementiert ✅

Lädt sportart-spezifische Historien (letzte 60 Tage). Wird parallel zu `buildCoachContext()` aufgerufen.

```
'running'  → Letzte 10 Läufe: Datum | km | Pace min/km | Ø HF
'cycling'  → FTP + Letzte 10 Ausfahrten: Datum | km | NP W (% FTP) | TSS | Ø HF
'strength' → Equipment (aktive Geräte) + Ästhetik-Prioritäten (wenn relevant)
             + Letzte 5 Kraft-Sessions: Datum | Name | Description-Snippet
```

#### Claude-Call Struktur pro Coach — implementiert ✅

```
system:  await buildCoachSystemPrompt(athleteId)      [dynamisch aus DB]
         + '\n\n' + LAUF/RAD/KRAFT_COACH_PROMPT       [statisch, sportart-spezifisch]

user:    buildCoachContext(athleteId)                  [8-Abschnitte Hauptkontext]
         + buildSpecialistContext(athleteId, sport)    [sportart-spezifische Historien]
         + Aktivitätsdaten (Stats, Laps, Hevy-Übungen)
```

Alle drei Promises werden parallel aufgelöst in `runAnalysis()`.

Routing in `ActivityDetail.tsx` via `getSpecialistPrompt(activityType)`:
```
'Run'|'VirtualRun'|'TrailRun'                         → LAUF_COACH_PROMPT, sport:'running'
'Ride'|'VirtualRide'|'MountainBikeRide'|'GravelRide'  → RAD_COACH_PROMPT,  sport:'cycling'
'WeightTraining'|'Workout'                             → KRAFT_COACH_PROMPT, sport:'strength'
Alle anderen                                           → kein Specialist, sport:null
```

#### Echtzeit-Alert — implementiert ✅

Beschreibung: siehe 18.3. Claude-basierter Check (nicht heuristisch-JS), einmal pro Session via sessionStorage.

---

### 18.7 Implementierungs-Status

**Phase A — Profil-Erweiterungen ✅ DONE**
- Equipment-Sektion in Profile.tsx (Checkboxen + Kurzhantel-Gewicht, Gym-Mutex)
- Ästhetik-Ziele in Profile.tsx (Drag & Drop Ranking via @dnd-kit + Freitext)
- Supabase Schema: `equipment JSONB` + `aesthetic_goals JSONB` in athletes
- TypeScript-Types: `EquipmentConfig`, `AestheticGoals` in supabase.ts

**Phase B — Specialist Prompts ✅ DONE**
- `LAUF_COACH_PROMPT`, `RAD_COACH_PROMPT`, `KRAFT_COACH_PROMPT` in `coachPrompt.ts`
- `buildSpecialistContext(athleteId, sport)` in `coachContext.ts`
- `getCoachPrompts(type)` + Coach-Routing in `ActivityDetail.tsx`

**Phase C — Echtzeit-Alerts ✅ DONE**
- Claude-basierter Konflikt-Check nach Strava-Sync
- sessionStorage-Gate (einmal pro Woche)
- Amber-Banner + "Plan anpassen"-Modal in Dashboard.tsx

**Phase D — Kraftcoach Vollintegration ❌ OFFEN**
- Automatisches Übungs-Matching zu Ästhetik-Prioritäten
- Lücken-Identifikation (Muskelgruppen die in Workout I/II/III fehlen)
- Konkrete Ersetzungsvorschläge mit Equipment-Filter

**Phase E — Body Check-in ❌ ENTFERNT (1. Juli 2026)**
- Implementiert (`body_checkins`-Tabelle, Storage Bucket, Upload/Signed-URL-Endpoints, `BodyCheckin.tsx`, Vorwoche-Vergleich, Feedback-Integration in `buildSpecialistContext('strength')`) und anschließend vollständig zurückgebaut — Produktentscheidung, kein Bugfix. Siehe Hinweis am Ende der Datei.

---

## 19. Entfernte Features

**Body Check-in wurde implementiert und anschließend vollständig entfernt (1. Juli 2026) — nicht Teil der App.**

Umfang der Entfernung:
- DB: `body_checkins`-Tabelle gedroppt (Migration `drop_body_checkins_feature_removed`, Rollback von `create_body_checkins_table` + `create_body_checkins_storage_bucket`)
- Storage: Bucket `body-checkins` geleert und gelöscht
- Code: `src/pages/BodyCheckin.tsx`, `api/body-checkin-upload.ts`, `api/body-checkin-url.ts`, `src/lib/imageUtils.ts` gelöscht; alle Referenzen in `App.tsx`, `Dashboard.tsx`, `Profile.tsx`, `features.ts`, `coachContext.ts`, `supabase.ts`, `vite.config.ts` entfernt
- Grund: Produktentscheidung, kein Bugfix — die Diagnose eines Upload-Fehlers beim ersten Check-in eines Users führte zur Entscheidung, das Feature ganz zu streichen statt zu reparieren
