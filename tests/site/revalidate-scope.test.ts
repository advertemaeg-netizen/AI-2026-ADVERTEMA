import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The marketing site's pages are prerendered, and their cache tags include
 * the root and [locale] layouts. A revalidatePath that reaches either takes
 * every site page with it: on 2026-10-19 the impersonation actions'
 * revalidatePath('/[locale]', 'layout'), run on every sign-out, 404'd the
 * whole site until the container was recreated. This reads every call in the
 * code and fails on one that reaches that far.
 *
 * The one exception under the site is the legal pages: publishing a version
 * expires the current page of that document, at page level, and nothing else.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

/** The real document names, read from the code rather than restated here */
const LEGAL_DOCUMENTS = (() => {
  const list = readFileSync(path.join(ROOT, 'src/lib/legal.ts'), 'utf8').match(/LEGAL_DOCUMENTS = \[([^\]]*)\]/)
  if (!list) throw new Error('LEGAL_DOCUMENTS not found in src/lib/legal.ts')
  return [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
})()

/** Template variables that stand for one of a known set of values */
const KNOWN_VALUES: Record<string, string[]> = { document: LEGAL_DOCUMENTS }

/** A site path a publish may expire, at page level: a legal document's page, or its earlier versions' */
const LEGAL_PAGE = new RegExp(`^/(\\[locale\\]|ar|en)/site/(${LEGAL_DOCUMENTS.join('|')})(/v/(\\[version\\]|[1-9]\\d{0,2}))?$`)

function sources(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
}

type Call = { file: string; line: number; paths: string[] | null; type: string | null }

/** Every revalidatePath call, its path resolved from literals and the file's own constants (null: unresolvable) */
function calls(): Call[] {
  const found: Call[] = []
  for (const file of [...sources('src'), ...sources('app')]) {
    const text = readFileSync(file, 'utf8')
    const strings = new Map<string, string>()
    for (const m of text.matchAll(/const (\w+) = '([^']*)'/g)) strings.set(m[1], m[2])
    const arrays = new Map<string, string[]>()
    for (const m of text.matchAll(/const (\w+) = \[([^\]]*)\]/g)) {
      arrays.set(m[1], [...m[2].matchAll(/'([^']*)'/g)].map((s) => s[1]))
    }
    const loopVars = new Map<string, string>()
    for (const m of text.matchAll(/for \(const (\w+) of (\w+)\)/g)) loopVars.set(m[1], m[2])

    const resolve = (arg: string): string[] | null => {
      const literal = arg.match(/^'([^']*)'$/)
      if (literal) return [literal[1]]
      const template = arg.match(/^`([^`]*)`$/)
      if (template) {
        // Every combination: a constant is one value, a known variable each of its values
        let outs = [template[1]]
        for (const [, name] of template[1].matchAll(/\$\{(\w+)\}/g)) {
          const values = strings.has(name) ? [strings.get(name)!] : KNOWN_VALUES[name]
          if (!values) return null
          outs = outs.flatMap((out) => values.map((value) => out.replace(`\${${name}}`, value)))
        }
        return outs
      }
      if (strings.has(arg)) return [strings.get(arg)!]
      const array = loopVars.get(arg)
      return array && arrays.has(array) ? arrays.get(array)! : null
    }

    for (const m of text.matchAll(/revalidatePath\(\s*([^,)]+?)\s*(?:,\s*'(\w+)'\s*)?\)/g)) {
      found.push({
        file: path.relative(ROOT, file),
        line: text.slice(0, m.index).split('\n').length,
        paths: resolve(m[1]),
        type: m[2] ?? null,
      })
    }
  }
  return found
}

const where = (c: Call) => `${c.file}:${c.line}`

describe('revalidatePath across the code', () => {
  const all = calls()

  it('finds the calls it is meant to check', () => {
    // A regex that stopped matching would pass every rule below vacuously
    expect(all.length).toBeGreaterThan(30)
  })

  it('has a path this test can read in every call', () => {
    expect(all.filter((c) => c.paths === null).map(where)).toEqual([])
  })

  it('stays inside the dashboard or the admin panel at layout level', () => {
    const wide = all.filter(
      (c) => c.type === 'layout' && c.paths?.some((p) => !/^\/\[locale\]\/(dashboard|admin)(\/|$)/.test(p)),
    )
    expect(wide.map((c) => `${where(c)} ${c.paths} (layout)`)).toEqual([])
  })

  it('never reaches the root', () => {
    const root = all.filter((c) => c.paths?.some((p) => p === '/' || p === '/[locale]'))
    expect(root.map((c) => `${where(c)} ${c.paths}`)).toEqual([])
  })

  it('reaches the site only to expire a legal page, at page level', () => {
    // A call without a type names one concrete page
    const site = all.filter((c) => c.paths?.some((p) => /\/site(\/|$)/.test(p) && !(c.type !== 'layout' && LEGAL_PAGE.test(p))))
    expect(site.map((c) => `${where(c)} ${c.paths} (${c.type ?? 'page'})`)).toEqual([])
  })

  it('reads the legal documents it allows from the code', () => {
    expect(LEGAL_DOCUMENTS).toEqual(['privacy', 'terms'])
  })
})

describe('the site segment', () => {
  // With false, a lost cache entry became a 404 written over the prerendered page.
  // Code only: a comment explaining why the line is gone must not trip it
  it('lets a page whose cache entry is lost render again', () => {
    for (const file of sources('app/[locale]/site')) {
      expect(readFileSync(file, 'utf8'), path.relative(ROOT, file)).not.toMatch(/export\s+const\s+dynamicParams\s*=\s*false/)
    }
  })

  // A cached version page would store a 404 for every number anyone asks for
  it('never caches an earlier version of a legal page', () => {
    for (const document of LEGAL_DOCUMENTS) {
      const file = `app/[locale]/site/${document}/v/[version]/page.tsx`
      const text = readFileSync(path.join(ROOT, file), 'utf8')
      expect(text, file).toMatch(/export\s+const\s+dynamic\s*=\s*'force-dynamic'/)
      expect(text, file).not.toMatch(/export\s+const\s+revalidate\b/)
    }
  })
})
