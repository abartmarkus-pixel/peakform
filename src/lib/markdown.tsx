function renderBold(line: string, keyPrefix: string) {
  return line.split(/(\*\*[^*]+\*\*)/).map((part, j) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={`${keyPrefix}-${j}`} className="text-slate-100 font-semibold">{part.slice(2, -2)}</strong>
      : part
  )
}

export function renderMarkdown(text: string) {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let inCode = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // fenced code blocks — skip
    if (line.startsWith('```')) { inCode = !inCode; continue }
    if (inCode) continue

    // table rows — skip
    if (line.startsWith('|')) continue

    // horizontal rule
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={i} className="border-slate-700 my-3" />)
      continue
    }

    // h1 / h2 / h3 (and numbered like "1. ## …")
    const hMatch = line.match(/^#{1,3} (.+)/)
    if (hMatch) {
      nodes.push(
        <h3 key={i} className="font-semibold text-slate-100 mt-4 mb-1 text-base">
          {hMatch[1].replace(/\s*\p{Emoji_Presentation}\s*/gu, '')}
        </h3>
      )
      continue
    }

    // numbered section headers like "1. **Intensitätsbewertung**"
    const secMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*$/)
    if (secMatch) {
      nodes.push(
        <h3 key={i} className="font-semibold text-slate-100 mt-4 mb-1 text-base">
          {secMatch[1]}
        </h3>
      )
      continue
    }

    // bullet points (- or *)
    const bulletMatch = line.match(/^[-*]\s+(.+)/)
    if (bulletMatch) {
      nodes.push(
        <p key={i} className="text-slate-300 text-sm leading-relaxed pl-3 before:content-['–'] before:mr-2 before:text-brand-500">
          {renderBold(bulletMatch[1], String(i))}
        </p>
      )
      continue
    }

    // blockquote (> …)
    const quoteMatch = line.match(/^>\s+(.+)/)
    if (quoteMatch) {
      nodes.push(
        <p key={i} className="text-slate-400 text-sm leading-relaxed italic pl-3 border-l-2 border-brand-500">
          {renderBold(quoteMatch[1], String(i))}
        </p>
      )
      continue
    }

    // blank line
    if (!line.trim()) {
      nodes.push(<div key={i} className="h-1" />)
      continue
    }

    // plain paragraph
    nodes.push(
      <p key={i} className="text-slate-300 text-sm leading-relaxed">
        {renderBold(line, String(i))}
      </p>
    )
  }

  return nodes
}
