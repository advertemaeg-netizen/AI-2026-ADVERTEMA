import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * EMPTIES THE REVIEW CLINIC'S INBOX, the morning of filming (the owner's
 * order: reset, film, submit, nothing in between). The screencasts then fill
 * it: the reviewer finds the threads they watched being made.
 *
 *   npm run reset:review-clinic -- --email=<the reviewer's login>           dry run: counts, writes nothing
 *   npm run reset:review-clinic -- --email=<the reviewer's login> --write   deletes
 *
 * WHAT GOES, for that one client and nothing else:
 *   - its leads (their lead_events go with them, by cascade);
 *   - its conversations (their messages go with them, by cascade).
 *
 * WHAT STAYS:
 *   - ai_usage, every row, untouched. The cost was real. Deleting a
 *     conversation sets an ai_usage row's conversation_id to null (the
 *     foreign key's own rule); the row, its client_id and its cost stay. The
 *     run counts the client's ai_usage rows before and after and stops with
 *     an error if the number moved.
 *   - the clinic's content: bot settings, branch, knowledge documents,
 *     channels and their tokens, subscription. Nothing here names those tables.
 *   - meta_comment_replies: one row per comment we acted on, Meta's ids only,
 *     no text and no person. Their link to a deleted DM becomes null. A comment
 *     made on camera is a new comment id, so they change nothing.
 *
 * EVERY DELETE IS FILTERED BY THE CLINIC'S CLIENT ID, found from the login
 * with the same four checks as seed-review-clinic.ts (a direct business,
 * exactly one client, named exactly as scripts/fixtures/review-clinic.md
 * names it, and no other client of that name anywhere), and found again
 * before each delete. No bare delete, no other table.
 *
 * Keys come from .env.local, never from this file.
 */

try {
  process.loadEnvFile(path.join(process.cwd(), '.env.local'))
} catch {
  // already in the environment
}

type Admin = ReturnType<typeof createAdminClient>
type Result<T> = { data: T | null; error: { message: string; code?: string } | null; count?: number | null }

function check<T>({ data, error }: Result<T>, what: string): T {
  if (error) throw new Error(`${what}: ${error.code ?? ''} ${error.message}`)
  return data as T
}

function counted({ error, count }: Result<unknown>, what: string): number {
  if (error) throw new Error(`${what}: ${error.code ?? ''} ${error.message}`)
  if (typeof count !== 'number') throw new Error(`${what}: no count returned`)
  return count
}

/** The clinic's name as the fixture gives it: the first `| Name |` row, as generate-review-clinic.mjs reads it */
function fixtureClinicName() {
  const fixture = readFileSync(path.join(process.cwd(), 'scripts/fixtures/review-clinic.md'), 'utf8')
  const row = fixture.split('\n').find((line) => /^\|\s*Name\s*\|/.test(line))
  const name = row?.split('|')[2]?.trim().replace(/^`|`$/g, '')
  if (!name) throw new Error('could not read the clinic name from scripts/fixtures/review-clinic.md')
  return name
}

function args() {
  const email = process.argv.find((a) => a.startsWith('--email='))?.slice('--email='.length).trim()
  if (!email || !email.includes('@')) throw new Error('give the reviewer’s login: --email=<email>')
  return { email, write: process.argv.includes('--write') }
}

/** The review clinic from the login, or a throw naming the check that failed (seed-review-clinic.ts's four) */
async function findClinic(admin: Admin, email: string, name: string) {
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`)
  const users = check(await admin.from('users').select('id, organization_id').ilike('email', pattern), 'looking up the login') as { id: string; organization_id: string | null }[]
  if (users.length !== 1) throw new Error(`expected one login for ${email}, found ${users.length}`)
  const orgId = users[0].organization_id
  if (!orgId) throw new Error(`${email} belongs to no organization`)
  const org = check(await admin.from('organizations').select('id, name, org_type').eq('id', orgId).single(), 'loading the organization') as { id: string; name: string; org_type: string }
  if (org.org_type !== 'direct') throw new Error(`"${org.name}" is ${org.org_type}, not a direct business: refusing`)
  const clients = check(await admin.from('clients').select('id, name').eq('organization_id', org.id), 'loading its clients') as { id: string; name: string }[]
  if (clients.length !== 1) throw new Error(`"${org.name}" has ${clients.length} clients, expected exactly one: refusing`)
  if (clients[0].name !== name) throw new Error(`the client is named "${clients[0].name}", not the fixture's "${name}": refusing`)
  const named = check(await admin.from('clients').select('id').eq('name', name), 'looking for the name elsewhere') as { id: string }[]
  if (named.some((c) => c.id !== clients[0].id)) throw new Error('a client of that name exists in another organization too: refusing')
  return clients[0].id
}

type Counts = { conversations: number; messages: number; leads: number; leadEvents: number; aiUsage: number; aiUsageLinked: number }

async function counts(admin: Admin, clientId: string): Promise<Counts> {
  const head = { count: 'exact' as const, head: true }
  return {
    conversations: counted(await admin.from('conversations').select('id', head).eq('client_id', clientId), 'counting conversations'),
    messages: counted(await admin.from('messages').select('id, conversations!inner(client_id)', head).eq('conversations.client_id', clientId), 'counting messages'),
    leads: counted(await admin.from('leads').select('id', head).eq('client_id', clientId), 'counting leads'),
    leadEvents: counted(await admin.from('lead_events').select('id, leads!inner(client_id)', head).eq('leads.client_id', clientId), 'counting lead events'),
    aiUsage: counted(await admin.from('ai_usage').select('id', head).eq('client_id', clientId), 'counting ai_usage'),
    aiUsageLinked: counted(await admin.from('ai_usage').select('id', head).eq('client_id', clientId).not('conversation_id', 'is', null), 'counting linked ai_usage'),
  }
}

function print(label: string, c: Counts) {
  console.log(`
${label}
  conversations   ${c.conversations}   (their messages: ${c.messages})
  leads           ${c.leads}   (their lead events: ${c.leadEvents})
  ai_usage        ${c.aiUsage}   kept, every row; ${c.aiUsageLinked} linked to a conversation (that link becomes null)`)
}

async function main() {
  const { email, write } = args()
  const admin = createAdminClient()
  const name = fixtureClinicName()
  const clientId = await findClinic(admin, email, name)
  console.log(`the review clinic: ${name}\n  client ${clientId}`)

  const before = await counts(admin, clientId)
  print(write ? 'deleting:' : 'would delete (dry run):', before)
  if (!write) {
    console.log('\ndry run: nothing written. Add --write to delete.')
    return
  }

  // Found again before each delete: the id must still be the review clinic's
  if ((await findClinic(admin, email, name)) !== clientId) throw new Error('the clinic changed under the run: refusing')
  check(await admin.from('leads').delete().eq('client_id', clientId).select('id'), 'deleting leads')

  if ((await findClinic(admin, email, name)) !== clientId) throw new Error('the clinic changed under the run: refusing')
  check(await admin.from('conversations').delete().eq('client_id', clientId).select('id'), 'deleting conversations')

  const after = await counts(admin, clientId)
  print('after:', after)
  if (after.aiUsage !== before.aiUsage) throw new Error(`ai_usage changed from ${before.aiUsage} to ${after.aiUsage} rows: it must never be deleted. Stop and report`)
  if (after.conversations !== 0 || after.leads !== 0) throw new Error('rows are left: stop and report')
  console.log('\ndone: the inbox is empty; ai_usage untouched.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
