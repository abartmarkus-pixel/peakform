import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { buildIcsFeed, type WeeklyPlanRow } from './api/_lib/ics'

const MAX_PROMPT_CHARS = 80_000
const MAX_TOKENS_CAP   = 4_096
const MAX_BASE64_CHARS = 2_000_000
const MAX_IMAGES       = 10

type ImageInput = { base64: string; mediaType: string; label?: string }
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        injectManifest: {
          // Icons/Manifest liegen unter der 2 MB-Standardgrenze, aber die
          // API-Bundles wachsen — Reserve statt spätem Build-Abbruch.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        includeAssets: [
          'favicon-16.png',
          'favicon-32.png',
          'apple-touch-icon.png',
          'icon-192.png',
          'icon-512.png',
          'icon-192-maskable.png',
          'icon-512-maskable.png',
        ],
        manifest: {
          name: 'PeakForm',
          short_name: 'PeakForm',
          description: 'KI-Trainingscoach mit Strava-Integration',
          theme_color: '#1D9E75',
          background_color: '#0f172a',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
      {
        name: 'api-middleware',
        configureServer(server) {
          // ── /api/strava-token ───────────────────────────────────
          server.middlewares.use(
            '/api/strava-token',
            async (req: IncomingMessage, res: ServerResponse) => {
              if (req.method !== 'POST') {
                res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return
              }
              let body = ''
              req.on('data', (chunk: Buffer) => { body += chunk.toString() })
              req.on('end', async () => {
                try {
                  const { grant_type, code, refresh_token, access_token } = JSON.parse(body) as {
                    grant_type: string; code?: string; refresh_token?: string; access_token?: string
                  }

                  if (grant_type === 'deauthorize') {
                    if (!access_token) {
                      res.statusCode = 400
                      res.end(JSON.stringify({ error: 'Missing access_token' })); return
                    }
                    const r = await fetch('https://www.strava.com/oauth/deauthorize', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                      body: new URLSearchParams({ access_token }),
                    })
                    res.statusCode = r.ok ? 200 : r.status
                    res.setHeader('Content-Type', 'application/json')
                    res.end(r.ok ? JSON.stringify({ success: true }) : JSON.stringify({ error: 'Strava deauthorize error' }))
                    return
                  }

                  const clientId = env.VITE_STRAVA_CLIENT_ID
                  const clientSecret = env.STRAVA_CLIENT_SECRET
                  if (!clientId || !clientSecret) {
                    res.statusCode = 500
                    res.end(JSON.stringify({ error: 'Server config error' })); return
                  }
                  const payload: Record<string, string> = { client_id: clientId, client_secret: clientSecret, grant_type }
                  if (code) payload.code = code
                  if (refresh_token) payload.refresh_token = refresh_token

                  const r = await fetch('https://www.strava.com/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  })
                  res.statusCode = r.ok ? 200 : r.status
                  res.setHeader('Content-Type', 'application/json')
                  res.end(r.ok ? JSON.stringify(await r.json()) : JSON.stringify({ error: 'Strava token error' }))
                } catch (e) {
                  res.statusCode = 500
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: String(e) }))
                }
              })
            },
          )

          // ── /api/analyse ────────────────────────────────────────
          server.middlewares.use(
            '/api/analyse',
            async (req: IncomingMessage, res: ServerResponse) => {
              if (req.method !== 'POST') {
                res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return
              }
              let body = ''
              req.on('data', (chunk: Buffer) => { body += chunk.toString() })
              req.on('end', async () => {
                try {
                  const { prompt, max_tokens, system, images } = JSON.parse(body) as {
                    prompt: string; max_tokens?: number; system?: string; images?: ImageInput[]
                  }
                  res.setHeader('Content-Type', 'application/json')
                  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
                    res.statusCode = 400
                    res.end(JSON.stringify({ error: 'Invalid prompt' })); return
                  }
                  if (images && images.length > MAX_IMAGES) {
                    res.statusCode = 400
                    res.end(JSON.stringify({ error: 'Too many images' })); return
                  }
                  if (images?.some(img => img.base64.length > MAX_BASE64_CHARS)) {
                    res.statusCode = 400
                    res.end(JSON.stringify({ error: 'Image too large' })); return
                  }
                  let content: string | ContentBlock[] = prompt
                  if (images?.length) {
                    const blocks: ContentBlock[] = []
                    for (const img of images) {
                      if (img.label) blocks.push({ type: 'text', text: img.label })
                      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })
                    }
                    blocks.push({ type: 'text', text: prompt })
                    content = blocks
                  }
                  const apiKey = env.ANTHROPIC_API_KEY
                  const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-api-key': apiKey,
                      'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                      model: 'claude-sonnet-4-6',
                      max_tokens: Math.min(max_tokens ?? 1024, MAX_TOKENS_CAP),
                      ...(system && { system }),
                      messages: [{ role: 'user', content }],
                    }),
                  })
                  const data = await response.json() as { content: { text: string }[] }
                  res.end(JSON.stringify({ text: data.content[0].text }))
                } catch (e) {
                  res.statusCode = 500
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: 'Internal server error' }))
                }
              })
            },
          )

          // ── /api/calendar/:athleteId (ICS-Feed) ─────────────────
          server.middlewares.use(
            '/api/calendar',
            async (req: IncomingMessage, res: ServerResponse) => {
              const athleteId = req.url?.replace(/^\//, '').split('?')[0]
              if (!athleteId || athleteId.length < 10) {
                res.statusCode = 400
                res.end(JSON.stringify({ error: 'Invalid athleteId' })); return
              }
              try {
                const supabaseUrl = env.VITE_SUPABASE_URL
                const anonKey = env.VITE_SUPABASE_ANON_KEY
                const supabase = createClient(supabaseUrl, anonKey)

                const { data: plans, error } = await supabase
                  .from('weekly_plans')
                  .select('week_start, version, plan_json')
                  .eq('athlete_id', athleteId)
                  .order('version', { ascending: false })
                if (error) {
                  res.statusCode = 500
                  res.end(JSON.stringify({ error: error.message })); return
                }

                const latestByWeek = new Map<string, WeeklyPlanRow>()
                for (const p of plans ?? []) {
                  const weekStart = p.week_start as string
                  if (!latestByWeek.has(weekStart)) {
                    latestByWeek.set(weekStart, { week_start: weekStart, plan_json: p.plan_json as WeeklyPlanRow['plan_json'] })
                  }
                }

                const ics = buildIcsFeed(athleteId, [...latestByWeek.values()])
                res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
                res.statusCode = 200
                res.end(ics)
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: String(e) }))
              }
            },
          )

        },
      },
    ],
  }
})
