// diffLines (docs/UI.md 7.19, 11.4; W7.11): the client diff of edit_file approval previews.
import { describe, expect, it } from 'vitest'
import { diffLines, splitLines } from './line-diff'

describe('splitLines', () => {
  it('splits on LF and CRLF and treats one trailing newline as the end of the last line', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('a\n')).toEqual(['a'])
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
  })
})

describe('diffLines', () => {
  it('finds no hunks between identical texts', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([])
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('a\r\nb\r\n', 'a\nb\n', { context: 3, maxCells: 4e6 })).toEqual([])
  })

  it('treats a missing trailing newline as no change of its own', () => {
    expect(diffLines('a\nb', 'a\nb\n')).toEqual([])
    expect(diffLines('a\nb\n', 'a\nc')).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] },
    ])
  })

  it('diffs a pure addition and a pure deletion', () => {
    expect(diffLines('', 'one\ntwo\n')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] },
    ])
    expect(diffLines('one\ntwo\n', '')).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-one', '-two'] },
    ])
    expect(diffLines('a\nb\n', 'a\nx\nb\n', { context: 0 })).toEqual([
      { oldStart: 1, oldLines: 0, newStart: 2, newLines: 1, lines: ['+x'] },
    ])
  })

  it('shows a replacement as removals before additions with context', () => {
    const before = 'const tokens = lex(input)\nif (!tokens) return null\nreturn parse(tokens)\n'
    const after = 'const tokens = lex(input)\nif (tokens.length === 0)\n  return null\nreturn parse(tokens)\n'
    expect(diffLines(before, after)).toEqual([{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      lines: [' const tokens = lex(input)', '-if (!tokens) return null', '+if (tokens.length === 0)', '+  return null', ' return parse(tokens)'],
    }])
  })

  it('keeps 3 lines of context, merges close changes and splits distant ones', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const changed = [...lines]
    changed[1] = 'LINE 2'
    changed[17] = 'LINE 18'
    const hunks = diffLines(lines.join('\n'), changed.join('\n'))
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5 })
    expect(hunks[0]!.lines).toEqual([' line 1', '-line 2', '+LINE 2', ' line 3', ' line 4', ' line 5'])
    expect(hunks[1]).toMatchObject({ oldStart: 15, oldLines: 6, newStart: 15, newLines: 6 })

    const near = [...lines]
    near[4] = 'LINE 5'
    near[11] = 'LINE 12'
    // Six kept lines between the changes fit in two contexts: one hunk; seven split it.
    const merged = diffLines(lines.join('\n'), near.join('\n'))
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ oldStart: 2, oldLines: 14, newStart: 2, newLines: 14 })
    const apart = [...lines]
    apart[4] = 'LINE 5'
    apart[12] = 'LINE 13'
    expect(diffLines(lines.join('\n'), apart.join('\n'))).toHaveLength(2)

    expect(diffLines(lines.join('\n'), changed.join('\n'), { context: 0 }).map(hunk => hunk.lines)).toEqual([
      ['-line 2', '+LINE 2'],
      ['-line 18', '+LINE 18'],
    ])
  })

  it('falls back to one hunk past the size cap', () => {
    const before = 'a\nb\nc\n'
    const after = 'a\nB\nc\n'
    expect(diffLines(before, after, { maxCells: 8 })).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ['-a', '-b', '-c', '+a', '+B', '+c'] },
    ])
    expect(diffLines(before, after, { maxCells: 9 })).toHaveLength(1)
    expect(diffLines(before, after, { maxCells: 9 })[0]!.lines).toEqual([' a', '-b', '+B', ' c'])
  })

  it('compares CRLF as LF', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nc\n')).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] },
    ])
  })
})
