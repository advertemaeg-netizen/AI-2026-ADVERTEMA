import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import en from '../../messages/en.json'
import pending from '../../messages/pending-arabic.json'

/**
 * KEYS STILL WAITING FOR THEIR ARABIC (2026-11-15). The owner writes the
 * Arabic; until then ar.json holds the English under the key, and the key is
 * listed in messages/pending-arabic.json, where deploy/update.sh refuses to
 * deploy while the list has one. This keeps the list true both ways: every
 * listed key exists in both files and still holds the English, so a key whose
 * Arabic has been copied in fails here until it is taken off the list.
 */

const at = (file: unknown, path: string) => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], file)

describe('messages/pending-arabic.json', () => {
  it('lists only keys that exist in both files, as text', () => {
    for (const key of pending.keys) {
      expect(typeof at(en, key), key).toBe('string')
      expect(typeof at(ar, key), key).toBe('string')
    }
  })

  it('lists only keys whose Arabic is still the English: a translated key comes off the list', () => {
    expect(pending.keys.filter((key) => at(ar, key) !== at(en, key))).toEqual([])
  })
})
