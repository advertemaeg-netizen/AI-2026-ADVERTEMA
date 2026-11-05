import 'server-only'

/**
 * CONNECTING A PAGE AND AN INSTAGRAM ACCOUNT: Facebook Login for Business,
 * one configuration, one callback (.scratch/messenger-instagram-design.md §12).
 *
 * What the token tells us, proven on real logins (runs 1–4b, 2026-11-05):
 *
 *   - /me/accounts is the listing. It follows what the clinic granted, not the
 *     whole business (an unpicked Page in the same portfolio never appeared).
 *   - It returns every account EVER granted to the app's system user in that
 *     business, not the current pick (grants accumulate; Meta's own dialog
 *     pre-ticks them as "Previously shared"). Nothing in it tells a new grant
 *     from an old one. So the clinic picks, after the return, in our picker.
 *   - An Instagram account arrives through its linked Page, and granting the
 *     Instagram account alone carries that Page with it, with a working Page
 *     token, although the clinic never offered the Page and cannot see it in
 *     its own access list on Meta.
 *   - A Page the clinic granted carries `tasks`; a Page carried in by its
 *     Instagram account has NO `tasks` field (five observations, three
 *     logins).
 *
 * THE RULE: we connect only what the clinic offered. A Page is offered for
 * Messenger only when it carries `tasks` including MESSAGING. A missing field
 * is absence, never "unknown", and there is no fallback that offers it: if
 * Meta stops sending `tasks`, every Page looks un-offered and the picker
 * offers no Messenger at all. Under-offering is the safe direction, and it is
 * the whole argument for building on an undocumented field.
 *
 * Tokens travel in the Authorization header or a POST body, never a query
 * string. Paging follows `paging.cursors.after` with the header token; a
 * `paging.next` URL (it carries the token) is never fetched or logged.
 * Logged: ids, statuses, error codes. Never a token or a code.
 */

// A DEBT TO UNIFY (send.ts): WhatsApp and Messenger sending are on v25.0; the connect calls are on v26.0, as the Instagram ones
const GRAPH = 'https://graph.facebook.com/v26.0'
const DIALOG = 'https://www.facebook.com/v26.0/dialog/oauth'
const TIMEOUT_MS = 15_000
/** /me/accounts pages read at most (100 Pages each); a business with more is not a clinic */
const MAX_PAGES = 5

/** The configuration's permissions (1018979181243946): all must be granted */
export const REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
  'pages_read_user_content',
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
] as const

/** What each channel type subscribes to. Page: proven 2026-11-04 (echoes and reactions carry staff replies) */
export const PAGE_FIELDS = ['feed', 'messages', 'message_echoes', 'message_reactions'] as const
/** Instagram: proven 2026-11-04 and 2026-11-05 */
export const INSTAGRAM_FIELDS = ['messages', 'comments'] as const

/** A Page as /me/accounts returned it. `tasks` null when the field is absent */
export type PageGrant = {
  id: string
  name: string
  tasks: string[] | null
  pageToken: string | null
  instagram: { id: string; username: string | null } | null
}

/** One choice in the picker: a Page, and what of it may be connected. No token */
export type ConnectOption = {
  pageId: string
  pageName: string
  /** The clinic granted this Page itself (tasks with MESSAGING): Messenger may be offered */
  messenger: boolean
  instagram: { id: string; username: string | null } | null
}

/**
 * Whether the clinic offered this Page itself. `tasks` absent, not an array,
 * empty, or without MESSAGING: not offered. Never inferred any other way.
 */
export function pageOffered(tasks: unknown): boolean {
  return Array.isArray(tasks) && tasks.includes('MESSAGING')
}

/**
 * The picker's choices from what the token can see. A Page carried in by its
 * Instagram account is a choice only for that Instagram account; a Page with
 * neither an offer nor an Instagram account is not a choice at all.
 */
export function connectOptions(pages: PageGrant[]): ConnectOption[] {
  return pages.flatMap((page) => {
    const messenger = pageOffered(page.tasks)
    if (!messenger && !page.instagram) return []
    return [{ pageId: page.id, pageName: page.name, messenger, instagram: page.instagram }]
  })
}

/** The login dialog for our configuration */
export function dialogUrl({ appId, configId, redirectUri, state }: { appId: string; configId: string; redirectUri: string; state: string }) {
  const url = new URL(DIALOG)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('config_id', configId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('override_default_response_type', 'true')
  return url.toString()
}

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; status: number | null; code: number | null }

async function call(path: string, init: { token?: string; form?: Record<string, string>; query?: Record<string, string> } = {}): Promise<Answer> {
  const url = new URL(`${GRAPH}/${path}`)
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
  let response: Response
  try {
    response = await fetch(url, {
      method: init.form ? 'POST' : 'GET',
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.form ? new URLSearchParams(init.form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { ok: false, status: null, code: null }
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code?: unknown } }
  if (!response.ok || body.error) {
    const code = typeof body.error?.code === 'number' ? body.error.code : null
    return { ok: false, status: response.status, code }
  }
  return { ok: true, body }
}

function failed(log: string, answer: Extract<Answer, { ok: false }>, extra: Record<string, unknown> = {}) {
  console.warn(`[meta/connect] ${log}`, { status: answer.status, code: answer.code, ...extra })
}

/**
 * Callback step 3: the code for the system-user token, server to server, with
 * the identical redirect_uri. The secret and the code go in a POST body.
 */
export async function exchangeCode({ code, redirectUri, appId, appSecret }: { code: string; redirectUri: string; appId: string; appSecret: string }): Promise<string | null> {
  const answer = await call('oauth/access_token', {
    form: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
  })
  if (!answer.ok) {
    failed('code exchange refused', answer)
    return null
  }
  return typeof answer.body.access_token === 'string' && answer.body.access_token ? answer.body.access_token : null
}

export type TokenCheck = { kind: 'ok' } | { kind: 'invalid' } | { kind: 'missingPermission'; missing: string[] } | { kind: 'failed' }

/**
 * Callback step 4: the token is valid, is ours, is a system user's, and holds
 * every permission the configuration asks for (a clinic can switch one off in
 * Meta's dialog). debug_token takes the token as input_token: it goes in a
 * POST body with method=GET, never the query string; our app token in the
 * header.
 */
export async function checkToken({ token, appId, appSecret }: { token: string; appId: string; appSecret: string }): Promise<TokenCheck> {
  const answer = await call('debug_token', { token: `${appId}|${appSecret}`, form: { method: 'GET', input_token: token } })
  if (!answer.ok) {
    failed('debug_token refused', answer)
    return { kind: 'failed' }
  }
  const data = (answer.body.data ?? {}) as { is_valid?: unknown; app_id?: unknown; type?: unknown; scopes?: unknown }
  if (data.is_valid !== true || String(data.app_id) !== appId || data.type !== 'SYSTEM_USER') {
    console.warn('[meta/connect] token rejected', { isValid: data.is_valid, appMatches: String(data.app_id) === appId, type: data.type })
    return { kind: 'invalid' }
  }
  const scopes = Array.isArray(data.scopes) ? (data.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : []
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope))
  if (missing.length > 0) {
    console.warn('[meta/connect] permissions missing', { missing })
    return { kind: 'missingPermission', missing }
  }
  return { kind: 'ok' }
}

type RawPage = {
  id?: unknown
  name?: unknown
  tasks?: unknown
  access_token?: unknown
  instagram_business_account?: { id?: unknown; username?: unknown }
}

/**
 * Every Page the token can see, with its tasks, its Page token and its linked
 * Instagram account. null when Meta refused or a page of results failed: a
 * partial list would hide an account, so there is none.
 */
export async function listPages(token: string): Promise<PageGrant[] | null> {
  const pages: PageGrant[] = []
  let after: string | null = null
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const query: Record<string, string> = { fields: 'id,name,tasks,access_token,instagram_business_account{id,username}', limit: '100' }
    if (after) query.after = after
    const answer = await call('me/accounts', { token, query })
    if (!answer.ok) {
      failed('me/accounts refused', answer, { read })
      return null
    }
    for (const raw of Array.isArray(answer.body.data) ? (answer.body.data as RawPage[]) : []) {
      if (typeof raw.id !== 'string') continue
      const ig = raw.instagram_business_account
      pages.push({
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : raw.id,
        // Absent stays absent: only an array is tasks
        tasks: Array.isArray(raw.tasks) ? raw.tasks.filter((t): t is string => typeof t === 'string') : null,
        pageToken: typeof raw.access_token === 'string' && raw.access_token ? raw.access_token : null,
        instagram: ig && typeof ig.id === 'string' ? { id: ig.id, username: typeof ig.username === 'string' ? ig.username : null } : null,
      })
    }
    // The cursor, never paging.next: that URL carries the token
    const paging = answer.body.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined
    const cursor = typeof paging?.cursors?.after === 'string' ? paging.cursors.after : null
    if (!cursor || !paging?.next) return pages
    after = cursor
  }
  console.warn('[meta/connect] me/accounts truncated', { pages: pages.length })
  return pages
}

export type SubscribeResult = { kind: 'subscribed' } | { kind: 'failed'; step: 'subscribe' | 'read'; status: number | null; code: number | null }

/**
 * Callback step 5: POST then GET {id}/subscribed_apps. The GET is the check:
 * it must list every field. A Page answers with one entry per app (ours by
 * id); an Instagram account with its subscription to the calling app.
 */
export async function subscribe({ objectId, token, fields, appId }: { objectId: string; token: string; fields: readonly string[]; appId: string }): Promise<SubscribeResult> {
  const post = await call(`${objectId}/subscribed_apps`, { token, form: { subscribed_fields: fields.join(',') } })
  if (!post.ok || post.body.success !== true) {
    const status = post.ok ? null : post.status
    const code = post.ok ? null : post.code
    console.warn('[meta/connect] subscribe refused', { objectId, status, code })
    return { kind: 'failed', step: 'subscribe', status, code }
  }
  const read = await call(`${objectId}/subscribed_apps`, { token })
  if (!read.ok) {
    failed('subscribed_apps read refused', read, { objectId })
    return { kind: 'failed', step: 'read', status: read.status, code: read.code }
  }
  const entries = (Array.isArray(read.body.data) ? read.body.data : [read.body]) as { id?: unknown; subscribed_fields?: unknown }[]
  const ours = entries.find((entry) => String(entry.id) === appId) ?? (entries.length === 1 && entries[0].id === undefined ? entries[0] : undefined)
  const subscribed = Array.isArray(ours?.subscribed_fields) ? (ours.subscribed_fields as unknown[]) : []
  const missing = fields.filter((field) => !subscribed.includes(field))
  if (missing.length > 0) {
    console.warn('[meta/connect] subscription incomplete', { objectId, missing })
    return { kind: 'failed', step: 'read', status: null, code: null }
  }
  console.info('[meta/connect] subscribed', { objectId, fields })
  return { kind: 'subscribed' }
}

/**
 * Callback step 6, Instagram: whether messages can be read at all. #200 is
 * the account owner's switch ("Allow access to Instagram messages in Inbox",
 * on the linked Page) being off: comments work, messages are blocked.
 */
export async function instagramMessagesBlocked({ igId, token }: { igId: string; token: string }): Promise<boolean | null> {
  const answer = await call(`${igId}/conversations`, { token, query: { platform: 'instagram', limit: '1' } })
  if (answer.ok) return false
  if (answer.code === 200) return true
  failed('conversations check failed', answer, { igId })
  return null
}
