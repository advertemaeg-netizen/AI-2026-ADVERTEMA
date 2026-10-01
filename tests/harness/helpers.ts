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
type RestInterceptor = {
  method: string | null
  path: string
  remaining: number
  respond: (passThrough: () => Promise<Response>) => Response | Promise<Response>
}
let restInterceptors: RestInterceptor[] = []

/**
 * Answers the next `times` Supabase REST calls whose path contains `path`
 * (and whose method matches, if given) with `respond` instead of the
 * database's own answer. `passThrough` runs the real call.
 */
export function interceptRest(
  match: { path: string; method?: string; times?: number },
  respond: RestInterceptor['respond']
) {
  restInterceptors.push({ method: match.method ?? null, path: match.path, remaining: match.times ?? 1, respond })
}

/** Makes the next `times` matching Supabase REST calls fail with a 500 */
export function failRest(path: string, times = 1) {
  interceptRest({ path, times }, () =>
    Response.json({ code: 'XX000', message: 'simulated database failure' }, { status: 500 })
  )
}

/** PostgREST's answer to an insert that hits a unique index */
export function uniqueViolation(index: string) {
  return Response.json(
    { code: '23505', details: null, hint: null, message: `duplicate key value violates unique constraint "${index}"` },
    { status: 409 }
  )
}

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
    // Both calls may ask for JSON: the analysis is told apart by its instructions
    const instructions = (body.systemInstruction as { parts?: { text?: string }[] } | undefined)?.parts?.[0]?.text ?? ''
    const call: GeminiCall = {
      kind: url.pathname.endsWith(':batchEmbedContents')
        ? 'embedding'
        : instructions.startsWith('You analyze chat conversations')
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
    const restPath = url.pathname.slice('/rest/v1'.length) || '/'
    const method = (init?.method ?? 'GET').toUpperCase()
    url.pathname = restPath
    const interceptor = restInterceptors.find(
      (i) => i.remaining > 0 && restPath.includes(i.path) && (i.method === null || i.method === method)
    )
    if (interceptor) {
      interceptor.remaining -= 1
      return interceptor.respond(() => realFetch(url, init))
    }
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
  restInterceptors = []
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
