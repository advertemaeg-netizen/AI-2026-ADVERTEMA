export const KNOWLEDGE_BUCKET = 'knowledge-base'
/** The platform's cap on one file; each plan sets its own (plans.max_file_size_mb) up to this */
export const MAX_KNOWLEDGE_FILE_SIZE_MB = 20
export const MAX_KNOWLEDGE_FILE_SIZE = MAX_KNOWLEDGE_FILE_SIZE_MB * 1024 * 1024
export const KNOWLEDGE_UPLOADS_PER_HOUR = 5

export const KNOWLEDGE_FILE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
} as const
export type KnowledgeFileType = keyof typeof KNOWLEDGE_FILE_TYPES

export const KNOWLEDGE_ACCEPT = '.pdf,.docx,.txt'

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
