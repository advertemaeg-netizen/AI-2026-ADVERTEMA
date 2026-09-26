export const KNOWLEDGE_BUCKET = 'knowledge-base'
export const MAX_KNOWLEDGE_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
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
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'noFile'
  | 'emptyFile'
  | 'fileTooLarge'
  | 'unsupportedType'
  | 'uploadFailed'

export type KnowledgeActionResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'forbidden' | 'notFound' | 'unknown' }
