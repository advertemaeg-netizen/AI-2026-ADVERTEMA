import { setRequestLocale } from 'next-intl/server'
import { routing } from '@/i18n/routing'
import { SiteFooter } from '@/site/components/site-footer'
import './site.css'

/**
 * The marketing site (mudrik-ai.com), served from this internal segment:
 * proxy.ts rewrites the site's hosts here (src/site/host-routing.ts) and
 * answers 404 for it on the app's host. Visitors never see "/site" in a URL.
 *
 * Fully static: both locales are rendered at build time and nothing here
 * reads the request. <html lang dir> comes from the [locale] layout.
 *
 * dynamicParams stays at its default (true) so that a page whose cache entry
 * is lost renders again. With false, Next refused to regenerate it, fell
 * through to the [...rest] 404 and wrote that 404 over the prerendered file,
 * which kept the site down until the container was recreated. An unknown
 * locale still gets a 404: the proxy never sends one here, and the [locale]
 * layout's hasLocale() check is the backstop.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params
  setRequestLocale(locale)
  return (
    <>
      {/* The site's field, at full strength, over the product's quieter one */}
      <div aria-hidden className="site-field" />
      {children}
      <SiteFooter locale={locale} />
    </>
  )
}
