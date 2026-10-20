import { describe, expect, it } from 'vitest'
import { lineDiff } from '@/lib/line-diff'

describe('what a publish would change, line by line', () => {
  it('marks nothing when the texts are the same', () => {
    expect(lineDiff('a\nb', 'a\nb').every((line) => line.kind === 'same')).toBe(true)
  })

  it('shows a changed line as removed then added, and keeps the rest', () => {
    expect(lineDiff('one\ntwo\nthree', 'one\n2\nthree')).toEqual([
      { kind: 'same', text: 'one' },
      { kind: 'removed', text: 'two' },
      { kind: 'added', text: '2' },
      { kind: 'same', text: 'three' },
    ])
  })

  it('shows lines added at the end and removed from the start', () => {
    expect(lineDiff('x\ny', 'y\nz')).toEqual([
      { kind: 'removed', text: 'x' },
      { kind: 'same', text: 'y' },
      { kind: 'added', text: 'z' },
    ])
  })
})
