import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ctaPrimary, type Cta, type Item } from '@/site/components/home-sections'

/**
 * The sections of the four inner pages (for businesses, for agencies, plans,
 * contact). Like the home page's, each takes only the strings it shows and the
 * page maps the copy file onto them; the vocabulary is the home page's
 * (site.css), so the site reads as one thing.
 */

/** A page's opening: the headline, what it means, and the one call */
export function PageHero({ title, body, cta }: { title: string; body: string; cta?: Cta }) {
  return (
    <section className="flex max-w-4xl flex-col gap-7 pt-6">
      <h1 className="site-display site-rise" style={{ '--i': 0 } as React.CSSProperties}>
        {title}
      </h1>
      <p className="site-lead site-rise max-w-2xl" style={{ '--i': 1 } as React.CSSProperties}>
        {body}
      </p>
      {cta && (
        <a href={cta.href} className={cn(ctaPrimary, 'site-rise self-start')} style={{ '--i': 2 } as React.CSSProperties}>
          {cta.label}
        </a>
      )}
    </section>
  )
}

/** The day, morning to night: each line carries its own time, a rule runs through them */
export function DayTimeline({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="flex flex-col gap-10">
      <h2 className="site-h2 site-reveal max-w-3xl">{title}</h2>
      <ol className="relative flex max-w-3xl flex-col gap-5 border-s-4 border-primary/30 ps-6 md:ps-10">
        {items.map((item, i) => (
          <li key={i} className="site-panel-quiet site-reveal relative p-5 text-lg leading-relaxed md:p-6" style={{ '--i': i } as React.CSSProperties}>
            {/* The dot sits on the rule, at the line's start edge */}
            <span aria-hidden className="absolute -start-[2.15rem] top-7 size-4 rounded-full bg-primary shadow-raised md:-start-[3.15rem]" />
            {item}
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * A heading, what it says, and a note under it. `emphasis`: the note is part
 * of the point (what Mudrik doesn't do) and is set as loud as the body, not
 * as small print.
 */
export function NotePanel({ title, body, note, emphasis = false }: { title: string; body: string; note: string; emphasis?: boolean }) {
  return (
    <section className={cn('site-reveal flex flex-col gap-4 p-8 md:p-10', emphasis ? 'site-panel' : 'site-panel-quiet')}>
      <h2 className="site-h2">{title}</h2>
      <p className="site-lead max-w-3xl">{body}</p>
      <p className={cn('max-w-3xl leading-relaxed', emphasis ? 'site-lead border-s-4 border-primary ps-4 font-semibold' : 'text-base')}>{note}</p>
    </section>
  )
}

/** Said upfront, at full size: what the product doesn't do yet. Not to be softened into small print */
export function Upfront({ title, body }: { title: string; body: string }) {
  return (
    <section className="site-panel site-reveal flex flex-col gap-4 border-s-8 border-s-primary p-8 md:p-10">
      <h2 className="site-h2">{title}</h2>
      <p className="site-lead max-w-3xl">{body}</p>
    </section>
  )
}

/** The plans: no price on any of them, each ends in a conversation */
export function Tiers({ tiers, cta }: { tiers: { name: string; for: string; body: string }[]; cta: Cta }) {
  return (
    <ul className="grid gap-6 md:grid-cols-3">
      {tiers.map((tier, i) => (
        <li key={i} className="site-panel site-reveal flex flex-col gap-4 p-7 md:p-8" style={{ '--i': i } as React.CSSProperties}>
          <h2 className="text-3xl font-bold">{tier.name}</h2>
          <p className="font-semibold text-primary">{tier.for}</p>
          <p className="flex-1 leading-relaxed">{tier.body}</p>
          <Link href={cta.href} className="inline-flex min-h-12 items-center justify-center self-start rounded-full border border-primary/30 bg-white/90 px-6 font-semibold text-primary">
            {cta.label}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Two blocks side by side on a wide screen: the setup and what to do next */
export function Pair({ items }: { items: Item[] }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {items.map((item, i) => (
        <section key={i} className="site-panel-quiet site-reveal flex flex-col gap-3 p-7 md:p-8" style={{ '--i': i } as React.CSSProperties}>
          <h2 className="text-2xl font-bold">{item.label}</h2>
          <p className="leading-relaxed">{item.body}</p>
        </section>
      ))}
    </div>
  )
}
