/**
 * Embeds every existing knowledge-base chunk with text-embedding-3-large at
 * 1536 dimensions into knowledge_documents.embedding_1536 — the column added
 * next to the 768-d `embedding` by the 20261024100000 migration. Meant to run
 * locally against the production database, before retrieval is pointed at
 * the new column: the stored chunks must already carry the new model's
 * vectors before visitor questions are embedded with it (vectors from two
 * models aren't comparable — see src/lib/ai/provider.ts).
 *
 * Only ever writes `embedding_1536`: same ids, same chunk_index, same
 * content, and the 768-d `embedding` is left as it is. Nothing is
 * re-extracted or re-chunked, so this can't change what a chunk says. Before
 * any write, every current (id, embedding, embedding_1536) is dumped to a
 * JSON file in $HOME/db-backups — outside the repository, it is client data.
 *
 *   npm run reembed:knowledge              -- preview only: lists what would change, writes nothing
 *   npm run reembed:knowledge -- --execute -- embeds every client's chunks
 *   npm run reembed:knowledge -- --execute --client=<uuid>
 *                                          -- one client at a time
 *
 * Keys come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
 * OPENAI_API_KEY). Unlike reset-demo.ts, preview is the default here and
 * --execute opts in: this touches every client's live knowledge base, not
 * just the demo's.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { openaiProvider } from '@/lib/ai/providers/openai'
import { recordAiUsage } from '@/lib/ai/usage'
import { createAdminClient } from '@/lib/supabase/admin'

try {
  process.loadEnvFile(path.join(process.cwd(), '.env.local'))
} catch {
  // already in the environment (CI, a shell that exported them)
}

const MODEL = 'text-embedding-3-large'
const DIMENSIONS = 1536
const COLUMN = 'embedding_1536'
const EMBED_TIMEOUT_MS = 60_000

type Chunk = {
  id: string
  client_id: string
  title: string
  chunk_index: number | null
  content: string
  embedding: unknown
  embedding_1536: unknown
}

const toVector = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as number[]
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0)
const cosine = (a: number[], b: number[]) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b))

async function main() {
  const execute = process.argv.includes('--execute')
  const onlyClient = process.argv.find((a) => a.startsWith('--client='))?.slice('--client='.length)

  const admin = createAdminClient()
  console.log(`database: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`)
  console.log(`embedding: ${MODEL} at ${DIMENSIONS} dimensions → knowledge_documents.${COLUMN}`)

  // Without a price the calls would be logged at no cost (see recordAiUsage)
  const { data: price, error: priceError } = await admin.from('model_pricing').select('input_price_per_million').eq('model', MODEL).maybeSingle()
  if (priceError) throw new Error(`loading the price of ${MODEL}: ${priceError.message}`)
  console.log(`price: ${price ? `$${price.input_price_per_million} per 1M tokens` : 'NONE — apply the 20261023100000 migration first'}`)

  let query = admin
    .from('knowledge_documents')
    .select(`id, client_id, title, chunk_index, content, embedding, ${COLUMN}`)
    .not('source_document_id', 'is', null)
    .order('client_id')
    .order('title')
    .order('chunk_index')
  if (onlyClient) query = query.eq('client_id', onlyClient)

  const { data, error } = await query
  if (error) {
    throw new Error(
      error.code === '42703'
        ? `knowledge_documents.${COLUMN} does not exist — apply the 20261024100000 migration first`
        : `loading chunks: ${error.message}`
    )
  }
  const chunks = (data ?? []) as unknown as Chunk[]
  if (chunks.length === 0) {
    console.log('no matching chunks found — nothing to do')
    return
  }

  const byClient = new Map<string, Chunk[]>()
  for (const chunk of chunks) byClient.set(chunk.client_id, [...(byClient.get(chunk.client_id) ?? []), chunk])

  console.log(`\n${chunks.length} chunk(s) across ${byClient.size} client(s):`)
  for (const [clientId, rows] of byClient) {
    const filled = rows.filter((r) => r[COLUMN] !== null).length
    console.log(`  ${clientId}: ${rows.length} chunk(s), ${filled} already with a ${DIMENSIONS}-d vector — ${[...new Set(rows.map((r) => r.title))].join(', ')}`)
  }

  if (!execute) {
    console.log('\nPreview only — nothing written. Re-run with --execute to embed for real.')
    return
  }
  if (!price) throw new Error(`${MODEL} has no price in model_pricing: refusing to make unpriced calls`)

  const backupDir = path.join(homedir(), 'db-backups')
  mkdirSync(backupDir, { recursive: true })
  const backupPath = path.join(backupDir, `knowledge-embeddings-backup-${Date.now()}.json`)
  writeFileSync(
    backupPath,
    JSON.stringify(chunks.map((c) => ({ id: c.id, client_id: c.client_id, embedding: c.embedding, [COLUMN]: c[COLUMN] })), null, 2)
  )
  console.log(`\nbacked up ${chunks.length} chunk(s)' current vectors to ${backupPath}`)

  for (const [clientId, rows] of byClient) {
    console.log(`\nclient ${clientId}: embedding ${rows.length} chunk(s)...`)

    // Each vector is filed under its chunk's id as soon as it comes back;
    // from here on nothing is paired by position
    const vectorById = new Map<string, number[]>()
    let embeddedTokens = 0
    try {
      for (let i = 0; i < rows.length; i += openaiProvider.embedBatchSize) {
        const batch = rows.slice(i, i + openaiProvider.embedBatchSize)
        const result = await openaiProvider.embed({
          model: MODEL,
          texts: batch.map((r) => r.content),
          purpose: 'document',
          dimensions: DIMENSIONS,
          timeoutMs: EMBED_TIMEOUT_MS,
        })
        embeddedTokens += result.tokens.promptTokens
        if (result.vectors.length !== batch.length) throw new Error(`got ${result.vectors.length} vectors for ${batch.length} chunks`)
        batch.forEach((row, j) => {
          if (result.vectors[j].length !== DIMENSIONS) {
            throw new Error(`chunk ${row.id}: provider returned a ${result.vectors[j].length}-d vector, expected ${DIMENSIONS}`)
          }
          vectorById.set(row.id, result.vectors[j])
        })
      }
    } finally {
      // Batches already embedded are billed even if a later one fails
      if (embeddedTokens > 0) {
        await recordAiUsage({ operation: 'embedding', clientId }, MODEL, { promptTokens: embeddedTokens, completionTokens: 0, totalTokens: embeddedTokens })
      }
    }

    for (const [id, vector] of vectorById) {
      // Scoped to the client as well as the id, and read back: an update that
      // matches no row is not an error to PostgREST
      const { data: updated, error: updateError } = await admin
        .from('knowledge_documents')
        .update({ [COLUMN]: vector })
        .eq('id', id)
        .eq('client_id', clientId)
        .select('id')
      if (updateError) throw new Error(`updating chunk ${id}: ${updateError.message}`)
      if (updated?.length !== 1) throw new Error(`updating chunk ${id}: ${updated?.length ?? 0} rows updated, expected 1`)
    }

    // What is now stored under each id is the vector made from that id's text
    const { data: stored, error: storedError } = await admin
      .from('knowledge_documents')
      .select(`id, ${COLUMN}`)
      .eq('client_id', clientId)
      .in('id', [...vectorById.keys()])
    if (storedError) throw new Error(`reading back client ${clientId}: ${storedError.message}`)
    const readBack = (stored ?? []) as unknown as { id: string; embedding_1536: unknown }[]
    if (readBack.length !== vectorById.size) throw new Error(`read back ${readBack.length} chunk(s), wrote ${vectorById.size}`)
    for (const row of readBack) {
      const similarity = cosine(toVector(row[COLUMN]), vectorById.get(row.id)!)
      if (!(similarity > 0.9999)) throw new Error(`chunk ${row.id}: the stored vector is not the one written (cosine ${similarity})`)
    }
    console.log(`  done: ${vectorById.size} written and read back, ${embeddedTokens} tokens`)
  }

  console.log(`\nembedded ${chunks.length} chunk(s). Backup of the previous vectors: ${backupPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
