/**
 * The Meta App Review clinic (scripts/fixtures/review-clinic.md): عيادة
 * الياسمين, an invented dental clinic. Fills in its client's bot settings,
 * branch and seven knowledge documents, exactly as the fixture gives them.
 *
 *   npm run seed:review-clinic -- --email=<the reviewer's login>           dry run: reads, reports, writes nothing
 *   npm run seed:review-clinic -- --email=<the reviewer's login> --write   writes
 *
 *   npm run seed:review-clinic -- --email=<…> --comments=on|off            dry run of the switch alone: was → would be
 *   npm run seed:review-clinic -- --email=<…> --comments=on|off --write    sets the switch, and nothing else
 *
 * THE COMMENT-REPLIES SWITCH IS ITS OWN ACTION. --comments sets
 * clients.comment_replies_enabled for the clinic and writes nothing else: no
 * settings, branch or documents, so turning it off when the review decision
 * comes back cannot also push whatever the fixture says by then. Without
 * --comments nothing touches it, so an existing value is never overwritten
 * by accident. Every run prints its current value with the plan. (The
 * dashboard has no control for it yet; decided 2026-11-08 that it moves to
 * the channel, with a record of who changed it. Until then, this.)
 *
 * IT CREATES NOTHING BUT CONTENT. The login, the organization and the client
 * are made once, by signing up through the app as the reviewer: a direct
 * business, with the client's name from the fixture as the business name
 * (paste it; it has to match byte for byte). Sign-up records the acceptance
 * of the legal pages; a script would not. This fills in that client and
 * refuses anything else. It goes on only when:
 *   1. the email's organization is a direct business,
 *   2. that organization has exactly one client,
 *   3. that client's name is the fixture's, byte for byte,
 *   4. no client of that name exists in any other organization.
 *
 * Order (decided 2026-11-08): sign up; dry run; --write; a super admin
 * activates the client's subscription in the admin area (the trial would
 * otherwise stop the bot inside the review); dry run again to see it active
 * and its message limit. Between recording takes, --write again: what is
 * already right is kept, nothing is duplicated.
 *
 * EVERY ARABIC STRING BELOW IS GENERATED from the fixture by
 * scripts/fixtures/generate-review-clinic.mjs and checked back byte for byte.
 * Never edit them here: change the fixture, run the generator.
 *
 * IDEMPOTENT. Bot settings and the branch are updated in place. A document
 * is kept when one of that title is ready and its stored text is the body
 * here; otherwise that one document is replaced.
 *
 * TOUCHES ONE CLIENT. Every write is filtered by the clinic's id, the clinic
 * is found again before each delete, and the only deletes are one document
 * (and its stored file) at a time: `where client_id = <the clinic> and id =
 * <that document>`. Documents the fixture does not name are left alone.
 *
 * Not written here, on purpose: the login, organization and client (sign-up
 * makes them), channels (connected through the app), the comment-replies
 * switch by a content run (only --comments sets it), the subscription (a
 * super admin activates it), anything on any other client.
 *
 * Keys come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
 * and the embedding provider's key): never from this file.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { prepareKnowledgeChunks, processKnowledgeDocument } from '@/lib/knowledge/process'
import { createAdminClient } from '@/lib/supabase/admin'
import { KNOWLEDGE_BUCKET, KNOWLEDGE_FILE_TYPES } from '@/lib/types/knowledge'
import type { BranchHours } from '@/lib/types/branches'

try {
  process.loadEnvFile(path.join(process.cwd(), '.env.local'))
} catch {
  // already in the environment
}

type Admin = ReturnType<typeof createAdminClient>

// ---------------------------------------------------------------------------
// The content: generated from scripts/fixtures/review-clinic.md, not typed
// ---------------------------------------------------------------------------

// GENERATED from scripts/fixtures/review-clinic.md by generate-review-clinic.mjs; checked back byte for byte. Do not edit by hand.
const CONTENT = {
  "client": {
    "name": "عيادة الياسمين لطب الأسنان — حساب تجريبي",
    "industry": "طب وتجميل الأسنان",
    "description": "عيادة أسنان في القاهرة بتقدّم الكشف والتنظيف والحشو والتقويم وزراعة الأسنان.\nالحساب ده تجريبي، وكل البيانات اللي فيه متخيلة ومش لعيادة حقيقية."
  },
  "bot": {
    "systemPrompt": "انت مساعد عيادة الياسمين لطب الأسنان.\nبتساعد الناس في معرفة الخدمات والأسعار والمواعيد، وبتحجزلهم كشف لو طلبوا.\nاتكلم عربي مصري بسيط ومهذب، وردودك قصيرة.\nلو السؤال عن حالة طبية أو تشخيص، قول إن ده بيتحدد في الكشف ومتديش رأي طبي.\nلو مش عارف المعلومة، قول إنك هتسأل وترد، ومتخترعش حاجة.",
    "welcome": "أهلاً بيك في عيادة الياسمين 🌸 أقدر أساعدك في الأسعار أو المواعيد أو الحجز.",
    "fallback": "معنديش المعلومة دي دلوقتي. هسأل وأرد عليك، أو تقدر تكلّمنا في أي وقت."
  },
  "branch": {
    "name": "فرع المعادي"
  },
  "documents": [
    {
      "title": "١. الخدمات والأسعار",
      "body": "الكشف: ٣٠٠ جنيه، وبيتخصم من تكلفة العلاج لو اتعمل في نفس الزيارة.\nتنظيف وتلميع: ٨٠٠ جنيه.\nحشو عادي: من ٧٠٠ لـ ١٢٠٠ جنيه حسب حجم الحشو.\nحشو عصب: من ٢٥٠٠ لـ ٤٠٠٠ جنيه حسب عدد القنوات.\nتبييض بالليزر: ٤٥٠٠ جنيه للجلسة.\nتقويم معدني: ٣٥٠٠٠ جنيه شامل المتابعة.\nتقويم شفاف: من ٦٥٠٠٠ لـ ٩٠٠٠٠ جنيه حسب عدد الشرائح.\nزراعة سنة: ١٨٠٠٠ جنيه شاملة التاج.\nالأسعار دي تقديرية، والسعر النهائي بيتحدد بعد الكشف والأشعة."
    },
    {
      "title": "٢. المواعيد والعنوان",
      "body": "العيادة في ١٢ شارع النموذج، المعادي، القاهرة.\nتليفون العيادة: ٠١٠٠ ٠٠٠ ٠٠٠٠\nبنشتغل من السبت للخميس، من ١٢ الظهر لـ ٨ بالليل. الجمعة مقفول.\nالكشف بالحجز، والزيارة بتاخد حوالي نص ساعة."
    },
    {
      "title": "٣. طرق الدفع",
      "body": "بنقبل كاش وفيزا وماستر كارد ومحفظة الموبايل.\nالتقويم والزراعة ليهم تقسيط على ٣ أو ٦ أو ١٢ شهر من غير فوايد.\nالتقسيط بيبدأ بمقدّم ٣٠٪، والباقي أقساط شهرية."
    },
    {
      "title": "٤. الحجز والإلغاء",
      "body": "الحجز بيتم من هنا أو بالتليفون.\nالإلغاء أو التأجيل من غير رسوم لو قبل الميعاد بـ ٤ ساعات على الأقل.\nلو الحجز اتلغى بعد كده أو محضرتش، الكشف الجاي بيتحسب كامل.\nبنستنى ١٥ دقيقة بعد الميعاد، وبعدها الدور بيروح للي بعده."
    },
    {
      "title": "٥. الركنة والوصول",
      "body": "فيه جراج مجاني للعيادة في نفس المبنى.\nالعيادة في الدور الأول وفيها أسانسير.\nأقرب محطة مترو: المعادي، وبعدها حوالي ١٠ دقايق مشي."
    },
    {
      "title": "٦. أول زيارة: إيه اللي تجيبه معاك",
      "body": "هات بطاقتك، وأي أشعة أو تقارير قديمة لو عندك.\nلو بتاخد أدوية بانتظام، اكتب أساميها أو هات العلبة معاك.\nلو الزيارة لطفل، لازم يكون معاه حد بالغ.\nاحضر قبل الميعاد بـ ١٠ دقايق عشان الورق."
    },
    {
      "title": "٧. الحالات المستعجلة",
      "body": "لو فيه ألم شديد أو ورم أو نزيف مستمر، كلّمنا على طول وهنحاول نلاقيلك ميعاد في نفس اليوم.\nلو حصل كسر في سنة أو خلعت بعد حادث، احفظها في لبن أو محلول ملح وتعالى فوراً.\nخارج مواعيد العيادة، روح أقرب مستشفى."
    }
  ]
} as const

/**
 * NOT IN THE FIXTURE, and needed (decided 2026-11-08):
 *   tone          the fixture says مهذب وبسيط; the column takes one of four
 *                 English values (friendly, professional, formal, casual).
 *                 'friendly': formal would force Modern Standard Arabic against
 *                 the prompt's Egyptian, casual is too loose for a clinic,
 *                 professional reads cold beside the welcome message. The
 *                 prompt already carries the politeness; the tone carries warmth.
 *   booking_mode  the fixture sets slots and a closed Friday so the bot declines
 *                 a Friday booking; with booking_mode unset, a new client books
 *                 nothing at all ('none'), and that test could not happen.
 */
const TONE = 'friendly'
const BOOKING_MODE = 'appointment'

/** §3's week: السبت to الخميس 12:00–20:00, الجمعة closed */
const OPEN: [string, string][] = [['12:00', '20:00']]
const HOURS: BranchHours = { sat: OPEN, sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: [] }

// ---------------------------------------------------------------------------

function check<T>(result: { data: T; error: { message: string } | null }, what: string) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`)
  return result.data as NonNullable<T>
}

function args() {
  const email = process.argv.find((a) => a.startsWith('--email='))?.slice('--email='.length).trim()
  if (!email || !email.includes('@')) throw new Error('give the reviewer’s login: --email=<email>')
  const comments = process.argv.find((a) => a.startsWith('--comments='))?.slice('--comments='.length)
  if (comments !== undefined && comments !== 'on' && comments !== 'off') throw new Error('--comments takes on or off')
  if (process.argv.some((a) => a === '--comments')) throw new Error('--comments takes a value: --comments=on or --comments=off')
  return { email, write: process.argv.includes('--write'), comments: comments === undefined ? null : comments === 'on' }
}

/** The clinic's comment-replies switch, as stored */
async function commentReplies(admin: Admin, clientId: string) {
  const row = check(await admin.from('clients').select('comment_replies_enabled').eq('id', clientId).single(), 'reading the comment-replies switch') as { comment_replies_enabled: boolean }
  return row.comment_replies_enabled
}

const onOff = (value: boolean) => (value ? 'on' : 'off')

/** --comments: the switch alone. Nothing else is read for writing, nothing else is written */
async function setCommentReplies(admin: Admin, clinic: Clinic, wanted: boolean, write: boolean) {
  const was = await commentReplies(admin, clinic.clientId)
  if (!write) {
    console.log(`
comment replies: ${onOff(was)} → ${onOff(wanted)}${was === wanted ? ' (already)' : ''}`)
    console.log('dry run: nothing written. Add --write to set it.')
    return
  }
  if (was !== wanted) {
    const updated = check(
      await admin.from('clients').update({ comment_replies_enabled: wanted }).eq('id', clinic.clientId).eq('organization_id', clinic.orgId).select('id'),
      'setting the comment-replies switch'
    ) as unknown[]
    if (updated.length !== 1) throw new Error(`expected to set the switch on one client, set it on ${updated.length}`)
  }
  const now = await commentReplies(admin, clinic.clientId)
  console.log(`
comment replies: ${onOff(was)} → ${onOff(now)}${was === now ? ' (unchanged: it already was)' : ''}`)
  if (now !== wanted) throw new Error(`the switch reads ${onOff(now)} after setting it ${onOff(wanted)}`)
}

type Clinic = { clientId: string; orgId: string; orgName: string; userRole: string }

/**
 * The reviewer's clinic, from their email, or a throw saying which of the
 * four checks failed and what was found instead. Read-only.
 */
async function findClinic(admin: Admin, email: string): Promise<Clinic> {
  // Exact, case-insensitive: ilike with the pattern characters escaped, so the email matches itself only
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`)
  const users = check(await admin.from('users').select('id, role, organization_id').ilike('email', pattern), 'looking up the login') as { id: string; role: string; organization_id: string | null }[]
  if (users.length !== 1) throw new Error(`expected one login for ${email}, found ${users.length}. Sign up through the app first`)
  const [user] = users
  if (!user.organization_id) throw new Error(`${email} belongs to no organization`)

  const org = check(await admin.from('organizations').select('id, name, org_type').eq('id', user.organization_id).single(), 'loading the organization') as { id: string; name: string; org_type: string }
  // 1. a direct business
  if (org.org_type !== 'direct') throw new Error(`${email}'s organization "${org.name}" is ${org.org_type}, not a direct business: refusing`)

  // 2. exactly one client
  const clients = check(await admin.from('clients').select('id, name').eq('organization_id', org.id), 'loading the organization’s clients') as { id: string; name: string }[]
  if (clients.length !== 1) throw new Error(`"${org.name}" has ${clients.length} clients, expected exactly one: refusing`)
  const [client] = clients

  // 3. named exactly as the fixture names it
  if (client.name !== CONTENT.client.name) {
    throw new Error(`the client is named\n  "${client.name}"\nnot\n  "${CONTENT.client.name}"\nrefusing: it may not be the review clinic. Rename it in the app to the fixture's name, pasted`)
  }

  // 4. no clinic of that name anywhere else
  const named = check(await admin.from('clients').select('id, organization_id').eq('name', CONTENT.client.name), 'looking for the name elsewhere') as { id: string; organization_id: string }[]
  const elsewhere = named.filter((c) => c.id !== client.id)
  if (elsewhere.length > 0) throw new Error(`a client of that name also exists in organization ${elsewhere[0].organization_id} (client ${elsewhere[0].id}): refusing to fill either`)

  return { clientId: client.id, orgId: org.id, orgName: org.name, userRole: user.role }
}

/** Finds the clinic again and refuses to go on if `clientId` isn't it: before every delete */
async function assertClinic(admin: Admin, email: string, clientId: string) {
  if ((await findClinic(admin, email)).clientId !== clientId) throw new Error(`refusing to delete: ${clientId} is not the review clinic`)
}

type Doc = { id: string; title: string; status: string; file_url: string | null; chunk_count: number | null }

async function sourceDocuments(admin: Admin, clientId: string) {
  return check(
    await admin.from('knowledge_documents').select('id, title, status, file_url, chunk_count').eq('client_id', clientId).is('source_document_id', null),
    'loading the documents'
  ) as Doc[]
}

/** The stored text of a document, or null when there is none to read */
async function storedText(admin: Admin, clientId: string, doc: Doc) {
  if (!doc.file_url?.startsWith(`${clientId}/`)) return null
  const { data, error } = await admin.storage.from(KNOWLEDGE_BUCKET).download(doc.file_url)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer()).toString('utf8')
}

/** What each of the seven needs: kept as it is, or written (replacing what is there under its title) */
async function planDocuments(admin: Admin, clientId: string) {
  const existing = await sourceDocuments(admin, clientId)
  const steps = []
  for (const doc of CONTENT.documents) {
    const same = existing.filter((d) => d.title === doc.title)
    const keep = same.length === 1 && same[0].status === 'ready' && (await storedText(admin, clientId, same[0])) === doc.body
    steps.push({ doc, keep, replace: keep ? [] : same })
  }
  const others = existing.filter((d) => !CONTENT.documents.some((doc) => doc.title === d.title))
  return { steps, others }
}

type Limit = { used: number | null; limit: number | null }
type Subscription = { plan: string; status: string; trialEndsAt: string | null; usable: boolean | null; messages: Limit | null; docs: Limit | null; chunks: Limit | null }
type UsageRow = { limit_type: string; used: number; limit_value: number | null; usable: boolean }

/**
 * The client's plan and what it has used: through client_usage, the reading
 * the bot's gate and the dashboard's cards make; the plan's limits alone, usage
 * unknown, if that cannot be called.
 */
async function subscription(admin: Admin, clientId: string): Promise<Subscription> {
  const row = check(
    await admin.from('client_subscriptions').select('status, trial_ends_at, plans(slug, name, messages_limit, knowledge_docs_limit, knowledge_chunks_limit)').eq('client_id', clientId).maybeSingle(),
    'loading the subscription'
  ) as { status: string; trial_ends_at: string | null; plans: { slug: string; name: string; messages_limit: number | null; knowledge_docs_limit: number | null; knowledge_chunks_limit: number | null } | null } | null
  if (!row) throw new Error('the client has no subscription row')

  const base = { plan: row.plans ? `${row.plans.name} (${row.plans.slug})` : 'no plan', status: row.status, trialEndsAt: row.trial_ends_at }
  const { data, error } = await admin.rpc('client_usage', { p_client_id: clientId })
  if (error || !Array.isArray(data) || data.length === 0) {
    console.warn(`  (client_usage could not be read: ${error?.message ?? 'no rows'}; limits from the plan alone, usage unknown)`)
    const plan = row.plans
    return {
      ...base,
      usable: null,
      messages: plan ? { used: null, limit: plan.messages_limit } : null,
      docs: plan ? { used: null, limit: plan.knowledge_docs_limit } : null,
      chunks: plan ? { used: null, limit: plan.knowledge_chunks_limit } : null,
    }
  }
  const usage = data as UsageRow[]
  const of = (type: string): Limit | null => {
    const u = usage.find((r) => r.limit_type === type)
    return u ? { used: u.used, limit: u.limit_value } : null
  }
  return { ...base, usable: usage[0].usable, messages: of('messages'), docs: of('knowledge_docs'), chunks: of('knowledge_chunks') }
}

const show = (limit: Limit | null) => (!limit ? 'unknown' : `${limit.used ?? '?'} used of ${limit.limit ?? 'unlimited'}`)

function printSubscription(sub: Subscription, comments: boolean) {
  console.log('\n================ THE PLAN: read this before recording ================')
  console.log(`  plan                     ${sub.plan}`)
  console.log(`  status                   ${sub.status}${sub.trialEndsAt ? `, trial ends ${sub.trialEndsAt}` : ''}${sub.usable === false ? '   NOT USABLE: the bot is not answering' : ''}`)
  console.log(`  MONTHLY MESSAGE LIMIT    ${show(sub.messages)}`)
  console.log(`  documents                ${show(sub.docs)}`)
  console.log(`  chunks                   ${show(sub.chunks)}`)
  console.log(`  comment replies          ${onOff(comments)}   (set only with --comments=on|off)`)
  if (sub.status === 'trialing') {
    console.log('\n  WARNING: still on the trial. A super admin must activate this client’s subscription')
    console.log('  in the admin area before recording, or the bot stops answering when the trial ends.')
  }
  console.log('======================================================================')
}

async function main() {
  const { email, write, comments } = args()
  const admin = createAdminClient()

  const clinic = await findClinic(admin, email)
  const { clientId } = clinic
  console.log(`login: ${email} (${clinic.userRole})`)
  console.log(`organization: "${clinic.orgName}" (${clinic.orgId}), direct business, one client`)
  console.log(`client: ${clientId}, named as the fixture names it`)

  // The switch is its own action: no content is read for writing or written
  if (comments !== null) {
    await setCommentReplies(admin, clinic, comments, write)
    return
  }

  const chunks = []
  for (const doc of CONTENT.documents) {
    const prepared = await prepareKnowledgeChunks('txt', Buffer.from(doc.body, 'utf8'))
    if (!prepared.ok) throw new Error(`${doc.title}: ${prepared.error}`)
    chunks.push(prepared.chunks)
  }
  const work = await planDocuments(admin, clientId)
  console.log(`\n${write ? 'writing' : 'would write'}:`)
  console.log(`  clients          industry, description (${[...CONTENT.client.description].length} chars, 2 lines); name and slug as sign-up made them`)
  console.log(`  bot_settings     system_prompt (${[...CONTENT.bot.systemPrompt].length} chars), welcome_message, fallback_message, tone ${TONE}, language ar, booking_mode ${BOOKING_MODE}`)
  console.log(`  branches         the client's one branch: "${CONTENT.branch.name}", 30-minute slots, capacity 1, Africa/Cairo, Sat–Thu 12:00–20:00, Fri closed`)
  for (const [i, step] of work.steps.entries()) {
    const action = step.keep ? 'kept (ready, same text)' : step.replace.length ? `replaced (${step.replace.length} existing of that title)` : 'new'
    console.log(`  knowledge        "${step.doc.title}": ${action}, ${chunks[i].length} chunk(s)`)
  }
  if (work.others.length) console.log(`  left alone       ${work.others.length} other document(s) on this client: ${work.others.map((d) => `"${d.title}"`).join(', ')}`)

  const sub = await subscription(admin, clientId)
  printSubscription(sub, await commentReplies(admin, clientId))

  if (!write) {
    console.log('\ndry run: nothing written. Add --write to write it.')
    return
  }

  // --- the client: what sign-up did not write ----------------------------
  check(await admin.from('clients').update({ industry: CONTENT.client.industry, description: CONTENT.client.description }).eq('id', clientId).eq('organization_id', clinic.orgId), 'updating the client')
  console.log('\nclient updated')

  // --- bot settings (the row the database made with the client) -----------
  const settings = check(
    await admin
      .from('bot_settings')
      .update({
        system_prompt: CONTENT.bot.systemPrompt,
        welcome_message: CONTENT.bot.welcome,
        fallback_message: CONTENT.bot.fallback,
        tone: TONE,
        language: 'ar',
        booking_mode: BOOKING_MODE,
      })
      .eq('client_id', clientId)
      .select('client_id'),
    'saving the bot settings'
  ) as unknown[]
  if (settings.length !== 1) throw new Error(`expected one bot_settings row for the clinic, updated ${settings.length}`)
  console.log('bot settings saved')

  // --- the branch: the one the database made with the client, renamed -----
  const branches = check(await admin.from('branches').select('id, name').eq('client_id', clientId), 'loading the branches') as { id: string; name: string }[]
  const branch = { name: CONTENT.branch.name, slot_minutes: 30, capacity_per_slot: 1, timezone: 'Africa/Cairo', business_hours: HOURS, is_active: true }
  if (branches.length === 0) {
    check(await admin.from('branches').insert({ client_id: clientId, ...branch }), 'creating the branch')
  } else if (branches.length === 1) {
    check(await admin.from('branches').update(branch).eq('client_id', clientId).eq('id', branches[0].id), 'updating the branch')
  } else {
    throw new Error(`the clinic has ${branches.length} branches; the fixture gives one. Not changing any of them`)
  }
  console.log(`branch saved: ${CONTENT.branch.name}`)

  // --- the knowledge base --------------------------------------------------
  const fresh = await planDocuments(admin, clientId)
  const docsLimit = sub.docs?.limit
  const after = fresh.others.length + CONTENT.documents.length
  if (docsLimit != null && after > docsLimit) throw new Error(`the plan allows ${docsLimit} documents and the clinic would have ${after}: nothing uploaded`)

  for (const [i, step] of fresh.steps.entries()) {
    if (step.keep) {
      console.log(`  "${step.doc.title}": kept`)
      continue
    }
    for (const old of step.replace) {
      await assertClinic(admin, email, clientId)
      if (old.file_url?.startsWith(`${clientId}/`)) {
        const { error } = await admin.storage.from(KNOWLEDGE_BUCKET).remove([old.file_url])
        if (error) throw new Error(`"${old.title}": removing its file: ${error.message}`)
      }
      // Its chunks are rows pointing at it (source_document_id … on delete cascade)
      const { error, count } = await admin.from('knowledge_documents').delete({ count: 'exact' }).eq('client_id', clientId).eq('id', old.id)
      if (error) throw new Error(`"${old.title}": deleting the old document: ${error.message}`)
      console.log(`  delete from knowledge_documents where client_id = '${clientId}' and id = '${old.id}'  → ${count ?? 0} row(s), with its chunks`)
    }

    const id = randomUUID()
    const buffer = Buffer.from(step.doc.body, 'utf8')
    const storagePath = `${clientId}/${id}.txt`
    const { error: storageError } = await admin.storage.from(KNOWLEDGE_BUCKET).upload(storagePath, buffer, { contentType: KNOWLEDGE_FILE_TYPES.txt, upsert: false })
    if (storageError) throw new Error(`"${step.doc.title}": storing the file: ${storageError.message}`)
    check(
      await admin.from('knowledge_documents').insert({ id, client_id: clientId, title: step.doc.title, file_url: storagePath, file_type: 'txt', file_size: buffer.length, status: 'processing' }),
      `"${step.doc.title}": creating the document`
    )
    await processKnowledgeDocument(admin, { id, client_id: clientId, title: step.doc.title, file_type: 'txt' }, chunks[i])
    // processKnowledgeDocument never throws: it marks the document instead
    const done = check(await admin.from('knowledge_documents').select('status, chunk_count, error_message').eq('id', id).eq('client_id', clientId).single(), `"${step.doc.title}": reading it back`) as {
      status: string
      chunk_count: number | null
      error_message: string | null
    }
    if (done.status !== 'ready') throw new Error(`"${step.doc.title}": processing failed (${done.error_message})`)
    console.log(`  "${step.doc.title}": written, ${done.chunk_count} chunk(s)`)
  }

  console.log(`\ndone. The clinic: ${clientId}`)
  printSubscription(await subscription(admin, clientId), await commentReplies(admin, clientId))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
