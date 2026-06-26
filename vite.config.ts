import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import type { IncomingMessage, ServerResponse } from 'node:http'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
        manifest: {
          name: 'PeakForm',
          short_name: 'PeakForm',
          description: 'KI-Trainingscoach mit Strava-Integration',
          theme_color: '#1D9E75',
          background_color: '#0f172a',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
        },
      }),
      {
        name: 'api-middleware',
        configureServer(server) {
          server.middlewares.use(
            '/api/analyse',
            async (req: IncomingMessage, res: ServerResponse) => {
              if (req.method !== 'POST') {
                res.statusCode = 405
                res.end(JSON.stringify({ error: 'Method not allowed' }))
                return
              }
              let body = ''
              req.on('data', (chunk: Buffer) => { body += chunk.toString() })
              req.on('end', async () => {
                try {
                  const { prompt } = JSON.parse(body) as { prompt: string }
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
                      max_tokens: 1024,
                      messages: [{ role: 'user', content: prompt }],
                    }),
                  })
                  const data = await response.json() as { content: { text: string }[] }
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ text: data.content[0].text }))
                } catch (e) {
                  res.statusCode = 500
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: String(e) }))
                }
              })
            },
          )
        },
      },
    ],
  }
})
