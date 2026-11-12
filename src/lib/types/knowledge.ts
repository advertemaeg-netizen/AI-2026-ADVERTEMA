export const KNOWLEDGE_BUCKET = 'knowledge-base'
/** The platform's cap on one file; each plan sets its own (plans.max_file_size_mb) up to this */
export const MAX_KNOWLEDGE_FILE_SIZE_MB = 20
export const MAX_KNOWLEDGE_FILE_SIZE = MAX_KNOWLEDGE_FILE_SIZE_MB * 1024 * 1024
export const KNOWLEDGE_UPLOADS_PER_HOUR = 20

export const KNOWLEDGE_FILE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
} as const
export type KnowledgeFileType = keyof typeof KNOWLEDGE_FILE_TYPES

export const KNOWLEDGE_ACCEPT = '.pdf,.docx,.txt'

/**
 * Whether a browser tab can show the original file as it is: PDF only. Word
 * does not render in a browser. Plain text is download-only on purpose:
 *
 * BEFORE MAKING PLAIN TEXT VIEWABLE, fix its stored content type. Uploads
 * store it as bare `text/plain` (KNOWLEDGE_FILE_TYPES, used by
 * app/api/knowledge/upload), with no charset, so a browser tab may decode
 * its Arabic wrongly, and that gibberish reads exactly like a bad
 * extraction. The fix is two parts, both needed:
 *   1. a migration adding 'text/plain;charset=utf-8' to the knowledge-base
 *      bucket's allowed_mime_types (20260928100000 allows exactly
 *      'text/plain'; Supabase storage only ignores the charset parameter
 *      from #1382, 15 September 2026, and the hosted version is unknown);
 *   2. then uploading text with contentType 'text/plain; charset=utf-8'.
 * Files already stored keep the old type: they stay download-only, or are
 * re-uploaded. Decided 2026-11-10 (download-only, the fix held).
 */
export function opensInTab(fileType: string | null | undefined) {
  return fileType === 'pdf'
}

/**
 * A file's size as the list shows it: whole KB under 1 MB (never "0": a
 * 40 KB text file read "0 MB"), MB to one decimal from there. The units stay
 * Latin in both languages, as they were.
 */
export function fileSize(bytes: number): { value: number; unit: 'KB' | 'MB'; fractionDigits: number } {
  const MB = 1024 * 1024
  if (bytes < MB) return { value: bytes <= 0 ? 0 : Math.min(1023, Math.max(1, Math.round(bytes / 1024))), unit: 'KB', fractionDigits: 0 }
  return { value: bytes / MB, unit: 'MB', fractionDigits: 1 }
}

export function knowledgeFileType(fileName: string): KnowledgeFileType | null {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext && ext in KNOWLEDGE_FILE_TYPES ? (ext as KnowledgeFileType) : null
}

export type KnowledgeStatus = 'processing' | 'ready' | 'failed'

/** Why processing failed; stored in knowledge_documents.error_message */
export type KnowledgeProcessingError =
  | 'empty'
  | 'tooLarge'
  | 'extractFailed'
  | 'embeddingFailed'
  | 'saveFailed'
  /** The plan's chunk limit was reached while the file was processed */
  | 'chunkLimit'

/** A source document row (source_document_id is null) */
export type KnowledgeDocument = {
  id: string
  client_id: string
  title: string
  file_type: KnowledgeFileType | null
  file_size: number | null
  status: KnowledgeStatus
  chunk_count: number | null
  error_message: KnowledgeProcessingError | null
  created_at: string
}

/** Error codes returned by the upload route */
export type KnowledgeUploadError =
  | 'impersonating'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'noFile'
  | 'emptyFile'
  | 'fileTooLarge'
  | 'unsupportedType'
  | 'uploadFailed'
  | 'limitReached'
  | 'subscriptionInactive'
  /** The file's chunks don't fit what's left of the plan (with chunks / available) */
  | 'chunkLimit'
  | 'extractFailed'
  | 'noText'
  | 'textTooLarge'

/** Error body of the upload route; the numbers go into the message */
export type KnowledgeUploadFailure = {
  ok: false
  error: KnowledgeUploadError
  /** chunkLimit: chunks in this file, chunks still available */
  chunks?: number
  available?: number
  /** fileTooLarge: the plan's cap */
  maxMb?: number
}

/**
 * Room left in one client's knowledge base (check_knowledge_quota). The
 * client's plan limits its chunks; an agency plan also limits all of the
 * agency's clients together. null limits = unlimited.
 */
export type KnowledgeQuota = {
  used: number
  limit: number | null
  org_used: number | null
  org_limit: number | null
  /** The tighter of the two; null = unlimited */
  available: number | null
  /** The plan's cap on one file (the smaller of the two plans'); null = the platform's */
  max_file_size_mb: number | null
  usable: boolean
}

export type KnowledgeActionResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'forbidden' | 'notFound' | 'impersonating' | 'unknown' }
