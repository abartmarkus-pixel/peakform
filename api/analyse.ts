import type { VercelRequest, VercelResponse } from '@vercel/node'

const MAX_PROMPT_CHARS = 80_000
const MAX_TOKENS_CAP   = 4_096
const MAX_IMAGES       = 10
const MAX_IMAGE_CHARS  = 2_000_000

type ImageInput = { base64: string; mediaType: string; label?: string }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { prompt, max_tokens, system, images } = req.body as {
    prompt: string; max_tokens?: number; system?: string; images?: ImageInput[]
  }
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })
  if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: 'Prompt too large' })
  if (images && images.length > MAX_IMAGES) return res.status(400).json({ error: 'Too many images' })
  if (images?.some(img => img.base64.length > MAX_IMAGE_CHARS)) return res.status(400).json({ error: 'Image too large' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Server config error' })

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

  if (!response.ok) return res.status(response.status).json({ error: 'Claude API error' })

  const data = await response.json() as { content: { text: string }[] }
  return res.status(200).json({ text: data.content[0].text })
}
