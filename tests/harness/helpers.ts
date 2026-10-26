import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { signJwt } from './jwt'

const realFetch = globalThis.fetch
const GEMINI_HOST = 'generativelanguage.googleapis.com'
const GRAPH_HOST = 'graph.facebook.com'
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'

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

/** Every Supabase REST call the code under test made: "POST /rpc/…" */
export const restCalls: string[] = []

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

/** A call to Meta's Graph API (the WhatsApp send), as the code under test made it */
export type GraphCall = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }
type GraphHandler = (call: GraphCall) => Response | Promise<Response>
let graphHandler: GraphHandler | null = null
export const graphCalls: GraphCall[] = []

/** Answers Graph API calls; the handler may throw to stand for a failed request */
export function mockGraph(handler: GraphHandler) {
  graphHandler = handler
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

  if (url.host === GRAPH_HOST) {
    const call: GraphCall = {
      url: url.href,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    }
    graphCalls.push(call)
    if (!graphHandler) throw new Error('Unexpected Graph API call: use mockGraph() in the test')
    return graphHandler(call)
  }

  // Embeddings go to OpenAI, as in production; the same mock answers them
  if (url.href === OPENAI_EMBEDDINGS_URL) {
    const call: GeminiCall = { kind: 'embedding', url: url.href, body: JSON.parse(String(init?.body ?? '{}')) }
    geminiCalls.push(call)
    if (!geminiHandler) throw new Error('Unexpected embedding call: use mockGemini() in the test')
    return geminiHandler(call)
  }

  if (url.origin === process.env.NEXT_PUBLIC_SUPABASE_URL && url.pathname.startsWith('/rest/v1')) {
    const restPath = url.pathname.slice('/rest/v1'.length) || '/'
    const method = (init?.method ?? 'GET').toUpperCase()
    url.pathname = restPath
    restCalls.push(`${method} ${restPath}`)
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
  graphHandler = null
  graphCalls.length = 0
  restInterceptors = []
  restCalls.length = 0
  geminiCalls.length = 0
  afterWork.length = 0
}

/** Secret-key client, like createAdminClient() */
export function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** A signed-in user's client: their JWT, so RLS and auth.uid() apply as in production */
export function userClient(userId: string) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, signJwt({ sub: userId, role: 'authenticated', iss: 'supabase' }), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export type TestUser = { id: string; role: string; organization_id: string | null }

/** A user with a profile in `organizationId`, as sign-up plus an admin's role assignment would leave it */
export async function createUser(
  role: 'org_admin' | 'client_admin' | 'team_member' | 'super_admin',
  organizationId: string | null,
  fullName: string
): Promise<TestUser> {
  const supabase = serviceClient()
  const email = `${randomUUID().slice(0, 12)}@example.com`
  const id = await seed<string>(() => supabase.rpc('test_create_auth_user', { p_email: email }))
  const profile = { id, email, full_name: fullName, role, organization_id: organizationId }
  // The sign-up trigger may or may not have made the profile row
  await seed(() => supabase.from('users').upsert(profile).select('id').single())
  return { id, role, organization_id: organizationId }
}

type SeedResult<T> = { data: T | null; error: { message: string; code?: string } | null }

function must<T>({ data, error }: SeedResult<T>): T {
  if (error || data === null) throw new Error(`Seeding failed: ${error?.message ?? 'no row returned'}`)
  return data
}

// PostgREST's connection group (PGRST000–PGRST003): it never reached, or lost, the database
const CONNECTION_ERROR = /^PGRST00[0-3]$/
const SEED_ATTEMPTS = 3

/**
 * WORKAROUND, not design: pglite-socket 0.2.11 answers a failed statement
 * with a premature ReadyForQuery (electric-sql/pglite#958; fix in PR #977,
 * unmerged), so PostgREST drops its one connection and the next call, often
 * the next test's seeding, gets "Database connection error". Remove this
 * once a pglite-socket release carries the fix.
 *
 * UNPROVEN: the failure did not show up in the 30 suite runs made after this
 * went in (2026-10-07), so the retry has never been seen to fire. If the
 * error comes back, this did not fix it; each retry is logged with
 * console.warn so that a run where it did fire can be told apart.
 *
 * Runs a seeding `query` up to 3 times, retrying connection errors only.
 * Anything the database itself answered (23505 above all) is returned on
 * the first attempt, untouched: tests assert on those.
 */
async function seed<T>(query: () => PromiseLike<SeedResult<T>>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await query()
    if (attempt === SEED_ATTEMPTS || !CONNECTION_ERROR.test(result.error?.code ?? '')) return must(result)
    console.warn(`[harness] seeding hit ${result.error!.code} (pglite#958), retry ${attempt}/${SEED_ATTEMPTS - 1}`)
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
  }
}

/**
 * A fresh organization with one client and a live website channel. Both get
 * their default trial subscriptions from the database triggers.
 *
 * The client books appointments (a day and a time), like every client that
 * existed when the booking setting shipped: a brand-new client follows its
 * opening hours instead, and these tests were written for appointments.
 * `bookingMode: null` leaves the new-client default in place. The name rule
 * is the default (any name) unless a test asks for two parts.
 */
export async function seedClient({
  bookingMode = 'appointment',
  nameStrictness = 'single',
}: { bookingMode?: 'appointment' | 'day_only' | 'none' | null; nameStrictness?: 'single' | 'two_parts' } = {}) {
  const supabase = serviceClient()
  const tag = randomUUID().slice(0, 8)

  const org = await seed(() =>
    supabase.from('organizations').insert({ name: `Org ${tag}`, slug: `org-${tag}` }).select('id').single<{ id: string }>()
  )
  const client = await seed(() =>
    supabase
      .from('clients')
      .insert({ organization_id: org.id, name: `Client ${tag}`, slug: `client-${tag}` })
      .select('id')
      .single<{ id: string }>()
  )
  const channel = await seed(() =>
    supabase
      .from('channels')
      .insert({ client_id: client.id, type: 'website', name: 'Website' })
      .select('id')
      .single<{ id: string }>()
  )
  if (bookingMode !== null || nameStrictness !== 'single') {
    await seed(() =>
      supabase
        .from('bot_settings')
        .update({ ...(bookingMode !== null ? { booking_mode: bookingMode } : {}), name_strictness: nameStrictness })
        .eq('client_id', client.id)
        .select('client_id')
        .single()
    )
  }

  return { supabase, organizationId: org.id, clientId: client.id, channelId: channel.id }
}
