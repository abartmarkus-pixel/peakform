# PeakForm

KI-Trainingscoach als Progressive Web App — verbindet Strava und Hevy mit Claude-Analysen.

## Features

- Strava OAuth + automatischer Token-Refresh + persistente Session (kein Re-Login nötig)
- Aktivitäts-Analyse via Claude (Ausdauer + Krafttraining)
- Wochenplan-Generierung mit Constraint-Validierung
- Saisonziele (A/B/C-Priorität) mit Countdown
- Globaler Coach-Chat mit Gesprächshistorie
- PWA (installierbar, Offline-fähig)

## Tech-Stack

| Schicht | Technologie |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| Charts | Recharts |
| Routing | React Router v6 |
| Backend/DB | Supabase (PostgreSQL) |
| KI | Claude Sonnet via Vercel Serverless Function |
| Hosting | Vercel |
| PWA | vite-plugin-pwa |

## Setup

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Umgebungsvariablen konfigurieren
cp .env.example .env
# Trage deine Keys in .env ein (siehe unten)

# 3. Entwicklungsserver starten
npm run dev
# → http://localhost:5173
```

## Umgebungsvariablen

Siehe `.env.example` für alle benötigten Variablen:

| Variable | Beschreibung |
|---|---|
| `VITE_SUPABASE_URL` | Supabase Projekt-URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase Anon/Public Key |
| `VITE_STRAVA_CLIENT_ID` | Strava API Client ID |
| `STRAVA_CLIENT_SECRET` | Strava API Client Secret (kein `VITE_`-Prefix — nur serverseitig) |
| `VITE_STRAVA_REDIRECT_URI` | OAuth Callback URL (lokal: `http://localhost:5173/auth/callback`) |
| `ANTHROPIC_API_KEY` | Anthropic API Key (kein `VITE_`-Prefix — nur serverseitig) |

> `ANTHROPIC_API_KEY` wird **nie** an den Browser übertragen. Er wird ausschließlich in der Vercel Serverless Function (`api/analyse.ts`) verwendet.

## Deployment (Vercel)

1. Repository mit Vercel verknüpfen
2. Alle Variablen aus `.env.example` in Vercel Environment Variables eintragen
3. `VITE_STRAVA_REDIRECT_URI` auf `https://deine-domain.vercel.app/auth/callback` setzen
4. In Strava API Settings: Authorization Callback Domain eintragen
