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
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

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
        const out = template[1].replace(/\$\{(\w+)\}/g, (_, name: string) => strings.get(name) ?? '\0')
        return out.includes('\0') ? null : [out]
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

  it('never reaches the site or the root', () => {
    const site = all.filter((c) => c.paths?.some((p) => p === '/' || p === '/[locale]' || /\/site(\/|$)/.test(p)))
    expect(site.map((c) => `${where(c)} ${c.paths}`)).toEqual([])
  })
})

describe('the site segment', () => {
  // With false, a lost cache entry became a 404 written over the prerendered page
  it('lets a page whose cache entry is lost render again', () => {
    for (const file of sources('app/[locale]/site')) {
      expect(readFileSync(file, 'utf8'), path.relative(ROOT, file)).not.toMatch(/dynamicParams\s*=\s*false/)
    }
  })
})
