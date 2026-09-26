import { after, NextResponse, type NextRequest } from 'next/server'
import { canManage, getSession } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { looksLikeFileType, processKnowledgeDocument } from '@/lib/knowledge/process'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  KNOWLEDGE_BUCKET,
  KNOWLEDGE_FILE_TYPES,
  KNOWLEDGE_UPLOADS_PER_HOUR,
  MAX_KNOWLEDGE_FILE_SIZE,
  knowledgeFileType,
  type KnowledgeUploadError,
} from '@/lib/types/knowledge'

// Extraction + embedding run in after(), which shares this route's time budget
export const maxDuration = 300

function fail(error: KnowledgeUploadError, status: number) {
  return NextResponse.json({ ok: false, error }, { status })
}

export async function POST(request: NextRequest, ctx: RouteContext<'/api/knowledge/upload/[clientId]'>) {
  const { clientId } = await ctx.params
  if (!UUID_PATTERN.test(clientId)) return fail('notFound', 404)

  const { supabase, profile } = await getSession()
  if (!profile) return fail('unauthorized', 401)
  if (!canManage(profile)) return fail('forbidden', 403)

  // RLS decides whether this user can see the client at all
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle<{ id: string }>()
  if (!client) return fail('notFound', 404)

  // Reject oversized bodies before buffering them (multipart adds a little overhead)
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_KNOWLEDGE_FILE_SIZE + 64 * 1024) return fail('fileTooLarge', 413)

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
  if (file.size > MAX_KNOWLEDGE_FILE_SIZE) return fail('fileTooLarge', 413)

  const fileType = knowledgeFileType(file.name)
  if (!fileType) return fail('unsupportedType', 415)

  const buffer = Buffer.from(await file.arrayBuffer())
  if (!looksLikeFileType(fileType, buffer)) return fail('unsupportedType', 415)

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
    console.error('[knowledge/upload] insert', insertError)
    await admin.storage.from(KNOWLEDGE_BUCKET).remove([path])
    return fail('uploadFailed', 500)
  }

  after(() =>
    processKnowledgeDocument(admin, { id, client_id: clientId, title, file_type: fileType }, buffer)
  )

  return NextResponse.json({ ok: true, documentId: id }, { status: 202 })
}
