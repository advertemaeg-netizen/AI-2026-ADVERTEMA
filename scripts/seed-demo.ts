/**
 * Demo account seed (demo/SEED.md): عيادة سمايل كير, a direct business.
 *
 *   npm run seed:demo                 every step, in order
 *   npm run seed:demo -- --step=3     one step (1 account, 2 channels + bot, 3 knowledge, 4 leads)
 *
 * Idempotent: a second run replaces the demo's own data and nothing else.
 * Every write is scoped to the demo client, which is looked up from the demo
 * user's email and re-checked before anything is deleted.
 * Keys come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
 * GOOGLE_GEMINI_API_KEY) — never from this file.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { loadBotSettings, runBot } from '@/lib/ai/bot'
import { embedTexts } from '@/lib/ai/gemini'
import { cairoDayStart, cairoParts, cairoWallTimeToIso } from '@/lib/cairo-time'
import { prepareKnowledgeChunks, processKnowledgeDocument } from '@/lib/knowledge/process'
import { createAdminClient } from '@/lib/supabase/admin'
import { KNOWLEDGE_BUCKET, KNOWLEDGE_FILE_TYPES } from '@/lib/types/knowledge'
import type { ChannelType } from '@/lib/types/channels'
import type { ConversationStatus, MessageRole } from '@/lib/types/conversations'
import type { LeadStatus } from '@/lib/types/leads'

const ROOT = process.cwd()
const DEMO_DIR = path.join(ROOT, 'demo')

try {
  process.loadEnvFile(path.join(ROOT, '.env.local'))
} catch {
  // already in the environment (CI, a shell that exported them)
}

export const DEMO = {
  email: 'test@advertema.com',
  password: 'demo2026',
  fullName: 'عيادة سمايل كير',
  orgName: 'عيادة سمايل كير لطب وتجميل الأسنان',
  industry: 'طب وتجميل الأسنان',
  description: 'عيادة أسنان في القاهرة بفرعين: المعادي والتجمع الخامس.',
  plan: {
    slug: 'demo',
    name: 'Demo',
    name_ar: 'ديمو',
    plan_type: 'business',
    price_monthly: 0,
    // Low on purpose: visitors trying the demo must not burn AI credit
    messages_limit: 300,
    channels_limit: 6,
    team_members_limit: 2,
    knowledge_docs_limit: 10,
    knowledge_chunks_limit: 200,
    max_file_size_mb: 2,
    // Hidden from every other client's plan picker
    is_active: false,
    sort_order: 99,
    features: [],
  },
} as const

export type Admin = ReturnType<typeof createAdminClient>
export type DemoContext = { userId: string; orgId: string; clientId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The result's data, or a throw naming what failed. (Writes without a select return null data.) */
function check<T>(result: { data: T; error: { message: string } | null }, what: string) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`)
  return result.data as NonNullable<T>
}

// ---------------------------------------------------------------------------
// The demo account, and the guard every delete goes through
// ---------------------------------------------------------------------------

/** The demo's ids from its email, or null before step 1. Refuses anything that isn't a direct business. */
export async function findDemo(admin: Admin): Promise<DemoContext | null> {
  const user = check(
    await admin.from('users').select('id, role, organization_id').eq('email', DEMO.email).maybeSingle(),
    'loading the demo user'
  )
  if (!user) return null
  if (user.role !== 'org_admin' || !user.organization_id) {
    throw new Error(`${DEMO.email} exists but is not the owner of an organization (role ${user.role})`)
  }

  const org = check(
    await admin.from('organizations').select('id, name, org_type').eq('id', user.organization_id).single(),
    'loading the demo organization'
  )
  if (org.org_type !== 'direct' || org.name !== DEMO.orgName) {
    throw new Error(`${DEMO.email} belongs to "${org.name}" (${org.org_type}), not the demo business`)
  }

  const clients = check(
    await admin.from('clients').select('id').eq('organization_id', org.id),
    'loading the demo client'
  )
  if (clients.length !== 1) throw new Error(`the demo organization has ${clients.length} clients, expected 1`)
  return { userId: user.id, orgId: org.id, clientId: clients[0].id }
}

/** Looks the demo up again and refuses to go on if `clientId` isn't its client. */
export async function assertDemoClient(admin: Admin, clientId: string) {
  if (!UUID.test(clientId)) throw new Error('refusing to delete: no demo client id')
  const demo = await findDemo(admin)
  if (!demo || demo.clientId !== clientId) throw new Error(`refusing to delete: ${clientId} is not the demo client`)
}

/** The only delete in these scripts: always `where client_id = <the demo client>`. */
async function deleteByClient(admin: Admin, table: 'leads' | 'conversations' | 'knowledge_documents' | 'usage_alerts', clientId: string) {
  await assertDemoClient(admin, clientId)
  const { error, count } = await admin.from(table).delete({ count: 'exact' }).eq('client_id', clientId)
  if (error) throw new Error(`deleting ${table}: ${error.message}`)
  console.log(`  delete from ${table} where client_id = '${clientId}'  → ${count ?? 0} rows`)
}

// ---------------------------------------------------------------------------
// Step 1: account, organization, client, plan
// ---------------------------------------------------------------------------

async function findAuthUser(admin: Admin) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listing auth users: ${error.message}`)
    const user = data.users.find((u) => u.email?.toLowerCase() === DEMO.email)
    if (user) return user
    if (data.users.length < 200) return null
  }
}

export async function seedAccount(admin: Admin): Promise<DemoContext> {
  console.log('\n[1] account + organization + client')

  const plan = check(
    await admin.from('plans').upsert(DEMO.plan, { onConflict: 'slug' }).select('id').single(),
    'creating the demo plan'
  )

  const existing = await findAuthUser(admin)
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password: DEMO.password, email_confirm: true })
    if (error) throw new Error(`resetting the demo password: ${error.message}`)
    console.log(`  auth user exists (${existing.id}); password reset`)
  } else {
    // Same metadata as the sign-up page: handle_new_user creates the direct
    // organization, its one client and the owner's membership
    const { data, error } = await admin.auth.admin.createUser({
      email: DEMO.email,
      password: DEMO.password,
      email_confirm: true,
      user_metadata: { full_name: DEMO.fullName, organization_name: DEMO.orgName, org_type: 'direct' },
    })
    if (error) throw new Error(`creating the demo user: ${error.message}`)
    console.log(`  auth user created (${data.user.id})`)
  }

  const demo = await findDemo(admin)
  if (!demo) throw new Error('the sign-up trigger did not create the demo profile')

  check(
    await admin.from('clients').update({ industry: DEMO.industry, description: DEMO.description }).eq('id', demo.clientId),
    'updating the demo client'
  )

  const now = new Date()
  const nextYear = new Date(now)
  nextYear.setFullYear(now.getFullYear() + 1)
  check(
    await admin
      .from('client_subscriptions')
      .update({
        plan_id: plan.id,
        status: 'active',
        trial_ends_at: null,
        current_period_start: now.toISOString(),
        current_period_end: nextYear.toISOString(),
      })
      .eq('client_id', demo.clientId),
    'moving the demo client to the demo plan'
  )
  return demo
}

// ---------------------------------------------------------------------------
// Step 2: channels + bot settings
// ---------------------------------------------------------------------------

const CHANNEL_NAMES: Record<ChannelType, string> = {
  website: 'ويدجت الموقع',
  whatsapp: 'واتساب العيادة',
  facebook: 'صفحة فيسبوك',
  instagram: 'إنستجرام',
}

/** Missing channels are added; existing ones keep their id (the widget's embed code holds it). */
export async function seedChannels(admin: Admin, demo: DemoContext) {
  console.log('\n[2a] channels')
  const existing = check(
    await admin.from('channels').select('id, type').eq('client_id', demo.clientId),
    'loading channels'
  ) as { id: string; type: ChannelType }[]

  for (const type of Object.keys(CHANNEL_NAMES) as ChannelType[]) {
    if (existing.some((c) => c.type === type)) continue
    const id = randomUUID()
    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
    check(
      await admin.from('channels').insert({
        id,
        client_id: demo.clientId,
        type,
        name: CHANNEL_NAMES[type],
        is_active: true,
        ...(type === 'website'
          ? { webhook_url: origin ? `${origin}/api/webhook/website/${id}` : null }
          : // Not connected to anything: shown so leads from it display correctly
            { credentials: { demo: true } }),
      }),
      `creating the ${type} channel`
    )
  }

  const channels = check(
    await admin.from('channels').select('id, type, name, is_active, credentials').eq('client_id', demo.clientId),
    'loading channels'
  ) as { id: string; type: ChannelType; name: string; is_active: boolean; credentials: unknown }[]
  for (const c of channels) console.log(`  ${c.type.padEnd(9)} ${c.id}  ${c.name}${c.credentials ? '  (demo, no token)' : ''}`)
  return channels
}

/** demo/bot-settings.md → its fields. Throws when a field can't be found rather than guess. */
function parseBotSettings() {
  const md = readFileSync(path.join(DEMO_DIR, 'bot-settings.md'), 'utf8')
  const need = (match: RegExpMatchArray | null, what: string) => {
    const value = match?.[1]?.trim()
    if (!value) throw new Error(`bot-settings.md: ${what} not found`)
    return value
  }
  const quote = (label: string) =>
    need(md.match(new RegExp(`\\*\\*${label}[^\\n]*\\n((?:> ?[^\\n]*\\n?)+)`)), label)
      .split('\n')
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n')
      .trim()

  return {
    name: need(md.match(/\*\*اسم البوت:\*\*\s*(.+)/), 'bot name'),
    welcome: quote('رسالة الترحيب'),
    prompt: need(md.match(/```\n([\s\S]*?)```/), 'system prompt'),
    keywords: need(md.match(/لتحويل الفوري للفريق البشري:\*\*\s*\n(.+)/), 'handoff keywords')
      .split('·')
      .map((k) => k.trim())
      .filter(Boolean),
    outOfHours: quote('رسالة خارج مواعيد العمل'),
    autoConfirm: /auto_confirm_appointments[^\n]*مُفعَّل/.test(md),
  }
}

export async function seedBotSettings(admin: Admin, demo: DemoContext) {
  console.log('\n[2b] bot settings')
  const bot = parseBotSettings()

  // bot_settings has no columns for the bot's name, the handoff keywords or
  // the out-of-hours message, so they go into the prompt
  const systemPrompt = [
    bot.prompt,
    `اسمك: ${bot.name}.`,
    `التحويل للفريق: لو رسالة المريض فيها أي حاجة من دول (${bot.keywords.join('، ')}) متحاولش تحلّها بنفسك — قول له إنك هتحوّله للفريق فوراً.`,
    `لو المريض كتب والعيادة مقفولة، استخدم الرسالة دي:\n${bot.outOfHours}`,
  ].join('\n\n')

  const settings = {
    client_id: demo.clientId,
    system_prompt: systemPrompt,
    tone: 'friendly',
    language: 'ar',
    // The default, like any real client: the demo shows the product as it is
    temperature: 0.7,
    max_response_length: 500,
    welcome_message: bot.welcome,
    // A clinic: someone in pain must be left with a number, not only "wait for the team"
    fallback_message:
      'المعلومة دي مش عندي دلوقتي — هوصّلها للفريق وهيردّوا عليك في أقرب وقت. ولو الموضوع مستعجل، اتصل على 02-25201184.',
    // A dental clinic: when the assistant is down the patient still needs a number
    service_unavailable_message: [
      'فيه ضغط على النظام دلوقتي ومش قادر أرد. الفريق هيشوف رسالتك ويرد عليك قريب.',
      'للحجز والاستفسار: 02-25201184',
      'ولو عندك ألم شديد أو طوارئ: 01002847562',
    ].join('\n'),
    lead_qualification_enabled: true,
    auto_confirm_appointments: bot.autoConfirm,
    // Two branches with different hours don't fit one schedule; the hours are in the knowledge base
    business_hours: null,
  }
  check(await admin.from('bot_settings').upsert(settings, { onConflict: 'client_id' }), 'saving bot settings')
  console.log(`  system prompt ${systemPrompt.length} chars, welcome ${bot.welcome.length} chars, ${bot.keywords.length} handoff keywords, auto-confirm ${bot.autoConfirm}`)
}

// ---------------------------------------------------------------------------
// Step 3: knowledge base, through the app's own chunking and embedding
// ---------------------------------------------------------------------------

const EMBED_DELAY_MS = 2000
const EMBED_RETRIES = 6

/** embedTexts, one chunk per request with a pause between them (Gemini free tier), backing off on 429. */
const embedSlowly: typeof embedTexts = async (texts, taskType, usage) => {
  const vectors: number[][] = []
  for (const [i, text] of texts.entries()) {
    if (i > 0) await sleep(EMBED_DELAY_MS)
    for (let attempt = 1; ; attempt++) {
      try {
        vectors.push(...(await embedTexts([text], taskType, usage)))
        break
      } catch (error) {
        const rateLimited = error instanceof Error && error.message.includes('(429)')
        if (!rateLimited || attempt >= EMBED_RETRIES) throw error
        const wait = 10_000 * 2 ** (attempt - 1)
        console.log(`    429 on chunk ${i + 1}/${texts.length}; retry ${attempt}/${EMBED_RETRIES - 1} in ${wait / 1000}s`)
        await sleep(wait)
      }
    }
    console.log(`    chunk ${i + 1}/${texts.length} embedded`)
  }
  return vectors
}

async function withRateLimitRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      // The chat call gives up after 30s; on the free tier that happens now and then
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      const rateLimited = error instanceof Error && error.message.includes('(429)')
      if ((!rateLimited && !timedOut) || attempt >= EMBED_RETRIES) throw error
      const wait = 10_000 * 2 ** (attempt - 1)
      console.log(`    ${timedOut ? 'timeout' : '429'} on ${what}; retry in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
}

export async function clearKnowledge(admin: Admin, demo: DemoContext) {
  await assertDemoClient(admin, demo.clientId)
  const docs = check(
    await admin.from('knowledge_documents').select('file_url').eq('client_id', demo.clientId).is('source_document_id', null),
    'loading knowledge files'
  ) as { file_url: string | null }[]
  // Stored as <client_id>/<document_id>.txt: only this client's folder
  const paths = docs.map((d) => d.file_url).filter((p): p is string => !!p && p.startsWith(`${demo.clientId}/`))
  if (paths.length > 0) {
    const { error } = await admin.storage.from(KNOWLEDGE_BUCKET).remove(paths)
    if (error) throw new Error(`removing knowledge files: ${error.message}`)
  }
  // Chunks are rows of the same table and go with it
  await deleteByClient(admin, 'knowledge_documents', demo.clientId)
}

export async function seedKnowledge(admin: Admin, demo: DemoContext) {
  console.log('\n[3] knowledge base')
  await clearKnowledge(admin, demo)

  const files = readdirSync(path.join(DEMO_DIR, 'kb')).filter((f) => f.endsWith('.md')).sort()
  for (const file of files) {
    const buffer = readFileSync(path.join(DEMO_DIR, 'kb', file))
    // The app takes pdf/docx/txt; markdown is plain text
    const prepared = await prepareKnowledgeChunks('txt', buffer)
    if (!prepared.ok) throw new Error(`${file}: ${prepared.error}`)

    const id = randomUUID()
    const heading = buffer.toString('utf8').match(/^#\s+(.+)$/m)?.[1]?.trim()
    const title = `${heading ?? file.replace(/\.md$/, '')}.txt`.slice(0, 200)
    const storagePath = `${demo.clientId}/${id}.txt`
    console.log(`  ${file} → "${title}" (${prepared.chunks.length} chunks)`)

    const { error: storageError } = await admin.storage
      .from(KNOWLEDGE_BUCKET)
      .upload(storagePath, buffer, { contentType: KNOWLEDGE_FILE_TYPES.txt, upsert: false })
    if (storageError) throw new Error(`${file}: storing the file: ${storageError.message}`)

    check(
      await admin.from('knowledge_documents').insert({
        id,
        client_id: demo.clientId,
        title,
        file_url: storagePath,
        file_type: 'txt',
        file_size: buffer.length,
        status: 'processing',
      }),
      `${file}: creating the document`
    )

    await processKnowledgeDocument(admin, { id, client_id: demo.clientId, title, file_type: 'txt' }, prepared.chunks, embedSlowly)

    // processKnowledgeDocument never throws: it marks the document instead
    const doc = check(
      await admin.from('knowledge_documents').select('status, chunk_count, error_message').eq('id', id).single(),
      `${file}: reading the document back`
    )
    if (doc.status !== 'ready') throw new Error(`${file}: processing failed (${doc.error_message})`)
    await sleep(EMBED_DELAY_MS)
  }
}

/** Every chunk's first and last two lines, to see where the files were cut. */
export async function printChunks(admin: Admin, demo: DemoContext) {
  const chunks = check(
    await admin
      .from('knowledge_documents')
      .select('title, chunk_index, content, created_at')
      .eq('client_id', demo.clientId)
      .not('source_document_id', 'is', null)
      .order('created_at')
      .order('chunk_index'),
    'loading chunks'
  ) as { title: string; chunk_index: number; content: string }[]

  console.log(`\n${chunks.length} chunks`)
  chunks.forEach((chunk, i) => {
    const lines = chunk.content.split('\n').filter((line) => line.trim())
    console.log(`\n── ${i + 1}. ${chunk.title} #${chunk.chunk_index} (${chunk.content.length} chars, ${lines.length} lines)`)
    console.log(lines.slice(0, 2).join('\n'))
    console.log('   …')
    console.log(lines.slice(-2).join('\n'))
  })
}

const RETRIEVAL_QUESTIONS: [question: string, expected: string][] = [
  ['الزرعة بكام؟', '18000 كورية / 25000 سويسرية — شاملة التاج'],
  ['العدسات بكام؟', '6500 للسن، و10 أسنان بخصم 10%'],
  ['بتفتحوا الجمعة؟', 'المعادي أيوه 3–10 مساءً، التجمع مقفول'],
  ['الضمان على الزيركون؟', '5 سنين'],
  ['عندكم فرع في مدينة نصر؟', 'لأ، فرعين بس: المعادي والتجمع'],
  ['التأمين بيغطي التقويم؟', 'يطلب صورة الكارنيه ويحوّل للفريق — مش أيوه أو لأ'],
]

/**
 * The six questions of SEED.md through the widget's own bot (runBot), as a
 * playground call: no conversation is left behind and none of the 300
 * messages is used.
 */
export async function testRetrieval(admin: Admin, demo: DemoContext) {
  console.log('\n[3] retrieval test')
  const client = check(
    await admin.from('clients').select('name, industry, description').eq('id', demo.clientId).single(),
    'loading the client'
  )
  const settings = await loadBotSettings(admin, demo.clientId)

  for (const [question, expected] of RETRIEVAL_QUESTIONS) {
    const result = await withRateLimitRetry(question, () =>
      runBot({
        supabase: admin,
        clientId: demo.clientId,
        client,
        settings,
        history: [{ role: 'user', content: question }],
        operation: 'playground',
      })
    )
    console.log(`\nQ: ${question}\n   expected: ${expected}`)
    console.log(`   reply: ${result.reply.replace(/\n/g, '\n          ')}`)
    console.log(
      `   chunks: ${
        result.debug.retrievalError
          ? 'RETRIEVAL FAILED'
          : result.debug.chunks
              .map((c) => `${c.used ? '✓' : '·'} ${c.title} #${c.chunk_index} (${c.similarity.toFixed(2)})`)
              .join(' | ')
      }`
    )
    await sleep(EMBED_DELAY_MS)
  }
}

// ---------------------------------------------------------------------------
// Step 4: leads, conversations, appointments
// ---------------------------------------------------------------------------

type SeedLead = {
  ref: string
  name: string
  phone: string
  channel: ChannelType
  branch: string
  service: string
  budget_egp: number | null
  status: 'new' | 'contacted' | 'appointment_set' | 'showed_up' | 'no_show' | 'lost'
  created_day_offset: number
  appointment: { day_offset: number; time: string; attended: boolean | null } | null
  notes: string | null
  conversation: { role: 'user' | 'bot' | 'agent'; minute_offset: number; text: string }[]
}

const STATUS: Record<SeedLead['status'], LeadStatus> = {
  new: 'new',
  contacted: 'contacted',
  appointment_set: 'appointment_booked',
  showed_up: 'showed_up',
  no_show: 'no_show',
  lost: 'lost',
}

const ROLE: Record<SeedLead['conversation'][number]['role'], MessageRole> = {
  user: 'user',
  bot: 'assistant',
  agent: 'agent',
}

const CONVERSATION_STATUS: Record<LeadStatus, ConversationStatus> = {
  new: 'in_progress',
  contacted: 'in_progress',
  appointment_booked: 'converted',
  showed_up: 'converted',
  no_show: 'converted',
  lost: 'closed',
}

const MINUTE = 60_000
const pad = (n: number) => String(n).padStart(2, '0')

/** A Cairo wall-clock time on the day `dayOffset` days from `now`. */
function cairoTimeOn(dayOffset: number, time: string, now: Date) {
  const day = cairoParts(cairoDayStart(dayOffset, now))
  return new Date(cairoWallTimeToIso(day.year, day.month, day.day, time))
}

// Today's appointments are still ahead whenever the script runs: the first
// in 90 minutes, the second in 3 hours
const TODAY_APPOINTMENTS_IN_MINUTES = [90, 180]

// Each branch's opening hours (Cairo), null = closed.
// Must match demo/kb/03-hours-location.md: change both together.
type Weekday = 'Sat' | 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri'
type OpenHours = [open: string, close: string] | null
const week = (satToThu: OpenHours, fri: OpenHours): Record<Weekday, OpenHours> => ({
  Sat: satToThu, Sun: satToThu, Mon: satToThu, Tue: satToThu, Wed: satToThu, Thu: satToThu, Fri: fri,
})
const BRANCH_HOURS: Record<string, Record<Weekday, OpenHours>> = {
  'المعادي': week(['12:00', '22:00'], ['15:00', '22:00']),
  'التجمع الخامس': week(['13:00', '22:00'], null),
}
// The day's last appointment starts this long before closing
const LAST_APPOINTMENT_BEFORE_CLOSE = 30

const cairoWeekday = (date: Date) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Africa/Cairo' }).format(date) as Weekday

/**
 * `at` if its branch is open then, otherwise the nearest time it is: later
 * ('forward', for appointments still to come) or earlier ('backward', so a
 * past appointment stays in the past). day_offset is fixed but its weekday
 * changes with every run, so any appointment can land on a closed day.
 */
export function snapToBranchHours(at: Date, branch: string, direction: 'forward' | 'backward') {
  const hours = BRANCH_HOURS[branch]
  if (!hours) throw new Error(`no opening hours for branch "${branch}"`)
  const day = cairoParts(at)

  for (let i = 0; i <= 7; i++) {
    const on = (time: string) =>
      new Date(cairoWallTimeToIso(day.year, day.month, day.day + (direction === 'forward' ? i : -i), time))
    const open = hours[cairoWeekday(on('12:00'))]
    if (!open) continue
    const [from, close] = open
    const [closeHours, closeMinutes] = close.split(':').map(Number)
    const lastMinutes = closeHours * 60 + closeMinutes - LAST_APPOINTMENT_BEFORE_CLOSE
    const last = `${pad(Math.floor(lastMinutes / 60))}:${pad(lastMinutes % 60)}`

    // Another day: its nearest end
    if (i > 0) return on(direction === 'forward' ? from : last)
    if (day.time < from) {
      if (direction === 'forward') return on(from)
    } else if (day.time > last) {
      if (direction === 'backward') return on(last)
    } else {
      return at
    }
  }
  throw new Error(`branch "${branch}" is never open`)
}

/**
 * When a seeded appointment is: its day and time from the file, or for
 * today's, counted from now (rounded up to a quarter hour). Then moved into
 * the branch's opening hours if it fell outside them.
 */
function appointmentTime(lead: SeedLead, todayIndex: number, now: Date) {
  const appointment = lead.appointment!
  if (appointment.day_offset < 0) {
    return snapToBranchHours(cairoTimeOn(appointment.day_offset, appointment.time, now), lead.branch, 'backward')
  }
  if (appointment.day_offset > 0) {
    return snapToBranchHours(cairoTimeOn(appointment.day_offset, appointment.time, now), lead.branch, 'forward')
  }
  const minutes = TODAY_APPOINTMENTS_IN_MINUTES[todayIndex] ?? TODAY_APPOINTMENTS_IN_MINUTES.at(-1)!
  const quarter = 15 * MINUTE
  const at = new Date(Math.ceil((now.getTime() + minutes * MINUTE) / quarter) * quarter)
  return snapToBranchHours(at, lead.branch, 'forward')
}

/** "17:00" → "5 مساءً", the way the seeded chats write a time. */
function arabicTime(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const part = hours < 12 ? 'صباحاً' : hours < 15 ? 'ظهراً' : hours < 16 ? 'عصراً' : 'مساءً'
  return `${hours % 12 || 12}${minutes ? `:${pad(minutes)}` : ''} ${part}`
}

/** Everything the demo's visitors and this seed left behind. Knowledge, channels and the account stay. */
export async function clearLeadData(admin: Admin, demo: DemoContext) {
  // lead_events go with their lead, messages with their conversation
  await deleteByClient(admin, 'leads', demo.clientId)
  await deleteByClient(admin, 'conversations', demo.clientId)
  await deleteByClient(admin, 'usage_alerts', demo.clientId)
  // ai_usage stays: the cost was real. Reports that need the demo out filter on its organization.

  await assertDemoClient(admin, demo.clientId)
  check(
    await admin
      .from('client_subscriptions')
      .update({ messages_used: 0, lead_capture_used: 0, messages_period_start: new Date().toISOString() })
      .eq('client_id', demo.clientId),
    'resetting the message counter'
  )
  console.log(`  update client_subscriptions set messages_used = 0, lead_capture_used = 0 where client_id = '${demo.clientId}'`)
}

export async function seedLeads(admin: Admin, demo: DemoContext) {
  console.log('\n[4] leads + conversations + appointments')
  await clearLeadData(admin, demo)

  const { leads } = JSON.parse(readFileSync(path.join(DEMO_DIR, 'leads.json'), 'utf8')) as { leads: SeedLead[] }
  const channels = check(
    await admin.from('channels').select('id, type').eq('client_id', demo.clientId),
    'loading channels'
  ) as { id: string; type: ChannelType }[]

  const now = new Date()
  // Nothing in the past may be dated after this; events the trigger writes
  // during the run are dated after it, which is how they're found again
  const latest = now.getTime() - MINUTE

  // Today's appointments, earliest first: they're timed from now (see appointmentTime)
  const todays = leads
    .filter((l) => l.appointment?.day_offset === 0)
    .sort((x, y) => x.appointment!.time.localeCompare(y.appointment!.time))

  for (const [index, lead] of leads.entries()) {
    const channel = channels.find((c) => c.type === lead.channel)
    if (!channel) throw new Error(`${lead.ref}: no ${lead.channel} channel (run step 2 first)`)

    const appointmentAt = lead.appointment ? appointmentTime(lead, todays.indexOf(lead), now) : null
    // The first sitting; a few conversations pick up again days later
    const session = Math.max(...lead.conversation.filter((m) => m.minute_offset <= 180).map((m) => m.minute_offset))

    // Spread over the day (10:00–21:00 Cairo), the same on every run
    const minuteOfDay = 10 * 60 + ((index + 1) * 137) % (11 * 60)
    let start = cairoTimeOn(lead.created_day_offset, `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`, now).getTime()
    // Today's chats have already happened, most recent last
    start = Math.min(start, latest - (session + 10 + (leads.length - index) * 7) * MINUTE)
    // …and a booking is made before its appointment
    if (appointmentAt) start = Math.min(start, appointmentAt.getTime() - (session + 90) * MINUTE)

    const at = (minuteOffset: number) => new Date(Math.min(start + minuteOffset * MINUTE, latest))

    const conversation = check(
      await admin
        .from('conversations')
        .insert({
          client_id: demo.clientId,
          channel_id: channel.id,
          external_conversation_id: `demo-${lead.ref}`,
          contact_name: lead.name,
          contact_identifier: lead.channel === 'whatsapp' ? lead.phone : `demo_${lead.ref}_visitor`,
          status: CONVERSATION_STATUS[STATUS[lead.status]],
          created_at: at(0).toISOString(),
        })
        .select('id')
        .single(),
      `${lead.ref}: creating the conversation`
    )

    // The bot's confirmation quotes the appointment's time: keep it true when the time moved
    const quoted = lead.appointment ? `الساعة ${arabicTime(lead.appointment.time)}` : null
    const actual = appointmentAt ? `الساعة ${arabicTime(cairoParts(appointmentAt).time)}` : null
    const text = (original: string) => (quoted && actual && quoted !== actual ? original.replaceAll(quoted, actual) : original)

    const messages = check(
      await admin
        .from('messages')
        .insert(
          lead.conversation.map((m, i) => ({
            conversation_id: conversation.id,
            role: ROLE[m.role],
            content: text(m.text),
            sender_id: m.role === 'agent' ? demo.userId : null,
            // Seconds keep two messages of the same minute in order
            created_at: new Date(at(m.minute_offset).getTime() + i * 1000).toISOString(),
          }))
        )
        .select('id, role, created_at'),
      `${lead.ref}: creating the messages`
    ) as { id: string; role: MessageRole; created_at: string }[]
    const firstUserMessage = messages.filter((m) => m.role === 'user').sort((a, b) => a.created_at.localeCompare(b.created_at))[0]

    // The lead starts as 'new' and is walked through each status, so the
    // record_lead_events trigger writes the timeline itself
    let clock = at(1).getTime()
    const created = check(
      await admin
        .from('leads')
        .insert({
          client_id: demo.clientId,
          conversation_id: conversation.id,
          source_message_id: firstUserMessage?.id ?? null,
          service_requested: lead.service,
          status: 'new',
          created_at: new Date(clock).toISOString(),
        })
        .select('id')
        .single(),
      `${lead.ref}: creating the lead`
    )

    /**
     * The trigger dates its events now() and, for the service role, leaves
     * the actor empty (shown as the assistant). Move the ones it just wrote
     * to the step's time, and to the team member when a person did the step.
     */
    const dateNewEvents = async (by: 'assistant' | 'team' = 'assistant') =>
      check(
        await admin
          .from('lead_events')
          .update({ created_at: new Date(clock).toISOString(), ...(by === 'team' ? { actor_id: demo.userId } : {}) })
          .eq('lead_id', created.id)
          .gt('created_at', new Date(latest).toISOString()),
        `${lead.ref}: dating the events`
      )
    const step = async (when: number, changes: Record<string, unknown>, by: 'assistant' | 'team' = 'assistant') => {
      clock = Math.max(Math.min(when, latest), clock + 1000)
      check(await admin.from('leads').update(changes).eq('id', created.id).eq('client_id', demo.clientId), `${lead.ref}: updating the lead`)
      await dateNewEvents(by)
    }

    await dateNewEvents()
    // Details arrive as the chat ends
    const status = STATUS[lead.status]
    await step(at(session).getTime(), {
      name: lead.name,
      phone: lead.phone,
      branch: lead.branch,
      budget: lead.budget_egp == null ? null : `${lead.budget_egp} جنيه`,
      ...(status === 'new' ? { notes: lead.notes } : {}),
    })

    if (status !== 'new') {
      const contactedAt = at(session + 20)
      // Reception calls back and writes the note
      await step(contactedAt.getTime(), { status: 'contacted', last_contacted_at: contactedAt.toISOString(), notes: lead.notes }, 'team')
    }
    if (appointmentAt) {
      // Confirmed in the same update: the attendance trigger would otherwise unconfirm it
      await step(at(session + 30).getTime(), {
        status: 'appointment_booked',
        appointment_at: appointmentAt.toISOString(),
        appointment_confirmed: true,
      })
    }
    if (status === 'showed_up') {
      // Attendance and a lost lead are recorded by a person, never by the assistant
      await step(appointmentAt!.getTime() + 5 * MINUTE, { status, arrival_confirmed_at: appointmentAt!.toISOString() }, 'team')
    } else if (status === 'no_show') {
      await step(appointmentAt!.getTime() + 60 * MINUTE, { status }, 'team')
    } else if (status === 'lost') {
      await step(at(session + 2 * 24 * 60).getTime(), { status }, 'team')
    }

    const when = appointmentAt ? cairoParts(appointmentAt) : null
    const moved = when && (lead.appointment!.day_offset === 0 || when.time !== lead.appointment!.time || when.dateKey !== cairoParts(cairoDayStart(lead.appointment!.day_offset, now)).dateKey)
    console.log(
      `  ${lead.ref} ${status.padEnd(18)} ${lead.channel.padEnd(9)} ${lead.conversation.length} messages` +
        (when ? `  ${cairoWeekday(appointmentAt!)} ${when.dateKey} ${when.time} ${lead.branch}${moved ? `  (file: day ${lead.appointment!.day_offset} ${lead.appointment!.time})` : ''}` : '')
    )
  }
}

/** Counts and the checks SEED.md asks for after seeding. */
export async function verifyLeads(admin: Admin, demo: DemoContext) {
  console.log('\n[4] verification')
  const leads = check(
    await admin
      .from('leads')
      .select('id, status, appointment_at, appointment_confirmed, showed_up, arrival_confirmed_at, conversation_id')
      .eq('client_id', demo.clientId),
    'loading leads'
  ) as {
    id: string
    status: LeadStatus
    appointment_at: string | null
    appointment_confirmed: boolean
    showed_up: boolean | null
    arrival_confirmed_at: string | null
    conversation_id: string
  }[]

  const byStatus: Record<string, number> = {}
  for (const lead of leads) byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1
  console.log(`  leads: ${leads.length}`, byStatus)

  const conversationIds = leads.map((l) => l.conversation_id)
  const { count: messages } = await admin.from('messages').select('id', { count: 'exact', head: true }).in('conversation_id', conversationIds)
  console.log(`  conversations: ${new Set(conversationIds).size}, messages: ${messages}`)

  const now = new Date()
  const today = cairoParts(now).dateKey
  const tomorrow = cairoParts(cairoDayStart(1, now)).dateKey
  const appointments = leads.filter((l) => l.appointment_at)
  const on = (key: string) => appointments.filter((l) => cairoParts(l.appointment_at!).dateKey === key).length
  console.log(`  appointments: ${appointments.length} (today ${on(today)}, tomorrow ${on(tomorrow)}, unconfirmed ${appointments.filter((l) => !l.appointment_confirmed).length})`)

  const attended = leads.filter((l) => l.status === 'showed_up')
  const intact = attended.filter((l) => l.showed_up === true && l.arrival_confirmed_at)
  console.log(`  showed_up: ${attended.length}, with showed_up = true and arrival_confirmed_at: ${intact.length}`)
  console.log(`  no_show with showed_up = false: ${leads.filter((l) => l.status === 'no_show' && l.showed_up === false).length}`)

  const events = check(
    await admin.from('lead_events').select('event_type, created_at').in('lead_id', leads.map((l) => l.id)),
    'loading events'
  ) as { event_type: string; created_at: string }[]
  const byType: Record<string, number> = {}
  for (const event of events) byType[event.event_type] = (byType[event.event_type] ?? 0) + 1
  console.log(`  events: ${events.length}`, byType)
  console.log(`  events dated in the future: ${events.filter((e) => new Date(e.created_at) > now).length}`)
  if (!byType.details_updated) console.log('  !! no details_updated event: the array_append fix is not live')
}

// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--step='))?.split('=')[1] ?? 'all'
  const wants = (step: string) => arg === 'all' || arg === step
  const admin = createAdminClient()
  console.log(`database: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`)

  const demo = wants('1') ? await seedAccount(admin) : await findDemo(admin)
  if (!demo) throw new Error('the demo account does not exist yet: run step 1 first')
  console.log(`  user ${demo.userId}\n  organization ${demo.orgId}\n  client ${demo.clientId}`)

  if (wants('2')) {
    await seedChannels(admin, demo)
    await seedBotSettings(admin, demo)
  }
  if (wants('3')) {
    await seedKnowledge(admin, demo)
    await printChunks(admin, demo)
    await testRetrieval(admin, demo)
  }
  if (arg === 'chunks') await printChunks(admin, demo)
  if (arg === 'retrieval') await testRetrieval(admin, demo)
  if (wants('4')) {
    await seedLeads(admin, demo)
    await verifyLeads(admin, demo)
  }
}

if (process.argv[1]?.endsWith('seed-demo.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
