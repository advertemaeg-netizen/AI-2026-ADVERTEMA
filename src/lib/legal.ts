import { createClient } from '@supabase/supabase-js'

/**
 * The legal pages' text, from public.legal_versions (append-only: every save
 * is a new version; supabase/migrations/20261029100000_legal_versions.sql).
 *
 * Read with the publishable key and no cookies, so the pages stay statically
 * generated: at build time and on revalidation, the anonymous read policy
 * (published columns only) is all they need. Every read THROWS on an error:
 * during a revalidation that keeps the last good page in the cache instead of
 * caching an empty one, and a build fails loudly instead of shipping one.
 */

export const LEGAL_DOCUMENTS = ['privacy', 'terms'] as const
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number]
export type LegalLocale = 'ar' | 'en'

export { LEGAL_LINKED } from '@/lib/legal-linked'

/** A published version, as anyone may read it */
export type LegalVersion = {
  id: string
  document: LegalDocument
  locale: LegalLocale
  version: number
  title: string
  body: string
  created_at: string
}

const PUBLIC_COLUMNS = 'id, document, locale, version, title, body, created_at'

/** The cache tag of every read here: a publish expires it (src/lib/actions/legal.ts) */
export const LEGAL_CACHE_TAG = 'legal-versions'

/**
 * How often the legal pages regenerate, in seconds: 300 (the pages' own
 * segment config), or lower with LEGAL_REVALIDATE_SECONDS. A segment's
 * `revalidate` must be a literal; a fetch's can be lower, and the lowest
 * wins for the whole route. The override exists for the cache check
 * (scripts/check-legal-cache.ts), which runs it at 10 seconds.
 */
function revalidateSeconds() {
  const override = Number(process.env.LEGAL_REVALIDATE_SECONDS)
  return Number.isInteger(override) && override > 0 && override < 300 ? override : 300
}

/**
 * A cookie-free client with the publishable key: safe in a statically generated page.
 * Cached and tagged by default: regenerated on the interval, expired at once by a publish.
 * Uncached for a read keyed by something a visitor chooses (a version number): a cached
 * read stores an entry for every value asked for, existing or not, and the version
 * pages' `force-dynamic` does not override this fetch's own options (checked:
 * npm run check:legal-cache, check 5).
 */
function publicClient({ cached = true } = {}) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: cached
        ? (input, init) => fetch(input, { ...init, next: { revalidate: revalidateSeconds(), tags: [LEGAL_CACHE_TAG] } })
        : (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  })
}

/** The current version: the highest number for that document and language. Throws on any error */
export async function currentLegalVersion(document: LegalDocument, locale: LegalLocale): Promise<LegalVersion> {
  const { data, error } = await publicClient()
    .from('legal_versions')
    .select(PUBLIC_COLUMNS)
    .eq('document', document)
    .eq('locale', locale)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle<LegalVersion>()
  if (error) throw new Error(`reading the current ${locale} ${document}: ${error.message}`)
  if (!data) throw new Error(`no version of the ${locale} ${document} exists`)
  return data
}

/** One version by its number, or null when there is no such version. Never cached. Throws on any error */
export async function legalVersion(document: LegalDocument, locale: LegalLocale, version: number): Promise<LegalVersion | null> {
  const { data, error } = await publicClient({ cached: false })
    .from('legal_versions')
    .select(PUBLIC_COLUMNS)
    .eq('document', document)
    .eq('locale', locale)
    .eq('version', version)
    .maybeSingle<LegalVersion>()
  if (error) throw new Error(`reading version ${version} of the ${locale} ${document}: ${error.message}`)
  return data
}

/** Every version's number and date, newest first. Throws on any error */
export async function legalHistory(document: LegalDocument, locale: LegalLocale): Promise<Pick<LegalVersion, 'version' | 'created_at'>[]> {
  const { data, error } = await publicClient()
    .from('legal_versions')
    .select('version, created_at')
    .eq('document', document)
    .eq('locale', locale)
    .order('version', { ascending: false })
  if (error) throw new Error(`reading the history of the ${locale} ${document}: ${error.message}`)
  return data
}
