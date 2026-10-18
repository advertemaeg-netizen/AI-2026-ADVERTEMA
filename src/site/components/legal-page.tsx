import type { SitePage as Page } from '@/site/config'
import { SitePage } from '@/site/components/site-page'

/**
 * A legal page: title, the date it was last changed, and its sections. The
 * text is a DRAFT pending a lawyer until Ahmed confirms the review; the site
 * is not deployed publicly before then (deploy/ROLLBACK.md, launch blocker).
 * Its [[placeholders]] stay visible on purpose: a draft shows what is missing.
 */
export function LegalPage({
  locale,
  page,
  notice,
  copy,
}: {
  locale: string
  page: Page
  /** «مسودة — هذه الصفحة قيد المراجعة القانونية ولم تُعتمد بعد.» until the review is done */
  notice: string
  copy: { title: string; updated: string; sections: { heading: string; body: string }[] }
}) {
  return (
    <SitePage locale={locale} page={page}>
      <article className="site-panel-quiet mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-10">
        <header className="flex flex-col gap-3">
          <p role="note" className="rounded-lg border border-warning-solid bg-warning-solid/15 px-3 py-2 text-sm font-semibold">
            {notice}
          </p>
          <h1 className="site-h2">{copy.title}</h1>
          <p className="text-sm">{copy.updated}</p>
        </header>
        {copy.sections.map((section, i) => (
          <section key={i} className="flex flex-col gap-3">
            <h2 className="text-xl font-bold">{section.heading}</h2>
            <LegalBody text={section.body} />
          </section>
        ))}
      </article>
    </SitePage>
  )
}

/**
 * The drafts' markdown, as far as they use it: paragraphs (hard-wrapped lines
 * joined with a space), "- " lists whose items may wrap onto indented lines,
 * and **bold**. Nothing else is interpreted.
 */
function LegalBody({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/)
  return blocks.map((block, i) => {
    const lines = block.split('\n')
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
