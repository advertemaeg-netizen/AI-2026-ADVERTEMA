import { describe, expect, it } from 'vitest'
import { fileSize } from '@/lib/types/knowledge'

/** The knowledge list read "0 MB" for every file under half a megabyte */
describe('fileSize', () => {
  it.each([
    [40 * 1024, { value: 40, unit: 'KB', fractionDigits: 0 }],
    [300, { value: 1, unit: 'KB', fractionDigits: 0 }],
    [1024 * 1024 - 1, { value: 1023, unit: 'KB', fractionDigits: 0 }],
    [1024 * 1024, { value: 1, unit: 'MB', fractionDigits: 1 }],
    [Math.round(2.5 * 1024 * 1024), { value: 2.5, unit: 'MB', fractionDigits: 1 }],
  ])('%i bytes', (bytes, expected) => {
    expect(fileSize(bytes)).toEqual(expected)
  })

  it('never shows a file under 1 MB as 0', () => {
    for (const bytes of [1, 511, 512, 1000, 500_000]) expect(fileSize(bytes).value).toBeGreaterThan(0)
  })
})
