import { describe, expect, it } from 'vitest'
import ar from '../../messages/site/ar.json'
import en from '../../messages/site/en.json'

/** Every key path in a copy file, arrays included ("pages.pricing.tiers.0.name") */
function keys(node: unknown, prefix = ''): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => keys(item, `${prefix}.${i}`))
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
  return [prefix]
}

describe('the site’s copy files', () => {
  // A key in one language only is text the other language's page is missing
  it('have the same keys in Arabic and English', () => {
    expect(keys(ar)).toEqual(keys(en))
  })

  it('hold text in every key, and nothing but text', () => {
    for (const file of [ar, en]) {
      const leaves = keys(file).map((path) => path.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], file))
      for (const leaf of leaves) expect(typeof leaf === 'string' && leaf.trim().length > 0).toBe(true)
    }
  })
})
