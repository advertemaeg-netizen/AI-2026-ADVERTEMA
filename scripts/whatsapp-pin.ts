/**
 * Gives a WhatsApp number's two-step verification PIN back to the business
 * that owns it (decided 2026-11-09):
 *
 *   npm run whatsapp:pin -- <channelId>
 *
 * We set the PIN when we registered the number (src/lib/actions/whatsapp-connect.ts),
 * and the number cannot be registered anywhere else without it: a clinic that
 * leaves us needs it, and we must never be the only ones able to open a
 * business's own number. Run it for the business that asked, after checking
 * who is asking, and tell them the PIN directly.
 *
 * Prints the PIN to this terminal and nowhere else: not to a log, not to a
 * file. Read-only. Uses the service role from .env.local.
 */
import path from 'node:path'
import { createAdminClient } from '@/lib/supabase/admin'
import { UUID_PATTERN } from '@/lib/types/clients'

process.loadEnvFile(path.join(process.cwd(), '.env.local'))

const [channelId] = process.argv.slice(2)
if (!channelId || !UUID_PATTERN.test(channelId)) {
  console.error('usage: npm run whatsapp:pin -- <channelId>')
  process.exit(2)
}

const supabase = createAdminClient()
const { data: channel, error } = await supabase.from('channels').select('id, type, name, external_id, client_id').eq('id', channelId).maybeSingle<{ id: string; type: string; name: string; external_id: string | null; client_id: string }>()
if (error || !channel) {
  console.error(error ? `reading the channel failed: ${error.message}` : 'no such channel')
  process.exit(1)
}
if (channel.type !== 'whatsapp') {
  console.error(`channel ${channelId} is ${channel.type}, not WhatsApp: it has no PIN`)
  process.exit(1)
}
const { data: secret } = await supabase.from('channel_secrets').select('registration_pin').eq('channel_id', channelId).maybeSingle<{ registration_pin: string | null }>()
if (!secret?.registration_pin) {
  console.error('no PIN is stored for this channel: it was not registered through the connect')
  process.exit(1)
}
console.log(`channel ${channel.id} (client ${channel.client_id}), number id ${channel.external_id}`)
console.log(`two-step verification PIN: ${secret.registration_pin}`)
process.exit(0)
