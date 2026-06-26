import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { grant_type, code, refresh_token } = req.body as {
    grant_type: 'authorization_code' | 'refresh_token'
    code?: string
    refresh_token?: string
  }

  if (!grant_type) return res.status(400).json({ error: 'Missing grant_type' })

  const clientId = process.env.VITE_STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'Server config error' })

  const body: Record<string, string> = { client_id: clientId, client_secret: clientSecret, grant_type }
  if (grant_type === 'authorization_code' && code) body.code = code
  if (grant_type === 'refresh_token' && refresh_token) body.refresh_token = refresh_token

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) return res.status(response.status).json({ error: 'Strava token error' })
  return res.status(200).json(await response.json())
}
