import { after, NextResponse, type NextRequest } from 'next/server'
import { canManage, getSession } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { looksLikeFileType, prepareKnowledgeChunks, processKnowledgeDocument } from '@/lib/knowledge/process'
import { UUID_PATTERN } from '@/lib/types/clients'
import { checkClientLimit, checkKnowledgeQuota, guardLimit, limitErrorFromDb } from '@/lib/subscription-limits'
import {
  KNOWLEDGE_BUCKET,
  KNOWLEDGE_FILE_TYPES,
  KNOWLEDGE_UPLOADS_PER_HOUR,
  MAX_KNOWLEDGE_FILE_SIZE_MB,
  knowledgeFileType,
  type KnowledgeQuota,
  type KnowledgeUploadError,
  type KnowledgeUploadFailure,
} from '@/lib/types/knowledge'

// Embedding runs in after(), which shares this route's time budget
export const maxDuration = 300

const MB = 1024 * 1024

function fail(error: KnowledgeUploadError, status: number, details: Omit<KnowledgeUploadFailure, 'ok' | 'error'> = {}) {
  return NextResponse.json({ ok: false, error, ...details } satisfies KnowledgeUploadFailure, { status })
}

// Text that can't be read is refused before anything is stored
const PREPARE_ERRORS = {
  extractFailed: 'extractFailed',
  empty: 'noText',
  tooLarge: 'textTooLarge',
} as const satisfies Record<string, KnowledgeUploadError>

export async function POST(request: NextRequest, ctx: RouteContext<'/api/knowledge/upload/[clientId]'>) {
  const { clientId } = await ctx.params
  if (!UUID_PATTERN.test(clientId)) return fail('notFound', 404)

  const { supabase, profile, impersonation } = await getSession()
  if (!profile) return fail('unauthorized', 401)
  if (!canManage(profile)) return fail('forbidden', 403)
  if (impersonation) return fail('impersonating', 403)

  // RLS decides whether this user can see the client at all
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle<{ id: string }>()
  if (!client) return fail('notFound', 404)

  // Knowledge files count against the client's own plan
  const blocked = await guardLimit(checkClientLimit(supabase, clientId, 'knowledge_docs'))
  if (blocked === 'unknown') return fail('uploadFailed', 500)
  if (blocked) return fail(blocked, 403)

  // Chunks left (the client's plan, and the agency's for all its clients)
  // and the plan's cap on one file
  let quota: KnowledgeQuota | null
  try {
    quota = await checkKnowledgeQuota(supabase, clientId)
  } catch (error) {
    console.error('[knowledge/upload] quota', error)
    return fail('uploadFailed', 500)
  }
  if (quota && !quota.usable) return fail('subscriptionInactive', 403)
  if (quota?.available === 0) return fail('chunkLimit', 403, { chunks: 0, available: 0 })
  const maxMb = Math.min(quota?.max_file_size_mb ?? MAX_KNOWLEDGE_FILE_SIZE_MB, MAX_KNOWLEDGE_FILE_SIZE_MB)

  // Reject oversized bodies before buffering them (multipart adds a little overhead)
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maxMb * MB + 64 * 1024) return fail('fileTooLarge', 413, { maxMb })

  // Past this point the user is authorized; the secret-key client handles
  // storage and the chunk writes that run after the response
  const admin = createAdminClient()

  // Counted in the database so the limit holds across server instances
  const { count, error: countError } = await admin
    .from('knowledge_documents')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .is('source_document_id', null)
    .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
  if (countError) {
    console.error('[knowledge/upload] rate limit count', countError)
    return fail('uploadFailed', 500)
  }
  if ((count ?? 0) >= KNOWLEDGE_UPLOADS_PER_HOUR) return fail('rateLimited', 429)

  let file: FormDataEntryValue | null
  try {
    file = (await request.formData()).get('file')
  } catch {
    return fail('noFile', 400)
  }
  if (!(file instanceof File)) return fail('noFile', 400)
  if (file.size === 0) return fail('emptyFile', 400)
  if (file.size > maxMb * MB) return fail('fileTooLarge', 413, { maxMb })

  const fileType = knowledgeFileType(file.name)
  if (!fileType) return fail('unsupportedType', 415)

  const buffer = Buffer.from(await file.arrayBuffer())
  if (!looksLikeFileType(fileType, buffer)) return fail('unsupportedType', 415)

  // Chunk now (extraction is quick; embedding is what takes time) so a file
  // that doesn't fit is refused before it's stored or embedded
  const prepared = await prepareKnowledgeChunks(fileType, buffer)
  if (!prepared.ok) return fail(PREPARE_ERRORS[prepared.error], 422)
  const { chunks } = prepared
  if (quota?.available != null && chunks.length > quota.available) {
    return fail('chunkLimit', 403, { chunks: chunks.length, available: quota.available })
  }

  const id = crypto.randomUUID()
  const title = file.name.slice(0, 200)
  // Storage keys must be ASCII-safe, so the original (often Arabic) name
  // lives in `title` and the object is keyed by ids
  const path = `${clientId}/${id}.${fileType}`

  const { error: storageError } = await admin.storage
    .from(KNOWLEDGE_BUCKET)
    .upload(path, buffer, { contentType: KNOWLEDGE_FILE_TYPES[fileType], upsert: false })
  if (storageError) {
    console.error('[knowledge/upload] storage', storageError)
    return fail('uploadFailed', 500)
  }

  const { error: insertError } = await admin.from('knowledge_documents').insert({
    id,
    client_id: clientId,
    title,
    file_url: path,
    file_type: fileType,
    file_size: file.size,
    status: 'processing',
  })
  if (insertError) {
    await admin.storage.from(KNOWLEDGE_BUCKET).remove([path])
    // The subscription limit trigger (a race past the check above)
    const limit = limitErrorFromDb(insertError)
    if (limit) return fail(limit, 403)
    console.error('[knowledge/upload] insert', insertError)
    return fail('uploadFailed', 500)
  }

  after(() => processKnowledgeDocument(admin, { id, client_id: clientId, title, file_type: fileType }, chunks))

  return NextResponse.json({ ok: true, documentId: id }, { status: 202 })
}
