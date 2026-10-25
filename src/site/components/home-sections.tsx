import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { HeroConversation, type BotTemplates } from '@/site/components/hero-conversation'

/**
 * The home page's eight sections. Each takes only the strings it shows; the
 * page maps the copy file onto them (app/[locale]/site/page.tsx), so a copy
 * change never reaches this file. Motion lives in site.css and is opt-in:
 * with reduced motion every section is simply its final state.
 */

export type Item = { label: string; body: string }
export type Cta = { label: string; href: string }
export const ctaPrimary =
  'inline-flex min-h-12 items-center justify-center rounded-full bg-primary px-6 text-base font-semibold text-primary-foreground shadow-raised'
// bg-white/90: charcoal on it is ≥13:1 over any ground
export const ctaSecondary =
  'inline-flex min-h-12 items-center justify-center rounded-full border border-primary/30 bg-white/90 px-6 text-base font-semibold text-primary'

/* 1 — the hero: the headline, the calls, and the product answering for itself */
export function Hero({
  title,
  subtitle,
  primary,
  secondary,
  demo,
}: {
  title: string
  subtitle: string
  primary: Cta
  secondary: Cta
  demo: { language: 'ar' | 'en'; label: string; visitor: string[]; bot: BotTemplates; builtAt: string }
}) {
  return (
    // The block: the page's one large warm shape, with the headline on its calm side and the product on its warm side
    <section className="site-block grid items-center gap-12 px-6 py-12 md:px-12 md:py-16 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
      <div className="flex flex-col gap-7">
        <h1 className="site-display site-rise" style={{ '--i': 0 } as React.CSSProperties}>
          {title}
        </h1>
        <p className="site-lead site-rise max-w-xl" style={{ '--i': 1 } as React.CSSProperties}>
          {subtitle}
        </p>
        <div className="site-rise flex flex-wrap gap-3" style={{ '--i': 2 } as React.CSSProperties}>
          <a href={primary.href} className={ctaPrimary}>
            {primary.label}
          </a>
          <Link href={secondary.href} className={ctaSecondary}>
            {secondary.label}
          </Link>
        </div>
      </div>
      <div className="relative">
        <HeroConversation {...demo} />
      </div>
    </section>
  )
}

/* 2 — the problem: three cards that arrive on scroll, staggered */
export function Problem({ title, items }: { title: string; items: Item[] }) {
  return (
    <section className="flex flex-col gap-10">
      <h2 className="site-h2 site-reveal max-w-3xl">{title}</h2>
      <ul className="grid gap-6 md:grid-cols-3">
        {items.map((item, i) => (
          <li key={i} className="site-panel site-reveal flex flex-col gap-3 p-7" style={{ '--i': i } as React.CSSProperties}>
            <h3 className="text-xl font-bold">{item.label}</h3>
            <p className="leading-relaxed">{item.body}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/*
 * 1b — the problem, as the sections brief of 25 October 2026 states it: an
 * eyebrow, the heading, the lead, four cards two by two, and the closing line
 * that says it is a problem of tools, not of effort. No icons: the brief rules
 * out a generic set, and the cards stand on their titles.
 */
export function ProblemSection({
  eyebrow,
  title,
  lead,
  cards,
  closing,
}: {
  eyebrow: string
  title: string
  lead: string
  cards: { title: string; body: string }[]
  closing: string
}) {
  return (
    <section className="flex flex-col gap-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <p className="site-reveal text-sm font-semibold text-muted-foreground">{eyebrow}</p>
        <h2 className="site-h2 site-reveal">{title}</h2>
        <p className="site-lead site-reveal max-w-2xl">{lead}</p>
      </div>
      <ul className="grid gap-5 md:grid-cols-2">
        {cards.map((card, i) => (
          <li key={i} className="site-panel-quiet site-reveal flex flex-col gap-3 p-7" style={{ '--i': i } as React.CSSProperties}>
            <h3 className="text-xl font-bold">{card.title}</h3>
            <p className="leading-relaxed">{card.body}</p>
          </li>
        ))}
      </ul>
      <p className="site-reveal self-center text-center text-base text-muted-foreground">{closing}</p>
    </section>
  )
}

/*
 * 4b — the channels, with each one's status stated plainly (the brief's
 * honesty constraint: only the website widget is live). «متاح الآن» is the
 * success chip; «قريبًا» is the NEUTRAL chip, never the warning one: a greyed
 * item reads as planned, an amber one as broken. Which chip is code's
 * decision (the id), the words are the copy's.
 */
export function ChannelsSection({ title, items, note }: { title: string; items: { id: string; name: string; status: string }[]; note: string }) {
  return (
    <section className="site-surface flex flex-col gap-8 py-16 md:py-20">
      <h2 className="site-h2 site-reveal max-w-3xl">{title}</h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item, i) => (
          <li key={item.id} className="site-panel-quiet site-reveal flex flex-col items-start gap-3 p-5" style={{ '--i': i } as React.CSSProperties}>
            <span className="text-lg font-bold">{item.name}</span>
            <Badge variant={item.id === 'website' ? 'positive' : 'quiet'}>{item.status}</Badge>
          </li>
        ))}
      </ul>
      <p className="max-w-3xl text-base text-muted-foreground">{note}</p>
    </section>
  )
}

/* 3 — how it works: three steps in sequence, a line runs through them as you scroll */
export function How({ title, steps, className }: { title: string; steps: Item[]; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-10', className)}>
      <h2 className="site-h2 site-reveal max-w-3xl">{title}</h2>
      <ol
        className={cn(
          'site-steps relative grid gap-10 md:grid-cols-3 md:gap-8',
          // The line: down the start edge on a phone, across the top from md
          '[--site-steps-from-x:1] [--site-steps-from-y:0] [--site-steps-origin:top]',
          'md:[--site-steps-from-x:0] md:[--site-steps-from-y:1] md:[--site-steps-origin:left]',
          'rtl:md:[--site-steps-origin:right]'
        )}
      >
        <span aria-hidden className="site-steps-track start-[1.06rem] top-2 bottom-2 w-0.5 md:start-[8%] md:end-[8%] md:top-[1.06rem] md:bottom-auto md:h-0.5 md:w-auto">
          <span className="site-steps-fill" />
        </span>
        {steps.map((step, i) => (
          <li key={i} className="relative flex gap-5 md:flex-col md:items-center md:text-center">
            <span
              aria-hidden
              className="site-step-dot relative z-10 grid size-9 flex-none place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
              style={{ '--i': i } as React.CSSProperties}
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-xl font-bold">{step.label}</h3>
              <p className="leading-relaxed">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/* 4 — what it does: a calm grid. Not everything can shout */
export function Features({ title, items }: { title: string; items: Item[] }) {
  return (
    <section className="flex flex-col gap-8">
      <h2 className="site-h2 max-w-3xl">{title}</h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {items.map((item, i) => (
          <li key={i} className="site-panel-quiet flex flex-col gap-2 p-6">
            <h3 className="text-lg font-bold">{item.label}</h3>
            <p className="leading-relaxed">{item.body}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* 5 — try it: points at the live widget in the corner (only rendered when it is live) */
export function Try({ title, body }: { title: string; body: string }) {
  return (
    <section className="site-panel site-reveal relative flex flex-col gap-4 overflow-hidden p-8 md:p-12">
      <h2 className="site-h2 max-w-2xl">{title}</h2>
      <p className="site-lead max-w-2xl">{body}</p>
      {/* The widget sits at the bottom RIGHT of the screen in both languages (widget.js default),
          so the arrow is placed physically, not logically */}
      <svg aria-hidden viewBox="0 0 48 48" className="site-pointer mt-2 size-14 text-foreground" style={{ marginLeft: 'auto', ['--site-nudge-x' as string]: '6px' }}>
        <path d="M8 8 C 30 8, 40 18, 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M30 34 L40 41 L44 29" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </section>
  )
}

/* 6 — two paths, equal weight, different character */
export function Paths({
  title,
  self,
  done,
  agencies,
}: {
  title: string
  self: Item & { cta: string; href: string }
  done: Item & { cta: string; href: string }
  agencies: Cta
}) {
  return (
    <section className="flex flex-col gap-10">
      <h2 className="site-h2 site-reveal max-w-3xl">{title}</h2>
      <div className="grid gap-6 md:grid-cols-2">
        {/* Self-serve: direct and quick. Black, white text (18.88); its call in the identity's butter, black on it (13.98) */}
        <div className="site-reveal flex flex-col gap-5 rounded-[1.75rem] bg-primary p-8 text-primary-foreground md:p-10" style={{ '--i': 0 } as React.CSSProperties}>
          <h3 className="text-3xl font-bold">{self.label}</h3>
          <p className="site-lead flex-1">{self.body}</p>
          <a href={self.href} className="inline-flex min-h-12 items-center justify-center self-start rounded-full bg-brand px-6 font-semibold text-brand-foreground">
            {self.cta}
          </a>
        </div>
        {/* Done for you: considered. More air, a quieter surface */}
        <div className="site-panel site-reveal flex flex-col gap-5 p-8 md:p-10" style={{ '--i': 1 } as React.CSSProperties}>
          <h3 className="text-3xl font-bold">{done.label}</h3>
          <p className="site-lead flex-1">{done.body}</p>
          <Link href={done.href} className={cn(ctaSecondary, 'self-start')}>
            {done.cta}
          </Link>
        </div>
      </div>
      <Link href={agencies.href} className="self-start font-semibold underline underline-offset-4">
        {agencies.label}
      </Link>
    </section>
  )
}

/* 7 — the pricing teaser: short and quiet */
export function PricingTeaser({ title, body, cta }: { title: string; body: string; cta: Cta }) {
  return (
    <section className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center">
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="leading-relaxed">{body}</p>
      <Link href={cta.href} className="font-semibold underline underline-offset-4">
        {cta.label}
      </Link>
    </section>
  )
}

/* 8 — the page ends on the call (the other pages end on one call, without the second) */
export function Closing({ title, body, primary, secondary }: { title: string; body: string; primary: Cta; secondary?: Cta }) {
  return (
    // The second, smaller block; it stands still and its content rises (a transform on the section would move the block too)
    <section className="site-block site-block-small flex flex-col items-center gap-6 px-6 py-16 text-center md:py-20">
      <h2 className="site-h2 site-reveal max-w-3xl">{title}</h2>
      <p className="site-lead max-w-3xl">{body}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <a href={primary.href} className={ctaPrimary}>
          {primary.label}
        </a>
        {secondary && (
          <Link href={secondary.href} className={ctaSecondary}>
            {secondary.label}
          </Link>
        )}
      </div>
    </section>
  )
}
