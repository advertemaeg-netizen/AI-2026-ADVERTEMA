/**
 * A legal document's text (public.legal_versions.body), drawn the same way on
 * the site and in the admin editor's preview, so what a super admin previews
 * is what visitors read. The markdown is as small as the documents need:
 * "## " section headings, paragraphs (hard-wrapped lines joined with a space),
 * "- " lists whose items may wrap onto indented lines, and **bold**. Nothing
 * else is interpreted, and nothing is rendered as HTML.
 */
export function LegalMarkdown({ text, headingClassName = 'text-xl font-bold' }: { text: string; headingClassName?: string }) {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .filter((block) => block.trim())
  return blocks.map((block, i) => {
    const lines = block.split('\n')
    if (lines.length === 1 && lines[0].startsWith('## ')) {
      return (
        <h2 key={i} className={headingClassName}>
          {lines[0].slice(3).trim()}
        </h2>
      )
    }
    if (lines[0].startsWith('- ')) {
      const items: string[] = []
      for (const line of lines) {
        if (line.startsWith('- ')) items.push(line.slice(2).trim())
        else items[items.length - 1] += ` ${line.trim()}`
      }
      return (
        <ul key={i} className="flex list-disc flex-col gap-1.5 ps-6 leading-relaxed">
          {items.map((item, j) => (
            <li key={j}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      )
    }
    return (
      <p key={i} className="leading-relaxed">
        <Inline text={lines.map((line) => line.trim()).join(' ')} />
      </p>
    )
  })
}

function Inline({ text }: { text: string }) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part))
}
