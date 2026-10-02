/**
 * Puts the demo account back to its first state: removes the leads,
 * conversations, messages, appointments and events its visitors left behind
 * and seeds them again, dated from today. The auth user, channels, bot
 * settings and knowledge base stay (no re-embedding).
 *
 *   npm run reset:demo                    leads and conversations only
 *   npm run reset:demo -- --with-kb       also rebuild the knowledge base
 *   npm run reset:demo -- --dry-run       print what would be deleted, change nothing
 *
 * Every delete is `where client_id = <the demo client>` (see deleteByClient
 * in seed-demo.ts); the database holds real customers.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { findDemo, seedKnowledge, seedLeads, verifyLeads } from './seed-demo'

async function main() {
  const withKb = process.argv.includes('--with-kb')
  const dryRun = process.argv.includes('--dry-run')
  const admin = createAdminClient()
  console.log(`database: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`)

  const demo = await findDemo(admin)
  if (!demo) throw new Error('the demo account does not exist: run `npm run seed:demo` first')
  console.log(`demo client ${demo.clientId}`)

  if (dryRun) {
    const id = demo.clientId
    for (const table of ['leads', 'conversations', 'usage_alerts', ...(withKb ? ['knowledge_documents'] : [])]) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('client_id', id)
      console.log(`  delete from ${table} where client_id = '${id}'  → ${count ?? 0} rows`)
    }
    console.log(`  update client_subscriptions set messages_used = 0, lead_capture_used = 0 where client_id = '${id}'`)
    return
  }

  if (withKb) await seedKnowledge(admin, demo)
  await seedLeads(admin, demo)
  await verifyLeads(admin, demo)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
