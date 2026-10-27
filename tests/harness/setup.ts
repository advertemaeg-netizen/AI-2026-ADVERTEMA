import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, inject, vi } from 'vitest'
import { harnessFetch, resetHarness, runAfter } from './helpers'

// Next's server installs this before anything of its own loads
// (node-environment-baseline.js). Without it Next falls back to a fake storage
// whose run() throws "AsyncLocalStorage accessed in runtime where it is not
// available", which is what a test importing next/experimental/testing/server
// and then running the pipeline met. The real one, as in production.
;(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage

process.env.NEXT_PUBLIC_SUPABASE_URL = inject('supabaseUrl')
process.env.SUPABASE_SECRET_KEY = inject('supabaseServiceKey')
process.env.GOOGLE_GEMINI_API_KEY = 'test-key'
// Neither provider switch has a default, so the tests name what they fake.
// Replies and analyses are faked in Gemini's wire format (helpers.ts): this
// is NOT production's value (openai). The OpenAI wire format is covered by
// tests/ai/openai-provider.test.ts.
process.env.AI_PROVIDER = 'gemini'
// Embeddings as in production
process.env.AI_EMBEDDING_PROVIDER = 'openai'
process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large'
process.env.OPENAI_API_KEY = 'test-key'

vi.stubGlobal('fetch', harnessFetch)

// after() needs a Next.js request scope; here its work is awaited by flushAfter()
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: runAfter,
}))

afterEach(resetHarness)
