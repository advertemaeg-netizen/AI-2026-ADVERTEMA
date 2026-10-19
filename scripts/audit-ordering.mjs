// Read-only audit: do production's timestamps ever disagree with the order rows were
// written in? Fetches ids, roles, timestamps and links only — no message content, no
// names — and prints counts. First run 2026-10-19: none, for real clients (the
// inversions seen so far were the test database's clock; AGENTS.md).
//   node scripts/audit-ordering.mjs     (reads .env.local)
// Rerun it when the first paying client has been live for a week, and again when real
// clients' conversations reach 100 (23 at the first run). An inversion reopens the
// insertion-order column for messages and leads.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
// The demo account is seeded by script, with constructed timestamps: counted apart
const DEMO = '7565fd16-be2e-4162-bc3e-e25e9695fe88'
async function all(table, cols) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order('id').range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}
const t = (s) => new Date(s).getTime()
;(async () => {
  const [convs, msgs, leads] = await Promise.all([
    all('conversations', 'id, client_id, created_at'),
    all('messages', 'id, conversation_id, role, created_at'),
    all('leads', 'id, conversation_id, source_message_id, created_at, updated_at'),
  ])
  const conv = new Map(convs.map((c) => [c.id, c]))
  const msg = new Map(msgs.map((m) => [m.id, m]))
  const group = (cid) => (conv.get(cid)?.client_id === DEMO ? 'demo' : 'clients')
  const out = { demo: {}, clients: {} }
  const bump = (g, k, ex) => { const o = out[g]; o[k] = o[k] ?? { n: 0, worst_ms: 0 }; o[k].n++; if (ex !== undefined) o[k].worst_ms = Math.max(o[k].worst_ms, ex) }
  for (const g of ['demo', 'clients']) { out[g].conversations = 0; out[g].messages = 0; out[g].leads = 0 }
  for (const c of convs) out[group(c.id)].conversations++
  const byConv = new Map()
  for (const m of msgs) { out[group(m.conversation_id)].messages++; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)).push(m) }
  for (const [cid, list] of byConv) {
    const g = group(cid)
    list.sort((a, b) => t(a.created_at) - t(b.created_at))
    const c = conv.get(cid)
    if (c && t(list[0].created_at) < t(c.created_at)) bump(g, 'message stamped before its conversation', t(c.created_at) - t(list[0].created_at))
    if (list[0].role === 'assistant') bump(g, 'conversation opens with a bot reply (by created_at)')
    for (let i = 1; i < list.length; i++) {
      if (list[i].created_at === list[i - 1].created_at) bump(g, 'two messages with an identical created_at')
      if (list[i].role === 'assistant' && list[i - 1].role === 'assistant') bump(g, 'two bot replies back to back (by created_at)')
    }
  }
  for (const l of leads) {
    const g = group(l.conversation_id)
    out[g].leads++
    if (t(l.created_at) > t(l.updated_at)) bump(g, 'lead created after its own updated_at', t(l.created_at) - t(l.updated_at))
    const src = l.source_message_id && msg.get(l.source_message_id)
    if (src && t(l.created_at) < t(src.created_at)) bump(g, 'lead created before its source message', t(src.created_at) - t(l.created_at))
  }
  const span = msgs.length ? [msgs.reduce((a, m) => (m.created_at < a ? m.created_at : a), msgs[0].created_at), msgs.reduce((a, m) => (m.created_at > a ? m.created_at : a), msgs[0].created_at)] : []
  console.log(JSON.stringify({ messages_span: span, ...out }, null, 1))
})().catch((e) => { console.error(e.message); process.exit(1) })
