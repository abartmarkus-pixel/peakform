import type { VercelRequest, VercelResponse } from '@vercel/node'

// Oura-Proxy (analog /api/strava-token): Token-Tausch/-Refresh mit OURA_CLIENT_SECRET
// serverseitig, Datenabruf ebenfalls hier (Oura verlangt einen User-Agent-Header und
// erlaubt keine Browser-Aufrufe zuverlässig per CORS). Tokens selbst speichert der Client
// in athletes, wie bei Strava.

const DATA_PATHS = ['daily_readiness', 'daily_sleep', 'sleep'] as const
const USER_AGENT = 'PeakForm/1.0'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body as {
    action: 'token' | 'data'
    grant_type?: 'authorization_code' | 'refresh_token'
    code?: string
    redirect_uri?: string
    refresh_token?: string
    access_token?: string
    path?: string
    start_date?: string
    end_date?: string
  }

  if (body.action === 'token') {
    const clientId = process.env.VITE_OURA_CLIENT_ID
    const clientSecret = process.env.OURA_CLIENT_SECRET
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'Server config error' })

    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret })
    if (body.grant_type === 'authorization_code' && body.code && body.redirect_uri) {
      params.set('grant_type', 'authorization_code')
      params.set('code', body.code)
      params.set('redirect_uri', body.redirect_uri)
    } else if (body.grant_type === 'refresh_token' && body.refresh_token) {
      params.set('grant_type', 'refresh_token')
      params.set('refresh_token', body.refresh_token)
    } else {
      return res.status(400).json({ error: 'Invalid token request' })
    }

    const r = await fetch('https://api.ouraring.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: params,
    })
    if (!r.ok) return res.status(r.status).json({ error: 'Oura token error' })
    return res.status(200).json(await r.json())
  }

  if (body.action === 'data') {
    const path = body.path as typeof DATA_PATHS[number]
    if (!body.access_token || !DATA_PATHS.includes(path) || !body.start_date || !body.end_date) {
      return res.status(400).json({ error: 'Invalid data request' })
    }
    const url = `https://api.ouraring.com/v2/usercollection/${path}?start_date=${encodeURIComponent(body.start_date)}&end_date=${encodeURIComponent(body.end_date)}`
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${body.access_token}`, 'User-Agent': USER_AGENT },
    })
    if (!r.ok) return res.status(r.status).json({ error: 'Oura data error' })
    return res.status(200).json(await r.json())
  }

  return res.status(400).json({ error: 'Unknown action' })
}
