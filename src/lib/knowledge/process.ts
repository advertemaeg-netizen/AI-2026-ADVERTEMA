import 'server-only'
import { embedTexts } from '@/lib/ai/gemini'
import type { createAdminClient } from '@/lib/supabase/admin'
import type { KnowledgeFileType, KnowledgeProcessingError } from '@/lib/types/knowledge'

const CHUNK_TOKENS = 500
const OVERLAP_TOKENS = 50
// ~500k tokens of text; keeps a single upload's embedding cost bounded
const MAX_CHUNKS = 1000
const INSERT_BATCH = 100

class ProcessingError extends Error {
  constructor(public code: KnowledgeProcessingError, cause?: unknown) {
    super(code, { cause })
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Cheap magic-byte check so a renamed file can't masquerade as another type. */
export function looksLikeFileType(type: KnowledgeFileType, bytes: Uint8Array) {
  if (type === 'pdf') return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 // %PDF
  if (type === 'docx') return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04 // PK zip
  return !bytes.subarray(0, 8192).includes(0) // text files have no NUL bytes
}

export async function extractText(type: KnowledgeFileType, buffer: Buffer): Promise<string> {
  if (type === 'txt') return new TextDecoder('utf-8').decode(buffer)

  if (type === 'pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return result.text
    } finally {
      await parser.destroy()
    }
  }

  // DOCX is a zip of XML parts; mammoth unzips it and reads word/document.xml
  const mammoth = await import('mammoth')
  const { value } = await mammoth.extractRawText({ buffer })
  return value
}

function normalize(text: string) {
  return text
    .replace(/^﻿/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Token estimate without a tokenizer: ~4 chars/token for Latin text, and
 * Arabic is denser (~2.5 chars/token), so count the two separately.
 */
export function estimateTokens(text: string) {
  const arabic = text.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g)?.length ?? 0
  return Math.ceil(arabic / 2.5 + (text.length - arabic) / 4)
}

type Unit = { text: string; tokens: number; newParagraph: boolean }

function splitByWords(text: string, maxTokens: number): string[] {
  const pieces: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word
    if (current && estimateTokens(next) > maxTokens) {
      pieces.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) pieces.push(current)
  return pieces
}

/** Paragraphs when they fit, else sentences, else (for run-on text) words. */
function toUnits(text: string): Unit[] {
  const units: Unit[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue

    const pieces =
      estimateTokens(trimmed) <= CHUNK_TOKENS
        ? [trimmed]
        : trimmed
            .split(/(?<=[.!?؟…。])\s+|\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .flatMap((s) => (estimateTokens(s) > CHUNK_TOKENS ? splitByWords(s, CHUNK_TOKENS) : [s]))

    pieces.forEach((piece, i) =>
      units.push({ text: piece, tokens: estimateTokens(piece), newParagraph: i === 0 })
    )
  }
  return units
}

function joinUnits(units: Unit[]) {
  return units
    .map((u, i) => (i === 0 ? u.text : `${u.newParagraph ? '\n\n' : ' '}${u.text}`))
    .join('')
}

/**
 * ~500-token chunks that break on paragraph/sentence boundaries, each
 * starting with up to ~50 tokens of whole sentences from the previous chunk.
 */
export function chunkText(text: string): string[] {
  const chunks: string[] = []
  let current: Unit[] = []
  let currentTokens = 0
  let hasNewContent = false

  for (const unit of toUnits(text)) {
    if (current.length > 0 && currentTokens + unit.tokens > CHUNK_TOKENS) {
      if (hasNewContent) chunks.push(joinUnits(current))

      // Carry trailing whole sentences as overlap
      const overlap: Unit[] = []
      let overlapTokens = 0
      for (let i = current.length - 1; i >= 0; i--) {
        if (overlapTokens + current[i].tokens > OVERLAP_TOKENS) break
        overlap.unshift(current[i])
        overlapTokens += current[i].tokens
      }
      // Drop the overlap if it would push this unit past the limit
      current = overlapTokens + unit.tokens <= CHUNK_TOKENS ? overlap : []
      currentTokens = current === overlap ? overlapTokens : 0
      hasNewContent = false
    }

    current.push(unit)
    currentTokens += unit.tokens
    hasNewContent = true
  }

  if (current.length > 0 && hasNewContent) chunks.push(joinUnits(current))
  return chunks
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Extracts, chunks and embeds an uploaded document, storing chunks as child
 * rows of the document. Marks the document ready or failed; never throws.
 */
export async function processKnowledgeDocument(
  admin: AdminClient,
  doc: { id: string; client_id: string; title: string; file_type: KnowledgeFileType },
  buffer: Buffer
) {
  try {
    let text: string
    try {
      text = normalize(await extractText(doc.file_type, buffer))
    } catch (error) {
      throw new ProcessingError('extractFailed', error)
    }

    // e.g. a scanned PDF with no text layer
    if (!text) throw new ProcessingError('empty')

    const chunks = chunkText(text)
    if (chunks.length === 0) throw new ProcessingError('empty')
    if (chunks.length > MAX_CHUNKS) throw new ProcessingError('tooLarge')

    let embeddings: number[][]
    try {
      embeddings = await embedTexts(chunks, 'RETRIEVAL_DOCUMENT')
    } catch (error) {
      throw new ProcessingError('embeddingFailed', error)
    }

    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const rows = chunks.slice(i, i + INSERT_BATCH).map((content, j) => ({
        client_id: doc.client_id,
        source_document_id: doc.id,
        title: doc.title,
        file_type: doc.file_type,
        status: 'ready',
        chunk_index: i + j,
        content,
        embedding: embeddings[i + j],
      }))
      const { error } = await admin.from('knowledge_documents').insert(rows)
      if (error) throw error
    }

    const { error } = await admin
      .from('knowledge_documents')
      .update({ status: 'ready', chunk_count: chunks.length, error_message: null })
      .eq('id', doc.id)
    if (error) throw error
  } catch (error) {
    const code = error instanceof ProcessingError ? error.code : 'saveFailed'
    console.error(`[knowledge] processing ${doc.id} failed (${code})`, error)

    // Don't leave half a document searchable
    await admin.from('knowledge_documents').delete().eq('source_document_id', doc.id)
    await admin
      .from('knowledge_documents')
      .update({ status: 'failed', error_message: code, chunk_count: 0 })
      .eq('id', doc.id)
  }
}
