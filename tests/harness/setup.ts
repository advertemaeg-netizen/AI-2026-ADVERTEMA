import { afterEach, inject, vi } from 'vitest'
import { harnessFetch, resetHarness, runAfter } from './helpers'

process.env.NEXT_PUBLIC_SUPABASE_URL = inject('supabaseUrl')
process.env.SUPABASE_SECRET_KEY = inject('supabaseServiceKey')
process.env.GOOGLE_GEMINI_API_KEY = 'test-key'

vi.stubGlobal('fetch', harnessFetch)

// after() needs a Next.js request scope; here its work is awaited by flushAfter()
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: runAfter,
}))

afterEach(resetHarness)
