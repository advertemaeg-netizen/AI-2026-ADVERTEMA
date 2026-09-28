'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { UUID_PATTERN } from '@/lib/types/clients'
import { checkKnowledgeQuota } from '@/lib/subscription-limits'
import {
  KNOWLEDGE_BUCKET,
  type KnowledgeActionResult,
  type KnowledgeDocument,
  type KnowledgeQuota,
} from '@/lib/types/knowledge'

const KNOWLEDGE_PATH = '/[locale]/dashboard/clients/[clientId]/knowledge'

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
