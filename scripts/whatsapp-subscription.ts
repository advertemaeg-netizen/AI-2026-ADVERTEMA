/**
 * The WABA's subscription to our app, read or taken, for one WhatsApp channel
 * (.scratch/whatsapp-send-design.md §5):
 *
 *   npm run whatsapp:subscription -- check <channelId>
 *   npm run whatsapp:subscription -- subscribe <channelId>
 *
 * `check` is read-only: it asks Meta which apps the channel's WABA is
 * subscribed to and says whether ours is among them. `subscribe` makes the
 * subscription and reads the state back. Both use the channel's token from
 * channel_secrets through the service role, and print the state only: never
 * the token. META_APP_ID must be set in .env.local.
 *
 * Until a WhatsApp channel can be connected from the dashboard, this is the
 * connect step's home.
 */
import path from 'node:path'
import { createAdminClient } from '@/lib/supabase/admin'
import { subscribeApp, subscribedApps } from '@/lib/meta/subscription'
import { UUID_PATTERN } from '@/lib/types/clients'

process.loadEnvFile(path.join(process.cwd(), '.env.local'))

const [command, channelId] = process.argv.slice(2)
if ((command !== 'check' && command !== 'subscribe') || !channelId || !UUID_PATTERN.test(channelId)) {
  console.error('usage: npm run whatsapp:subscription -- check|subscribe <channelId>')
  process.exit(2)
}

const supabase = createAdminClient()
const state = command === 'check' ? await subscribedApps({ supabase, channelId }) : await subscribeApp({ supabase, channelId })
console.log(JSON.stringify({ channelId, ...state }, null, 2))
process.exit(state.kind === 'subscribed' ? 0 : 1)
