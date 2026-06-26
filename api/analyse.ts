import type { VercelRequest, VercelResponse } from '@vercel/node'

const MAX_PROMPT_CHARS = 80_000
const MAX_TOKENS_CAP   = 4_096

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { prompt, max_tokens } = req.body as { prompt: string; max_tokens?: number }
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })
  if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: 'Prompt too large' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Server config error' })

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
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) return res.status(response.status).json({ error: 'Claude API error' })

  const data = await response.json() as { content: { text: string }[] }
  return res.status(200).json({ text: data.content[0].text })
}
