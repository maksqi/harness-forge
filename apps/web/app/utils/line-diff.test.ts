// diffLines skeleton (docs/UI.md 7.19, 11.4; C15, P7-0b): the frozen signature. W7.11 adds the LCS and its tests.
import { describe, expect, it } from 'vitest'
import { diffLines } from './line-diff'

describe('diffLines', () => {
  it('finds no hunks between identical texts', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([])
    expect(diffLines('a\r\nb\r\n', 'a\nb\n', { context: 3, maxCells: 4e6 })).toEqual([])
  })
})
