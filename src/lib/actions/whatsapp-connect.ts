'use server'

import { revalidatePath } from 'next/cache'
import { checkToken, exchangeCode } from '@/lib/meta/connect'
import { logConnect, occupancy } from '@/lib/meta/connect-flow'
import { manager } from '@/lib/meta/connect-manager'
import { subscribeApp } from '@/lib/meta/subscription'
import { WHATSAPP_REQUIRED_SCOPES, newPin, registerNumber, wabaNumbers, whatsappConfig } from '@/lib/meta/whatsapp-connect'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkClientLimit, limitErrorFromDb } from '@/lib/subscription-limits'
import { UUID_PATTERN } from '@/lib/types/clients'
import type { WhatsAppConnectResult, WhatsAppConnectStatus, WhatsAppSignup } from '@/lib/types/whatsapp-connect'

/**
 * A CLIENT CONNECTS A WHATSAPP NUMBER ITSELF (Embedded Signup, the ordinary
 * path: never coexistence; decided 2026-11-09).
 *
 * The clinic is signed in and on one client's channels page: the client is
 * this session's, so nothing is carried through Meta. Meta's popup hands the
 * browser a code and the WABA and number ids; this action trusts none of it
 * until the server has seen it:
 *   1. the code is exchanged, server to server, for a system-user token;
 *   2. the token is ours, a system user's, with both WhatsApp permissions;
 *   3. the WABA is one the token was granted, and the number is in it (read
 *      with the token, never taken from the browser);
 *   4. the number is no other client's; a new channel takes a seat;
 *   5. the channel is created PAUSED (or the client's own refreshed, keeping
 *      its state), and its token, WABA and PIN are stored server-only;
 *   6. the number is registered with its PIN (kept: the business's, given
 *      back on request), then our app is subscribed to the WABA.
 * A failure at 6 leaves the channel, paused, with its secrets: "try again"
 * (retryWhatsAppConnect) resumes there and never redoes the signup.
 *
 * One line per decision in the log (logConnect), with Meta's ids and our own;
 * never the code, the token or the PIN.
 */

const CHANNELS_PATH = '/[locale]/dashboard/clients/[clientId]/channels'
const META_ID = /^\d{5,25}$/

export async function connectWhatsApp(clientId: string, signup: WhatsAppSignup): Promise<WhatsAppConnectResult> {
  const trace: Record<string, unknown> = { flow: 'whatsapp', step: 'connect', clientId, waba: signup?.wabaId, number: signup?.phoneNumberId }
  const done = (status: WhatsAppConnectStatus, why: Record<string, unknown> = {}, channelId?: string): WhatsAppConnectResult => {
    logConnect({ ...trace, ...why, outcome: status })
    return { ok: status === 'connectedPaused' || status === 'reconnected', status, ...(channelId ? { channelId } : {}) }
  }

  const caller = await manager(clientId)
  if (!caller.ok) return done(caller.error)
  const config = whatsappConfig()
  if (!config) return done('notConfigured')
  if (typeof signup?.code !== 'string' || !signup.code || signup.code.length > 4096 || !META_ID.test(String(signup.wabaId)) || !META_ID.test(String(signup.phoneNumberId))) {
    return done('forbidden', { refused: 'malformed_signup' })
  }
  const { code, wabaId, phoneNumberId } = signup

  // 1. The popup's code: exchanged without a redirect_uri (Meta's Tech Provider guide)
  const token = await exchangeCode({ code, redirectUri: null, appId: config.appId, appSecret: config.appSecret })
  if (!token) return done('metaError', { refused: 'code_exchange' })

  // 2. Ours, a system user's, both WhatsApp permissions
  const check = await checkToken({ token, appId: config.appId, appSecret: config.appSecret, required: WHATSAPP_REQUIRED_SCOPES })
  if (check.kind === 'missingPermission') return done('missingPermission', { missing: check.missing })
  if (check.kind !== 'ok') return done('metaError', { refused: `token_${check.kind}` })

  // 3. The WABA the browser named, as the token was granted it; the number, as the token reads the WABA
  for (const scope of WHATSAPP_REQUIRED_SCOPES) {
    const granted = check.targets[scope]
    if (granted && granted.length > 0 && !granted.includes(wabaId)) return done('metaError', { refused: 'waba_not_granted', scope })
  }
  const numbers = await wabaNumbers(wabaId, token)
  if (!numbers) return done('metaError', { refused: 'waba_unreadable' })
  const number = numbers.find((n) => n.id === phoneNumberId)
  if (!number) return done('metaError', { refused: 'number_not_in_waba', numbers: numbers.length })

  // 4. Nobody else's; a new channel takes a seat
  const admin = createAdminClient()
  const held = await occupancy(admin, clientId, 'whatsapp', phoneNumberId)
  if (held.availability === 'otherClient') return done('takenByOther')
  if (!held.channelId) {
    let seats
    try {
      seats = await checkClientLimit(caller.supabase, clientId, 'channels')
    } catch (error) {
      console.error('[whatsapp/connect] seat check', error)
      return done('unknown', { seats: 'check_failed' })
    }
    if (seats?.reason === 'inactive') return done('subscriptionInactive')
    if (seats && seats.limit !== null && seats.limit - seats.used < 1) return done('channelLimit', { seats: { limit: seats.limit, used: seats.used } })
  }

  // 5. The channel: created paused, as the user (RLS decides), or the client's own refreshed
  let channelId = held.channelId
  const created = !channelId
  if (!channelId) {
    const name = (number.verifiedName ?? number.displayPhoneNumber ?? 'WhatsApp').slice(0, 100)
    const { data, error } = await caller.supabase
      .from('channels')
      .insert({ client_id: clientId, type: 'whatsapp', name, external_id: phoneNumberId, is_active: false })
      .select('id')
      .single<{ id: string }>()
    if (error) {
      const limit = limitErrorFromDb(error)
      if (limit === 'subscriptionInactive') return done('subscriptionInactive')
      if (limit) return done('channelLimit')
      if (error.code === '23505') return done('takenByOther', { insert: 'unique' })
      if (error.code === '42501') return done('forbidden')
      console.error('[whatsapp/connect] channel insert', { code: error.code })
      return done('unknown', { insert: error.code })
    }
    channelId = data.id
  }
  trace.channelId = channelId
  trace.created = created

  // The PIN a number was registered with stays: a reconnect registers it again with the same one
  const { data: secret, error: secretReadError } = await admin.from('channel_secrets').select('registration_pin').eq('channel_id', channelId).maybeSingle<{ registration_pin: string | null }>()
  if (secretReadError) return done('unknown', { secrets: 'read_failed' }, channelId)
  const pin = secret?.registration_pin ?? newPin()
  const { error: secretError } = await admin
    .from('channel_secrets')
    .upsert({ channel_id: channelId, access_token: token, waba_id: wabaId, registration_pin: pin }, { onConflict: 'channel_id' })
  if (secretError) {
    console.error('[whatsapp/connect] channel_secrets', { code: secretError.code })
    return done('unknown', { secrets: 'write_failed' }, channelId)
  }

  // What the card says: the name's review, and no longer "removed" once connected again
  await setNotice(admin, channelId, number.nameStatus === 'APPROVED' ? null : 'name_pending')

  // 6. Register, then subscribe
  const finished = await registerAndSubscribe(admin, channelId, phoneNumberId, token, pin)
  revalidatePath(CHANNELS_PATH, 'page')
  if (finished !== 'ok') return done(finished, {}, channelId)
  return done(created ? 'connectedPaused' : 'reconnected', { nameStatus: number.nameStatus }, channelId)
}

/**
 * "Try again" after a connect stopped at registering or subscribing: the
 * channel and its secrets exist; this resumes there, with the stored token
 * and PIN, and never asks the clinic to sign up again.
 */
export async function retryWhatsAppConnect(clientId: string, channelId: string): Promise<WhatsAppConnectResult> {
  const trace: Record<string, unknown> = { flow: 'whatsapp', step: 'retry', clientId, channelId }
  const done = (status: WhatsAppConnectStatus, why: Record<string, unknown> = {}): WhatsAppConnectResult => {
    logConnect({ ...trace, ...why, outcome: status })
    return { ok: status === 'reconnected' || status === 'connectedPaused', status, channelId }
  }
  const caller = await manager(clientId)
  if (!caller.ok) return done(caller.error)
  if (!UUID_PATTERN.test(channelId)) return done('forbidden')
  // The user can see the channel, and it is this client's WhatsApp channel
  const { data: channel } = await caller.supabase
    .from('channels')
    .select('id, external_id, is_active')
    .eq('id', channelId)
    .eq('client_id', clientId)
    .eq('type', 'whatsapp')
    .maybeSingle<{ id: string; external_id: string | null; is_active: boolean }>()
  if (!channel?.external_id) return done('forbidden')
  const admin = createAdminClient()
  const { data: secret } = await admin.from('channel_secrets').select('access_token, registration_pin').eq('channel_id', channelId).maybeSingle<{ access_token: string; registration_pin: string | null }>()
  if (!secret?.access_token || !secret.registration_pin) return done('metaError', { refused: 'no_secrets' })
  const finished = await registerAndSubscribe(admin, channelId, channel.external_id, secret.access_token, secret.registration_pin)
  revalidatePath(CHANNELS_PATH, 'page')
  // Finished: a paused channel says so (it is not answering yet), a live one that it was refreshed
  return done(finished === 'ok' ? (channel.is_active ? 'reconnected' : 'connectedPaused') : finished)
}

async function registerAndSubscribe(
  admin: ReturnType<typeof createAdminClient>,
  channelId: string,
  phoneNumberId: string,
  token: string,
  pin: string
): Promise<'ok' | 'registerFailed' | 'subscribeFailed'> {
  const registered = await registerNumber(phoneNumberId, token, pin)
  if (!registered.ok) return 'registerFailed'
  const subscription = await subscribeApp({ supabase: admin, channelId })
  if (subscription.kind !== 'subscribed') return 'subscribeFailed'
  return 'ok'
}

async function setNotice(admin: ReturnType<typeof createAdminClient>, channelId: string, notice: 'name_pending' | null) {
  const { error } = await admin.from('channels').update({ connection_notice: notice }).eq('id', channelId)
  if (error) console.error('[whatsapp/connect] connection_notice', { channelId, code: error.code })
}
