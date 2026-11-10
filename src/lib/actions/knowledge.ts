'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { UUID_PATTERN } from '@/lib/types/clients'
import { checkKnowledgeQuota } from '@/lib/subscription-limits'
import {
  KNOWLEDGE_BUCKET,
  opensInTab,
  type KnowledgeActionResult,
  type KnowledgeDocument,
  type KnowledgeQuota,
} from '@/lib/types/knowledge'

const KNOWLEDGE_PATH = '/[locale]/dashboard/clients/[clientId]/knowledge'
/** How long a download link works: long enough for a slow, interrupted download to resume */
const DOWNLOAD_LINK_SECONDS = 15 * 60

export async function getKnowledgeDocuments(clientId: string): Promise<KnowledgeDocument[]> {
  if (!UUID_PATTERN.test(clientId)) return []
  const { supabase, profile } = await getSession()
  // The knowledge base is managed by client admins and up (RLS agrees)
  if (!profile || !canManage(profile)) return []

  // Source documents only — chunk rows (with embeddings) stay server-side
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('id, client_id, title, file_type, file_size, status, chunk_count, error_message, created_at')
    .eq('client_id', clientId)
    .is('source_document_id', null)
    .order('created_at', { ascending: false })
    .returns<KnowledgeDocument[]>()

  if (error) throw new Error(`Failed to load knowledge documents: ${error.message}`)
  return data
}

/** Chunks used and left for this client, and its plan's file size cap (null: not visible, or failed). */
export async function getKnowledgeQuota(clientId: string): Promise<KnowledgeQuota | null> {
  if (!UUID_PATTERN.test(clientId)) return null
  const { supabase, profile } = await getSession()
  if (!profile || !canManage(profile)) return null
  try {
    return await checkKnowledgeQuota(supabase, clientId)
  } catch (error) {
    console.error('[knowledge] quota', error)
    return null
  }
}

export async function deleteKnowledgeDocument(documentId: string): Promise<KnowledgeActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(documentId)) return { ok: false, error: 'notFound' }

  // Chunks go with it (on delete cascade). RLS limits this to admins of the client.
  const { data, error } = await supabase
    .from('knowledge_documents')
    .delete()
    .eq('id', documentId)
    .is('source_document_id', null)
    .select('file_url')

  if (error) {
    console.error('[knowledge] delete', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  const path = (data[0] as { file_url: string | null }).file_url
  if (path) {
    // Storage RLS allows this for admins of the client in the path
    const { error: storageError } = await supabase.storage.from(KNOWLEDGE_BUCKET).remove([path])
    if (storageError) console.error('[knowledge] storage remove', storageError)
  }

  revalidatePath(KNOWLEDGE_PATH, 'page')
  return { ok: true }
}

/**
 * A link to a document's original file, as uploaded: to download it, or to
 * open it in a browser tab (the knowledge page's two buttons). Only a PDF
 * opens in a tab: a browser cannot render Word, and a plain-text file is
 * stored without a charset, so a tab may show its Arabic as gibberish, which
 * would read as a bad extraction. Both download only. The link is created with the user's
 * own session: the storage policy "Admins read knowledge files of their
 * clients" (20261003100000) decides, and RLS on the row before it. Valid for
 * fifteen minutes, not one: the expiry is checked on each request, and a
 * phone on 3G that drops mid-download resumes with a new request, which a
 * one-minute link would refuse. The file downloads under its uploaded name.
 */
export async function getKnowledgeFileUrl(
  documentId: string,
  mode: 'download' | 'view' = 'download'
): Promise<{ ok: true; url: string } | { ok: false; error: 'unauthorized' | 'forbidden' | 'notFound' | 'unknown' }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(documentId)) return { ok: false, error: 'notFound' }

  const { data: doc, error } = await supabase
    .from('knowledge_documents')
    .select('title, file_url, file_type')
    .eq('id', documentId)
    .is('source_document_id', null)
    .maybeSingle<{ title: string; file_url: string | null; file_type: string | null }>()
  if (error) {
    console.error('[knowledge] download lookup', error)
    return { ok: false, error: 'unknown' }
  }
  if (!doc?.file_url) return { ok: false, error: 'notFound' }
  if (mode === 'view' && !opensInTab(doc.file_type)) return { ok: false, error: 'notFound' }

  const { data, error: signError } = await supabase.storage
    .from(KNOWLEDGE_BUCKET)
    // Viewing: no download disposition, so the browser renders the PDF inline
    .createSignedUrl(doc.file_url, DOWNLOAD_LINK_SECONDS, mode === 'download' ? { download: doc.title } : undefined)
  if (signError || !data?.signedUrl) {
    console.error('[knowledge] download link', signError)
    return { ok: false, error: 'unknown' }
  }
  return { ok: true, url: data.signedUrl }
}
