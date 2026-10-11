/**
 * Re-embeds every existing knowledge-base chunk with whatever
 * AI_EMBEDDING_PROVIDER this script is run with — not the one
 * deploy/.env.production points at on the server. Meant to run once,
 * locally, against the production database, before AI_EMBEDDING_PROVIDER is
 * changed on the server: the stored chunks must already be the new
 * provider's vectors before the live site starts embedding visitor
 * questions through that provider (vectors from two models aren't
 * comparable — see src/lib/ai/provider.ts).
 *
 * Only ever touches the `embedding` column: same ids, same chunk_index, same
 * content. Nothing is re-extracted or re-chunked, so this can't change what
 * a chunk says — only which vector represents it. Before any write, every
 * current (id, embedding) is dumped to a JSON file in case the new vectors
 * need to be rolled back without re-calling the old provider.
 *
 *   OPENAI_API_KEY=sk-... AI_EMBEDDING_PROVIDER=openai npm run reembed:knowledge
 *                                         -- preview only: lists what would change, writes nothing
 *   ... npm run reembed:knowledge -- --execute
 *                                         -- re-embeds every client's chunks
 *   ... npm run reembed:knowledge -- --execute --client=<uuid>
 *                                         -- one client at a time
 *
 * Unlike reset-demo.ts, preview is the default here and --execute opts in:
 * this touches every client's live knowledge base, not just the demo's.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { EMBEDDING_DIMENSIONS, embedTexts } from '@/lib/ai/provider'
import { createAdminClient } from '@/lib/supabase/admin'

type Chunk = {
  id: string
  client_id: string
  title: string
  chunk_index: number | null
  content: string
  embedding: unknown
}

async function main() {
  const execute = process.argv.includes('--execute')
  const onlyClient = process.argv.find((a) => a.startsWith('--client='))?.slice('--client='.length)

  const admin = createAdminClient()
  console.log(`database: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`)
  console.log(`embedding provider for this run: ${process.env.AI_EMBEDDING_PROVIDER || 'gemini (default — set AI_EMBEDDING_PROVIDER=openai to re-embed with OpenAI)'}`)

  let query = admin
    .from('knowledge_documents')
    .select('id, client_id, title, chunk_index, content, embedding')
    .not('source_document_id', 'is', null)
    .not('embedding', 'is', null)
    .order('client_id')
    .order('chunk_index')
  if (onlyClient) query = query.eq('client_id', onlyClient)

  const { data, error } = await query
  if (error) throw new Error(`loading chunks: ${error.message}`)
  const chunks = (data ?? []) as Chunk[]
  if (chunks.length === 0) {
    console.log('no matching chunks found — nothing to do')
    return
  }

  const byClient = new Map<string, Chunk[]>()
  for (const chunk of chunks) byClient.set(chunk.client_id, [...(byClient.get(chunk.client_id) ?? []), chunk])

  console.log(`\n${chunks.length} chunk(s) across ${byClient.size} client(s):`)
  for (const [clientId, rows] of byClient) {
    console.log(`  ${clientId}: ${rows.length} chunk(s) — ${[...new Set(rows.map((r) => r.title))].join(', ')}`)
  }

  if (!execute) {
    console.log('\nPreview only — nothing written. Re-run with --execute to re-embed for real.')
    return
  }

  const backupPath = path.join(process.cwd(), `knowledge-embeddings-backup-${Date.now()}.json`)
  writeFileSync(backupPath, JSON.stringify(chunks.map((c) => ({ id: c.id, client_id: c.client_id, embedding: c.embedding })), null, 2))
  console.log(`\nbacked up ${chunks.length} existing vector(s) to ${backupPath}`)

  for (const [clientId, rows] of byClient) {
    console.log(`\nclient ${clientId}: embedding ${rows.length} chunk(s)...`)
    const vectors = await embedTexts(rows.map((r) => r.content), 'document', { operation: 'embedding', clientId })
    if (vectors.length !== rows.length) throw new Error(`got ${vectors.length} vectors for ${rows.length} chunks`)

    for (let i = 0; i < rows.length; i++) {
      if (vectors[i].length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`chunk ${rows[i].id}: provider returned a ${vectors[i].length}-d vector, expected ${EMBEDDING_DIMENSIONS}`)
      }
      const { error: updateError } = await admin.from('knowledge_documents').update({ embedding: vectors[i] }).eq('id', rows[i].id)
      if (updateError) throw new Error(`updating chunk ${rows[i].id}: ${updateError.message}`)
    }
    console.log(`  done`)
  }

  console.log(`\nre-embedded ${chunks.length} chunk(s). Backup of the old vectors: ${backupPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
