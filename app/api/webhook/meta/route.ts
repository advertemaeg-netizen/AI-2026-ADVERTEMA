import { after, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { handleInboundWhatsAppMessage, type InboundChannel } from '@/lib/meta/inbound'
import { claimMessages, completeMessages, type MessageClaim } from '@/lib/meta/processed'
import {
  CHANNEL_TYPE,
  deliveryShape,
  inboundWhatsAppMessages,
  signatureDigest,
  signatureMatches,
  type DeliveryShape,
} from '@/lib/meta/webhook'

/**
 * Meta's webhook: WhatsApp, Messenger and Instagram deliveries. The GET is
 * the subscription handshake; the POST verifies the signature, answers 200,
 * and after the response claims every inbound message id once, answers each
 * new WhatsApp text through the one reply pipeline, and logs the shape of
 * the delivery: never its text or its sender.
 *
 * It lives on the app's host, https://app.mudrik-ai.com/api/webhook/meta. The
 * site's hosts answer every /api path with a 307 to that host
 * (src/site/host-routing.ts), and Meta's verification call doesn't follow it.
 * On the app's host the proxy passes /api through before any locale or auth
 * logic (tests/meta/webhook.test.ts holds both). Meta calls as nobody, so
 * there is no session here: the GET is checked by the verify token, the POST
 * by its signature.
 */

/** The subscription handshake: hub.challenge back as plain text when the token is ours */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const ours = process.env.META_VERIFY_TOKEN
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  if (!ours) console.error('[webhook/meta] META_VERIFY_TOKEN is not set: verification refused')
  if (!ours || params.get('hub.mode') !== 'subscribe' || token !== ours || challenge === null) {
    return new Response('Forbidden', { status: 403 })
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

export async function POST(request: NextRequest) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) {
    // Meta retries a non-200, so these come back until the variable is set
    console.error('[webhook/meta] META_APP_SECRET is not set: delivery refused')
    return new Response('Not configured', { status: 503 })
  }

  // Unsigned or malformed: refused before the body is read
  const digest = signatureDigest(request.headers.get('x-hub-signature-256'))
  if (!digest) return new Response('Unauthorized', { status: 401 })

  // The signature covers the raw bytes, so they are read as bytes and parsed
  // only once they are proven to be Meta's
  const raw = Buffer.from(await request.arrayBuffer())
  if (!signatureMatches(raw, digest, appSecret)) {
    console.warn('[webhook/meta] signature mismatch: delivery refused')
    return new Response('Unauthorized', { status: 401 })
  }

  // 200 now, the work after: Meta's timeout is short and the model is not,
  // and it retries anything slow or non-200. Safe here because the container
  // is long-running: after() work is not cut off with the response. If
  // processing throws it is caught inside and never becomes a non-200: the
  // 200 has already gone.
  after(() => processDelivery(raw))
  return new Response(null, { status: 200 })
}

/** What became of each inbound message id in a delivery */
type Disposition = 'new' | 'duplicate' | 'unmapped' | 'unclaimed' | 'inactive' | 'reaction' | 'not_text' | 'answered' | 'failed'

async function processDelivery(raw: Buffer) {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      console.warn('[webhook/meta] signed delivery is not JSON', { bytes: raw.length })
      return
    }
    const shape = deliveryShape(payload)
    const supabase = createAdminClient()
    const clients = await clientsFor(supabase, shape)

    // IDEMPOTENCY FIRST: every inbound message id is claimed before anything
    // acts on it. A duplicate is logged and nothing more happens to it; a
    // message with no channel of ours cannot be claimed (the row needs the
    // channel) and nothing could act on it either. If the claim itself
    // fails, nothing acts: an unclaimed message may already have been
    // answered. The claimed rows are closed at the end (completed_at): one
    // left open is a message a crash swallowed, and the count of those is
    // how that is seen.
    const inbound: MessageClaim[] = []
    const messages: Record<string, Disposition> = {}
    for (const entry of shape.entries) {
      const mapped = entry.businessId ? clients[entry.businessId] : undefined
      for (const event of entry.events) {
        if (event.kind !== 'message' || !event.messageId || event.echo) continue
        if (typeof mapped !== 'object') {
          messages[event.messageId] = 'unmapped'
          continue
        }
        inbound.push({ messageId: event.messageId, channelId: mapped.channelId })
        messages[event.messageId] = 'unclaimed'
      }
    }
    let fresh = new Set<string>()
    try {
      fresh = await claimMessages(supabase, inbound)
      for (const claim of inbound) messages[claim.messageId] = fresh.has(claim.messageId) ? 'new' : 'duplicate'
    } catch (error) {
      console.error('[webhook/meta] claiming the delivery failed; nothing acted on', error)
    }

    // THE REPLY: each new WhatsApp message, in order: a text through the one
    // pipeline, anything else stored as what it is and answered once.
    // A failure on one message is logged and the next is still answered; its
    // row is closed either way, so the retry Meta sends is a duplicate (a
    // dropped reply is the trade insert-first makes, and it is findable).
    for (const message of inboundWhatsAppMessages(payload)) {
      if (!fresh.has(message.messageId)) continue
      const mapped = clients[message.businessId]
      if (typeof mapped !== 'object') continue
      try {
        const result = await handleInboundWhatsAppMessage({ supabase, channel: mapped.channel, message })
        messages[message.messageId] = result.kind
      } catch (error) {
        messages[message.messageId] = 'failed'
        console.error('[webhook/meta] answering a message failed', { channelId: mapped.channelId, messageId: message.messageId, error })
      }
    }

    console.info('[webhook/meta]', JSON.stringify({ ...shape, clients: loggable(clients), messages }))

    try {
      await completeMessages(supabase, fresh)
    } catch (error) {
      console.error('[webhook/meta] closing the processed rows failed; they will count as swallowed', error)
    }
  } catch (error) {
    console.error('[webhook/meta] processing the delivery failed', error)
  }
}

type Mapped = { clientId: string; channelId: string; channel: InboundChannel }

/** The log's view of the mapping: ids, and whether the channel is live */
function loggable(clients: Record<string, Mapped | string>) {
  return Object.fromEntries(
    Object.entries(clients).map(([id, value]) => [
      id,
      typeof value === 'object' ? { clientId: value.clientId, channelId: value.channelId, live: value.channel.is_active && value.channel.clients?.status === 'active' } : value,
    ])
  )
}

/**
 * Which of our channels each business id belongs to, when one is set up
 * with it as external_id. Rows are read with their state (is_active, the
 * client's and organization's), and WHEN TWO CHANNELS CARRY THE SAME ID THE
 * ACTIVE ONE IS CHOSEN: a deactivated row must never be the one a lookup
 * picks (the placeholder channel of 2026-10-02 next to the live one). An
 * inactive-only match is still mapped, as inactive, so the delivery is
 * logged as such rather than as unknown.
 */
async function clientsFor(supabase: ReturnType<typeof createAdminClient>, shape: DeliveryShape): Promise<Record<string, Mapped | string>> {
  const type = CHANNEL_TYPE[shape.channel]
  const ids = [...new Set(shape.entries.flatMap((entry) => (entry.businessId ? [entry.businessId] : [])))]
  if (!type || ids.length === 0) return {}

  const { data, error } = await supabase
    .from('channels')
    .select('id, client_id, external_id, is_active, clients(name, industry, description, status, organizations(is_active))')
    .eq('type', type)
    .in('external_id', ids)
    .order('is_active', { ascending: false })
    .returns<(InboundChannel & { external_id: string })[]>()
  if (error) {
    console.error('[webhook/meta] looking up the channel failed', error)
    return Object.fromEntries(ids.map((id) => [id, 'lookup failed']))
  }
  return Object.fromEntries(
    ids.map((id) => {
      // Ordered active first above; find() takes the first
      const channel = data.find((row) => row.external_id === id)
      return [id, channel ? { clientId: channel.client_id, channelId: channel.id, channel } : 'unmapped']
    })
  )
}
