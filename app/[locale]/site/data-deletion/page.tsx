import { setRequestLocale } from 'next-intl/server'
import { DATA_DELETION_PAGE, PRIVACY_EMAIL } from '@/site/config'
import { SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  const copy = siteCopy(locale).dataDeletion
  return siteMetadata(locale, DATA_DELETION_PAGE, { metaTitle: copy.title, metaDescription: copy.metaDescription })
}

/** A body's lines as paragraphs, the privacy address in them a mailto link */
function Body({ text }: { text: string }) {
  return text.split('\n').map((line, i) => {
    const [before, ...after] = line.split(PRIVACY_EMAIL)
    return (
      <p key={i} className="max-w-2xl leading-relaxed">
        {before}
        {after.length > 0 && (
          <>
            <a href={`mailto:${PRIVACY_EMAIL}`} dir="ltr" className="font-medium whitespace-nowrap underline underline-offset-4">
              {PRIVACY_EMAIL}
            </a>
            {after.join(PRIVACY_EMAIL)}
          </>
        )}
      </p>
    )
  })
}

/**
 * How to have your data deleted (DATA_DELETION_PAGE): instructions, in the
 * legal pages' frame. The copy is messages/site's dataDeletion, in its order.
 */
export default async function DataDeletionPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).dataDeletion
  const sections = [copy.who, copy.how, copy.verify, copy.account, copy.deleted, copy.kept, copy.elsewhere, copy.timing]

  return (
    <SitePage locale={locale} page={DATA_DELETION_PAGE}>
      <article className="site-panel-quiet mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-10">
        <h1 className="site-h2">{copy.title}</h1>
        {sections.map((section) => (
          <section key={section.heading} className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">{section.heading}</h2>
            <Body text={section.body} />
            {/* The one line with no heading of its own: under how we verify */}
            {section === copy.verify && <Body text={copy.clinicTold.body} />}
          </section>
        ))}
      </article>
    </SitePage>
  )
}
