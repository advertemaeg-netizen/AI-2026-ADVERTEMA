import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { seedClient } from '../harness/helpers'
import { warnOnForeignVectors } from '@/lib/ai/bot'
import { EMBEDDING_DIMENSIONS } from '@/lib/ai/provider'

type Supabase = Awaited<ReturnType<typeof seedClient>>['supabase']

/** A unit vector along one axis: two of them on different axes have similarity 0 */
const axis = (index: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0))

/** A ready document with one chunk per vector, stored in embedding_1536 */
async function seedChunks(supabase: Supabase, clientId: string, title: string, vectors: number[][], model = 'text-embedding-3-large') {
  const documentId = randomUUID()
  const document = await supabase.from('knowledge_documents').insert({ id: documentId, client_id: clientId, title, file_type: 'txt', status: 'ready' })
  if (document.error) throw document.error
  const chunks = await supabase.from('knowledge_documents').insert(
    vectors.map((vector, i) => ({
      client_id: clientId,
      source_document_id: documentId,
      title,
      file_type: 'txt',
      status: 'ready',
      chunk_index: i,
      content: `${title} chunk ${i}`,
      embedding_1536: vector,
      embedding_model: model,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
    }))
  )
  if (chunks.error) throw chunks.error
}

const match = async (supabase: Supabase, clientId: string, vector: number[]) => {
  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    client_id: clientId,
    query_embedding: vector,
    match_count: 10,
    match_threshold: 0,
  })
  if (error) throw error
  return data as { title: string; chunk_index: number; similarity: number }[]
}

it("returns only the asked client's chunks, even when another client's chunk is the closest", async () => {
  const mine = await seedClient()
  const other = await seedClient()
  await seedChunks(mine.supabase, mine.clientId, 'mine', [axis(0), axis(1)])
  // Exactly the question's vector: the nearest chunk in the table
  await seedChunks(other.supabase, other.clientId, 'other', [axis(2)])

  const rows = await match(mine.supabase, mine.clientId, axis(2))
  expect(rows.map((row) => row.title)).toEqual(['mine', 'mine'])

  const theirs = await match(other.supabase, other.clientId, axis(2))
  expect(theirs).toEqual([{ id: expect.any(String), source_document_id: expect.any(String), title: 'other', content: 'other chunk 0', chunk_index: 0, similarity: 1, embedding_model: 'text-embedding-3-large' }])
})

it('ranks by the 1536-d vectors, nearest first', async () => {
  const { supabase, clientId } = await seedClient()
  const near = axis(0).map((x, i) => (i === 1 ? 0.2 : x))
  await seedChunks(supabase, clientId, 'doc', [axis(5), near, axis(0)])

  const rows = await match(supabase, clientId, axis(0))
  expect(rows.map((row) => row.chunk_index)).toEqual([2, 1, 0])
  expect(rows[0].similarity).toBeCloseTo(1)
  expect(rows[2].similarity).toBeCloseTo(0)
})

it('warns once when the chunks were embedded by another model than the questions', async () => {
  const { supabase, clientId } = await seedClient()
  await seedChunks(supabase, clientId, 'old', [axis(0), axis(1)], 'text-embedding-3-small')
  const rows = (await match(supabase, clientId, axis(0))) as { embedding_model?: string }[]
  expect(rows.map((row) => row.embedding_model)).toEqual(['text-embedding-3-small', 'text-embedding-3-small'])

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  warnOnForeignVectors(clientId, rows)
  warnOnForeignVectors(clientId, rows)
  // The configured model's own chunks, and chunks with no model on record, say nothing
  warnOnForeignVectors(clientId, [{ embedding_model: 'text-embedding-3-large' }, { embedding_model: null }, {}])
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0][0]).toContain('text-embedding-3-small')
  expect(warn.mock.calls[0][0]).toContain('text-embedding-3-large')
  warn.mockRestore()
})
