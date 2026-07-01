import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { createClient } from '@supabase/supabase-js'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_PROMPT_CHARS = 80_000
const MAX_TOKENS_CAP   = 4_096
const MAX_BASE64_CHARS = 2_000_000
const PERSPECTIVES     = ['front', 'side', 'back']
const MAX_IMAGES       = 10
const MAX_PATHS        = 10
const SIGNED_URL_TTL_S = 60

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
        includeAssets: ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
        manifest: {
          name: 'PeakForm',
          short_name: 'PeakForm',
          description: 'KI-Trainingscoach mit Strava-Integration',
          theme_color: '#1D9E75',
          background_color: '#0f172a',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
                  const { grant_type, code, refresh_token } = JSON.parse(body) as {
                    grant_type: string; code?: string; refresh_token?: string
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

          // ── /api/body-checkin-upload ────────────────────────────
          server.middlewares.use(
            '/api/body-checkin-upload',
            async (req: IncomingMessage, res: ServerResponse) => {
              if (req.method !== 'POST') {
                res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return
              }
              let body = ''
              req.on('data', (chunk: Buffer) => { body += chunk.toString() })
              req.on('end', async () => {
                try {
                  const { athleteId, date, perspective, base64, mediaType } = JSON.parse(body) as {
                    athleteId: string; date: string; perspective: string; base64: string; mediaType: string
                  }
                  res.setHeader('Content-Type', 'application/json')
                  if (!athleteId || !date || !perspective || !base64) {
                    res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing fields' })); return
                  }
                  if (!PERSPECTIVES.includes(perspective)) {
                    res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid perspective' })); return
                  }
                  if (mediaType !== 'image/jpeg') {
                    res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid mediaType' })); return
                  }
                  if (base64.length > MAX_BASE64_CHARS) {
                    res.statusCode = 400; res.end(JSON.stringify({ error: 'Image too large' })); return
                  }
                  const supabaseUrl = env.VITE_SUPABASE_URL
                  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
                  if (!supabaseUrl || !serviceRoleKey) {
                    res.statusCode = 500; res.end(JSON.stringify({ error: 'Server config error' })); return
                  }
                  const supabase = createClient(supabaseUrl, serviceRoleKey)
                  const path = `${athleteId}/${date}/${perspective}.jpg`
                  const buffer = Buffer.from(base64, 'base64')
                  const { error } = await supabase.storage
                    .from('body-checkins')
                    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true })
                  if (error) {
                    res.statusCode = 500; res.end(JSON.stringify({ error: 'Upload failed' })); return
                  }
                  res.end(JSON.stringify({ path }))
                } catch (e) {
                  res.statusCode = 500
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: 'Internal server error' }))
                }
              })
            },
          )

          // ── /api/body-checkin-url ───────────────────────────────
          server.middlewares.use(
            '/api/body-checkin-url',
            async (req: IncomingMessage, res: ServerResponse) => {
              if (req.method !== 'POST') {
                res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return
              }
              let body = ''
              req.on('data', (chunk: Buffer) => { body += chunk.toString() })
              req.on('end', async () => {
                try {
                  const { paths } = JSON.parse(body) as { paths: string[] }
                  res.setHeader('Content-Type', 'application/json')
                  if (!paths?.length) {
                    res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing paths' })); return
                  }
                  if (paths.length > MAX_PATHS) {
                    res.statusCode = 400; res.end(JSON.stringify({ error: 'Too many paths' })); return
                  }
                  const supabaseUrl = env.VITE_SUPABASE_URL
                  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
                  if (!supabaseUrl || !serviceRoleKey) {
                    res.statusCode = 500; res.end(JSON.stringify({ error: 'Server config error' })); return
                  }
                  const supabase = createClient(supabaseUrl, serviceRoleKey)
                  const urls: Record<string, string> = {}
                  for (const path of paths) {
                    const { data, error } = await supabase.storage
                      .from('body-checkins')
                      .createSignedUrl(path, SIGNED_URL_TTL_S)
                    if (error) {
                      res.statusCode = 500; res.end(JSON.stringify({ error: 'Signing failed' })); return
                    }
                    urls[path] = data.signedUrl
                  }
                  res.end(JSON.stringify({ urls }))
                } catch (e) {
                  res.statusCode = 500
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: 'Internal server error' }))
                }
              })
            },
          )
        },
      },
    ],
  }
})
