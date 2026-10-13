/**
 * Lists every lead whose name or phone number does not pass the rules the
 * assistant now applies before it stores them (src/lib/ai/contact.ts,
 * src/lib/phone.ts), grouped by client.
 *
 *   npm run audit:leads
 *
 * READ-ONLY: it selects and prints, and has no flag that writes. Nothing is
 * corrected here, and no correction is guessed for a number that can't be
 * normalised — what to do with these rows is decided by a person who has
 * seen the list.
 *
 * It prints names and phone numbers, to the terminal only: don't redirect
 * the output into the repository.
 *
 * Phone numbers fall into three kinds:
 *   convertible   a real number in an older format ("01003462718"): the
 *                 E.164 value is shown, and the conversion loses nothing
 *   not a number  nothing the app accepts can be read from it
 *   (missing)     no number at all
 * A name is reported when it is not a full name: fewer than two words, a
 * one-letter word, or anything but letters. Leads the assistant flagged
 * itself (name_incomplete) are marked as such.
 */
import path from 'node:path'
import { validateName } from '@/lib/ai/contact'
import { normalizePhone } from '@/lib/phone'
import { createAdminClient } from '@/lib/supabase/admin'

try {
  process.loadEnvFile(path.join(process.cwd(), '.env.local'))
} catch {
  // already in the environment
}

type Lead = {
  id: string
  client_id: string
  name: string | null
  phone: string | null
  status: string
  created_at: string
  ai_extracted_data: { name_incomplete?: boolean } | null
}

function phoneFinding(phone: string | null) {
  if (!phone) return 'phone missing'
  const normalized = normalizePhone(phone)
  if (!normalized) return `phone "${phone}" is not a number the app accepts`
  return normalized === phone ? null : `phone "${phone}" is convertible → ${normalized}`
}

function nameFinding(lead: Lead) {
  if (!lead.name?.trim()) return 'name missing'
  if (validateName(lead.name)) return null
  return `name "${lead.name}" is not a full name${lead.ai_extracted_data?.name_incomplete ? ' (flagged name_incomplete)' : ''}`
}

async function main() {
  const admin = createAdminClient()
  console.log(`database: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host} (read-only)\n`)

  const { data: clients, error: clientsError } = await admin.from('clients').select('id, name')
  if (clientsError) throw new Error(`loading clients: ${clientsError.message}`)
  const { data, error } = await admin
    .from('leads')
    .select('id, client_id, name, phone, status, created_at, ai_extracted_data')
    .order('created_at', { ascending: true })
    .returns<Lead[]>()
  if (error) throw new Error(`loading leads: ${error.message}`)

  const totals = { leads: data.length, failing: 0, convertible: 0, notANumber: 0, phoneMissing: 0, name: 0 }
  for (const client of clients ?? []) {
    const leads = data.filter((lead) => lead.client_id === client.id)
    const rows = leads
      .map((lead) => ({ lead, findings: [nameFinding(lead), phoneFinding(lead.phone)].filter((f): f is string => f !== null) }))
      .filter((row) => row.findings.length > 0)
    console.log(`${client.name} — ${leads.length} lead(s), ${rows.length} failing`)
    for (const { lead, findings } of rows) {
      totals.failing += 1
      for (const finding of findings) {
        if (finding.includes('convertible')) totals.convertible += 1
        else if (finding.includes('not a number')) totals.notANumber += 1
        else if (finding === 'phone missing') totals.phoneMissing += 1
        else totals.name += 1
      }
      console.log(`  ${lead.id}  ${lead.created_at.slice(0, 10)}  ${lead.status.padEnd(18)} ${findings.join(' · ')}`)
    }
    console.log('')
  }

  console.log(
    `${totals.leads} leads, ${totals.failing} failing — phones: ${totals.convertible} convertible, ${totals.notANumber} not a number, ` +
      `${totals.phoneMissing} missing · names: ${totals.name} missing or not a full name`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
