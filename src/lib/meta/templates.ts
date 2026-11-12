import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { templateStatus, type TemplateInput, type WhatsAppTemplate } from '@/lib/types/templates'

/**
 * WHATSAPP MESSAGE TEMPLATES, READ AND CREATED ON META, NEVER STORED HERE.
 *
 *   list    GET  /{waba_id}/message_templates?fields=id,name,language,status,components
 *   create  POST /{waba_id}/message_templates  { name, language, category: 'UTILITY',
 *                                                components: [{ type: 'BODY', text }] }
 *
 * The list is read live every time the screen opens: a template's status
 * changes on Meta's side (approved, rejected, paused) and a stored copy
 * would go stale without telling anyone.
 *
 * The category is UTILITY, always, here and nowhere else: the screen has no
 * category field (the owner's decision). Meta may still reclassify a
 * template on review; what the list shows is Meta's status, read live.
 *
 * Credentials: the channel's token and WABA id from channel_secrets
 * (service role only). Logged: the channel id, the status code, Meta's error
 * code and subcode. Never the token, never the template's text.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'
const TIMEOUT_MS = 15_000
/** Templates per page, and pages read: 500 templates is far past any clinic's */
const PAGE_SIZE = 100
const MAX_PAGES = 5
const CATEGORY = 'UTILITY'

type GraphError = { code?: number; error_subcode?: number }

export type TemplateListResult =
  | { kind: 'ok'; templates: WhatsAppTemplate[] }
  /** The channel has no token or no WABA id: nothing was asked */
  | { kind: 'not_configured' }
  | { kind: 'failed'; status: number | null; code: number | null }

export type TemplateCreateOutcome =
  | { kind: 'created'; id: string | null; status: unknown }
  | { kind: 'not_configured' }
  | { kind: 'failed'; status: number | null; code: number | null; subcode: number | null }

async function credentials(supabase: SupabaseClient, channelId: string): Promise<{ token: string; wabaId: string } | null> {
  const { data, error } = await supabase
    .from('channel_secrets')
    .select('access_token, waba_id')
    .eq('channel_id', channelId)
    .maybeSingle<{ access_token: string | null; waba_id: string | null }>()
  if (error) throw new Error(`channel_secrets read failed: ${error.code}`)
  if (!data?.access_token || !data.waba_id) return null
  return { token: data.access_token, wabaId: data.waba_id }
}

function codes(error: GraphError | undefined) {
  return {
    code: typeof error?.code === 'number' ? error.code : null,
    subcode: typeof error?.error_subcode === 'number' ? error.error_subcode : null,
  }
}

type TemplateAnswer = {
  id?: unknown
  name?: unknown
  language?: unknown
  status?: unknown
  components?: { type?: unknown; text?: unknown }[]
}

function toTemplate(row: TemplateAnswer): WhatsAppTemplate | null {
  if (typeof row.name !== 'string' || typeof row.language !== 'string') return null
  const body = Array.isArray(row.components) ? row.components.find((part) => part?.type === 'BODY') : undefined
  return {
    id: typeof row.id === 'string' ? row.id : `${row.name}:${row.language}`,
    name: row.name,
    language: row.language,
    status: templateStatus(row.status),
    body: typeof body?.text === 'string' ? body.text : '',
  }
}

/** Every template on the channel's WhatsApp Business Account, as Meta has them now */
export async function listTemplates({ supabase, channelId }: { supabase: SupabaseClient; channelId: string }): Promise<TemplateListResult> {
  const log = '[whatsapp/templates]'
  const creds = await credentials(supabase, channelId)
  if (!creds) {
    console.warn(`${log} not_configured`, { channelId })
    return { kind: 'not_configured' }
  }
  const templates: WhatsAppTemplate[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ fields: 'id,name,language,status,components', limit: String(PAGE_SIZE) })
    if (after) query.set('after', after)
    let response: Response
    try {
      response = await fetch(`${GRAPH}/${encodeURIComponent(creds.wabaId)}/message_templates?${query}`, {
        headers: { Authorization: `Bearer ${creds.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      console.warn(`${log} request failed`, { channelId, cause: cause instanceof Error ? cause.name : 'unknown' })
      return { kind: 'failed', status: null, code: null }
    }
    const answer = (await response.json().catch(() => ({}))) as {
      data?: TemplateAnswer[]
      paging?: { next?: unknown; cursors?: { after?: unknown } }
      error?: GraphError
    }
    if (!response.ok) {
      const { code } = codes(answer.error)
      console.warn(`${log} refused`, { channelId, status: response.status, code })
      return { kind: 'failed', status: response.status, code }
    }
    for (const row of answer.data ?? []) {
      const template = toTemplate(row)
      if (template) templates.push(template)
    }
    const next = answer.paging?.next && typeof answer.paging.cursors?.after === 'string' ? answer.paging.cursors.after : null
    if (!next) return { kind: 'ok', templates }
    after = next
  }
  console.warn(`${log} more than ${MAX_PAGES * PAGE_SIZE} templates, the rest not read`, { channelId })
  return { kind: 'ok', templates }
}

/** Submits a UTILITY template with one BODY for Meta's review */
export async function createTemplate({
  supabase,
  channelId,
  template,
}: {
  supabase: SupabaseClient
  channelId: string
  template: TemplateInput
}): Promise<TemplateCreateOutcome> {
  const log = '[whatsapp/template-create]'
  const creds = await credentials(supabase, channelId)
  if (!creds) {
    console.warn(`${log} not_configured`, { channelId })
    return { kind: 'not_configured' }
  }
  let response: Response
  try {
    response = await fetch(`${GRAPH}/${encodeURIComponent(creds.wabaId)}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: template.name,
        language: template.language,
        category: CATEGORY,
        components: [{ type: 'BODY', text: template.body }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    console.warn(`${log} request failed`, { channelId, cause: cause instanceof Error ? cause.name : 'unknown' })
    return { kind: 'failed', status: null, code: null, subcode: null }
  }
  const answer = (await response.json().catch(() => ({}))) as { id?: unknown; status?: unknown; error?: GraphError }
  if (response.ok) {
    const id = typeof answer.id === 'string' ? answer.id : null
    console.info(`${log} submitted`, { channelId, templateId: id, status: answer.status })
    return { kind: 'created', id, status: answer.status }
  }
  const { code, subcode } = codes(answer.error)
  console.warn(`${log} refused`, { channelId, status: response.status, code, subcode })
  return { kind: 'failed', status: response.status, code, subcode }
}
