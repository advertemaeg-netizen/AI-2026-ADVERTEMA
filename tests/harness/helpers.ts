import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const realFetch = globalThis.fetch
const GEMINI_HOST = 'generativelanguage.googleapis.com'

export type GeminiCall = {
  kind: 'reply' | 'analysis' | 'embedding'
  url: string
  body: Record<string, unknown>
}
type GeminiHandler = (call: GeminiCall) => Response | Promise<Response>

let geminiHandler: GeminiHandler | null = null
/** Every request the code under test sent to the model */
export const geminiCalls: GeminiCall[] = []

export function mockGemini(handler: GeminiHandler) {
  geminiHandler = handler
}

/** A Gemini generateContent response carrying `text` */
export function geminiText(text: string) {
  return Response.json({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
  })
}

export function geminiError(status: number) {
  return Response.json({ error: { code: status, message: 'The model is overloaded.' } }, { status })
}

/**
 * The global fetch during tests: Supabase REST calls go to the local
 * PostgREST (which serves at the root, not /rest/v1), Gemini calls go to the
 * test's mock, and nothing else leaves the machine.
 */
export async function harnessFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)

  if (url.host === GEMINI_HOST) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const generationConfig = body.generationConfig as { responseMimeType?: string } | undefined
    const call: GeminiCall = {
      kind: url.pathname.endsWith(':batchEmbedContents')
        ? 'embedding'
        : generationConfig?.responseMimeType === 'application/json'
          ? 'analysis'
          : 'reply',
      url: url.href,
      body,
    }
    geminiCalls.push(call)
    if (!geminiHandler) throw new Error('Unexpected Gemini call: use mockGemini() in the test')
    return geminiHandler(call)
  }

  if (url.origin === process.env.NEXT_PUBLIC_SUPABASE_URL && url.pathname.startsWith('/rest/v1')) {
    url.pathname = url.pathname.slice('/rest/v1'.length) || '/'
    return realFetch(url, init)
  }

  throw new Error(`Unexpected network call in a test: ${url.href}`)
}

const afterWork: Promise<unknown>[] = []

/** Replaces next/server's after(): starts the work now, flushAfter() awaits it */
export function runAfter(task: Promise<unknown> | (() => unknown)) {
  afterWork.push(Promise.resolve(typeof task === 'function' ? task() : task))
}

/** Waits for everything the handler scheduled with after() */
export async function flushAfter() {
  while (afterWork.length > 0) await Promise.all(afterWork.splice(0))
}

export function resetHarness() {
  geminiHandler = null
  geminiCalls.length = 0
  afterWork.length = 0
}

/** Secret-key client, like createAdminClient() */
export function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function must<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error || data === null) throw new Error(`Seeding failed: ${error?.message ?? 'no row returned'}`)
  return data
}

/**
 * A fresh organization with one client and a live website channel. Both get
 * their default trial subscriptions from the database triggers.
 */
export async function seedClient() {
  const supabase = serviceClient()
  const tag = randomUUID().slice(0, 8)

  const org = must(
    await supabase.from('organizations').insert({ name: `Org ${tag}`, slug: `org-${tag}` }).select('id').single<{ id: string }>()
  )
  const client = must(
    await supabase
      .from('clients')
      .insert({ organization_id: org.id, name: `Client ${tag}`, slug: `client-${tag}` })
      .select('id')
      .single<{ id: string }>()
  )
  const channel = must(
    await supabase
      .from('channels')
      .insert({ client_id: client.id, type: 'website', name: 'Website' })
      .select('id')
      .single<{ id: string }>()
  )

  return { supabase, organizationId: org.id, clientId: client.id, channelId: channel.id }
}
