// Generates the CONTENT block of scripts/seed-review-clinic.ts from
// scripts/fixtures/review-clinic.md, the one source of the review clinic's
// text, then reads it back out of the script and checks every string against
// the fixture byte for byte. Nothing is typed: change the fixture, run this.
//
//   node scripts/fixtures/generate-review-clinic.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const FIXTURE = 'scripts/fixtures/review-clinic.md'
const SCRIPT = 'scripts/seed-review-clinic.ts'
const mdPath = path.join(root, FIXTURE)
const tsPath = path.join(root, SCRIPT)

function extract(md) {
  const section = (n) => {
    const start = md.indexOf(`\n## ${n}. `)
    if (start < 0) throw new Error(`no section ${n}`)
    const end = md.indexOf('\n## ', start + 1)
    return md.slice(start, end < 0 ? undefined : end)
  }
  const cell = (text, field) => {
    const m = text.match(new RegExp(`^\\| ${field} \\| \`([^\`]+)\` \\|$`, 'm'))
    if (!m) throw new Error(`no ${field} cell`)
    return m[1]
  }
  const blockAfter = (text, label) => {
    const at = text.indexOf(label)
    if (at < 0) throw new Error(`no ${label}`)
    const m = text.slice(at).match(/```\n([\s\S]*?)\n```/)
    if (!m) throw new Error(`no block after ${label}`)
    return m[1]
  }
  const s1 = section(1)
  const s2 = section(2)
  const s3 = section(3)
  const s4 = section(4)
  const documents = [...s4.matchAll(/^### (.+)\n\n```\n([\s\S]*?)\n```/gm)].map((m) => ({ title: m[1], body: m[2] }))
  if (documents.length !== 7) throw new Error(`expected seven documents, found ${documents.length}`)
  return {
    client: { name: cell(s1, 'Name'), industry: cell(s1, 'Industry'), description: blockAfter(s1, '**Description**') },
    bot: { systemPrompt: blockAfter(s2, '**System prompt**'), welcome: blockAfter(s2, '**Welcome message**'), fallback: blockAfter(s2, '**Fallback message**') },
    branch: { name: cell(s3, 'Name') },
    documents,
  }
}

const md = readFileSync(mdPath, 'utf8')
const content = extract(md)
const block = [`// GENERATED from ${FIXTURE} by ${path.basename(import.meta.filename)}; checked back byte for byte. Do not edit by hand.`, `const CONTENT = ${JSON.stringify(content, null, 2)} as const`].join('\n')

let ts = readFileSync(tsPath, 'utf8')
const generated = /\/\/ GENERATED from [^\n]*\nconst CONTENT = \{[\s\S]*?\n\} as const/
if (!generated.test(ts)) throw new Error(`no generated CONTENT block in ${SCRIPT}`)
ts = ts.replace(generated, () => block)
writeFileSync(tsPath, ts)

// Read back from the script, so what is checked is what landed
const landed = JSON.parse(readFileSync(tsPath, 'utf8').match(/const CONTENT = (\{[\s\S]*?\n\}) as const/)[1])
const pairs = [
  ['client.name', landed.client.name, content.client.name],
  ['client.industry', landed.client.industry, content.client.industry],
  ['client.description', landed.client.description, content.client.description],
  ['bot.systemPrompt', landed.bot.systemPrompt, content.bot.systemPrompt],
  ['bot.welcome', landed.bot.welcome, content.bot.welcome],
  ['bot.fallback', landed.bot.fallback, content.bot.fallback],
  ['branch.name', landed.branch.name, content.branch.name],
  ...content.documents.flatMap((d, i) => [
    [`documents[${i}].title`, landed.documents[i].title, d.title],
    [`documents[${i}].body`, landed.documents[i].body, d.body],
  ]),
]
for (const [key, got, want] of pairs) {
  if (!Buffer.from(got, 'utf8').equals(Buffer.from(want, 'utf8'))) throw new Error(`${key}: differs from the fixture`)
  // Present verbatim in the fixture itself, not only in this reading of it
  if (!md.includes(want)) throw new Error(`${key}: not found verbatim in the fixture`)
  console.log(`${key.padEnd(22)} ${String([...got].length).padStart(4)} chars ${String(Buffer.byteLength(got)).padStart(5)} bytes  ${got.split('\n').length} line(s)  identical`)
}
