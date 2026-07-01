import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const MAX_PATHS = 10
const SIGNED_URL_TTL_S = 60

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { paths } = req.body as { paths: string[] }
  if (!paths?.length) return res.status(400).json({ error: 'Missing paths' })
  if (paths.length > MAX_PATHS) return res.status(400).json({ error: 'Too many paths' })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: 'Server config error' })

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const urls: Record<string, string> = {}

  for (const path of paths) {
    const { data, error } = await supabase.storage
      .from('body-checkins')
      .createSignedUrl(path, SIGNED_URL_TTL_S)
    if (error) return res.status(500).json({ error: 'Signing failed' })
    urls[path] = data.signedUrl
  }

  return res.status(200).json({ urls })
}
