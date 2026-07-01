import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MAX_BASE64_CHARS = 2_000_000
const PERSPECTIVES = ['front', 'side', 'back'] as const

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { athleteId, date, perspective, base64, mediaType } = req.body as {
    athleteId: string; date: string; perspective: string; base64: string; mediaType: string
  }

  if (!athleteId || !date || !perspective || !base64) return res.status(400).json({ error: 'Missing fields' })
  if (!PERSPECTIVES.includes(perspective as typeof PERSPECTIVES[number])) return res.status(400).json({ error: 'Invalid perspective' })
  if (mediaType !== 'image/jpeg') return res.status(400).json({ error: 'Invalid mediaType' })
  if (base64.length > MAX_BASE64_CHARS) return res.status(400).json({ error: 'Image too large' })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: 'Server config error' })

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const path = `${athleteId}/${date}/${perspective}.jpg`
  const buffer = Buffer.from(base64, 'base64')

  const { error } = await supabase.storage
    .from('body-checkins')
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true })

  if (error) return res.status(500).json({ error: 'Upload failed' })
  return res.status(200).json({ path })
}
