import type { SitePage as Page } from '@/site/config'
import { SiteHeader } from '@/site/components/site-header'

/**
 * One page of the site: the shared header, then the page's own content.
 * Pages lay out their copy inside; the structure here is the only styling the
 * scaffold carries, and the visual pass comes with the copy.
 */
export function SitePage({ locale, page, wide = false, children }: { locale: string; page: Page; wide?: boolean; children: React.ReactNode }) {
  return (
    <>
      <SiteHeader locale={locale} page={page} />
      {/* A word longer than the screen (a URL, a long name) wraps rather than running off the edge.
          The home page (wide) is a sequence of sections with room between them */}
      <main
        id="main"
        className={`mx-auto flex max-w-6xl flex-col px-4 [overflow-wrap:anywhere] ${wide ? 'gap-28 pt-10 md:gap-40 md:pt-16' : 'gap-16 pt-16'}`}
      >
        {children}
      </main>
    </>
  )
}

/** A page's opening: its title and intro */
export function SiteHero({ title, intro }: { title: string; intro: string }) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-4xl font-bold sm:text-6xl">{title}</h1>
      <p className="max-w-2xl text-lg">{intro}</p>
    </section>
  )
}

/** Heading-and-body blocks, as many as the copy file has */
export function SiteSections({ sections }: { sections: { heading: string; body: string }[] }) {
  return sections.map((section, i) => (
    <section key={i} className="flex flex-col gap-3">
      <h2 className="text-2xl font-semibold">{section.heading}</h2>
      <p className="max-w-2xl">{section.body}</p>
    </section>
  ))
}
