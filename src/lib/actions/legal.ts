'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { z } from 'zod'
import { getSession } from '@/lib/auth/session'
import { isSuperAdmin } from '@/lib/auth/permissions'
import { LEGAL_CACHE_TAG, LEGAL_DOCUMENTS, type LegalDocument, type LegalLocale } from '@/lib/legal'
import { LEGAL_PAGES } from '@/site/config'

/**
 * The legal documents' editor (app/[locale]/admin/legal). A save is a new
 * version, never an edit: publish_legal_version numbers it, records who saved
 * it, and refuses anyone but a super admin (checked here too, so a refusal is
 * an answer, not an error).
 */

export type AdminLegalVersion = {
  id: string
  document: LegalDocument
  locale: LegalLocale
  version: number
  title: string
  body: string
  note: string | null
  created_at: string
  created_by: string | null
  created_by_email: string | null
}

export type PublishLegalResult = { ok: true; version: number } | { ok: false; error: 'forbidden' | 'validation' | 'unchanged' | 'unknown' }

const publishSchema = z.object({
  document: z.enum(LEGAL_DOCUMENTS),
  locale: z.enum(['ar', 'en']),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(100_000),
  note: z.string().trim().max(500).optional(),
})

async function superAdminSession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isSuperAdmin(profile.role)) return null
  return supabase
}

/** Every version of every document, newest first, with who saved it: for the editor */
export async function getLegalVersions(): Promise<AdminLegalVersion[]> {
  const supabase = await superAdminSession()
  if (!supabase) return []
  const { data, error } = await supabase.rpc('admin_legal_versions')
  if (error) throw new Error(`Failed to load the legal documents: ${error.message}`)
  return (data ?? []) as AdminLegalVersion[]
}

/**
 * Publishes the next version of one document in one language. Public at once:
 * the page is regenerated on its next visit (the 5-minute interval is the
 * fallback, not the delay).
 */
export async function publishLegalVersion(input: {
  document: LegalDocument
  locale: LegalLocale
  title: string
  body: string
  note?: string
}): Promise<PublishLegalResult> {
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }
  const parsed = publishSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation' }
  const { document, locale, title, body, note } = parsed.data

  // A version identical to the current one would be a record of nothing changing
  const { data: versions, error: readError } = await supabase.rpc('admin_legal_versions')
  if (readError) {
    console.error('[legal] reading the current version', readError)
    return { ok: false, error: 'unknown' }
  }
  const current = (versions as AdminLegalVersion[]).find((v) => v.document === document && v.locale === locale)
  if (current && current.title === title && current.body === body) return { ok: false, error: 'unchanged' }

  const { data, error } = await supabase.rpc('publish_legal_version', {
    p_document: document,
    p_locale: locale,
    p_title: title,
    p_body: body,
    p_note: note ?? null,
  })
  if (error) {
    if (error.code === '42501') return { ok: false, error: 'forbidden' }
    console.error('[legal] publishing', error)
    return { ok: false, error: 'unknown' }
  }

  const version = (data as { version: number }).version
  // The text cached for every legal page, gone now (not served stale once more)
  updateTag(LEGAL_CACHE_TAG)
  // The current page (the site's hosts rewrite into app/[locale]/site), both
  // languages. Earlier versions' addresses are never cached, so there is
  // nothing there to expire.
  const legalPage = LEGAL_PAGES[document]
  revalidatePath(`/[locale]/site${legalPage}`, 'page')
  revalidatePath('/[locale]/admin/legal', 'page')
  return { ok: true, version }
}
