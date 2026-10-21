import { after, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { CHANNEL_TYPE, deliveryShape, signatureDigest, signatureMatches, type DeliveryShape } from '@/lib/meta/webhook'

/**
 * Meta's webhook: WhatsApp, Messenger and Instagram deliveries. Receive and
 * log only. Nothing here replies, calls the model, or writes a conversation
 * or a lead.
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

  // 200 now, the logging after: Meta retries anything slow or non-200
  after(() => logDelivery(raw))
  return new Response(null, { status: 200 })
}

async function logDelivery(raw: Buffer) {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      console.warn('[webhook/meta] signed delivery is not JSON', { bytes: raw.length })
      return
    }
    const shape = deliveryShape(payload)

    // IDEMPOTENCY GOES HERE, before anything acts on a delivery. Meta
    // redelivers (a slow 200, a retry after a 5xx, sometimes for no reason),
    // so the same event can arrive more than once. The key is Meta's id per
    // event: a message's id (wamid… on WhatsApp, mid on Messenger), and for a
    // WhatsApp status its id plus the status, since sent/delivered/read share
    // the id. Insert that key into a table with a unique constraint and skip
    // the event when the insert conflicts, before a conversation or lead is
    // written. Not built yet: a duplicate log line costs nothing.

    console.info('[webhook/meta]', JSON.stringify({ ...shape, clients: await clientsFor(shape) }))
  } catch (error) {
    console.error('[webhook/meta] logging the delivery failed', error)
  }
}

/** Which of our channels each business id belongs to, when one is set up with it as external_id */
async function clientsFor(shape: DeliveryShape) {
  const type = CHANNEL_TYPE[shape.channel]
  const ids = [...new Set(shape.entries.flatMap((entry) => (entry.businessId ? [entry.businessId] : [])))]
  if (!type || ids.length === 0) return {}

  const { data, error } = await createAdminClient()
    .from('channels')
    .select('id, client_id, external_id')
    .eq('type', type)
    .in('external_id', ids)
    .returns<{ id: string; client_id: string; external_id: string }[]>()
  if (error) {
    console.error('[webhook/meta] looking up the channel failed', error)
    return Object.fromEntries(ids.map((id) => [id, 'lookup failed']))
  }
  return Object.fromEntries(
    ids.map((id) => {
      const channel = data.find((row) => row.external_id === id)
      return [id, channel ? { clientId: channel.client_id, channelId: channel.id } : 'unmapped']
    })
  )
}
