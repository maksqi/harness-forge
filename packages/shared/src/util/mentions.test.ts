import type { MatchRange, MentionPathEntry, MentionToken } from './mentions.ts'
import { describe, expect, it } from 'vitest'
import { formatMention, isMentionablePath, MENTION_QUERY_MAX_CHARS, mentionTokenAt, parseMentions, rankPaths, scorePath } from './mentions.ts'

/** `mentionTokenAt` with the caret written as `|` in the text. */
function tokenAt(textWithCaret: string): MentionToken | null {
  const caret = textWithCaret.indexOf('|')
  expect(caret).toBeGreaterThanOrEqual(0)
  return mentionTokenAt(textWithCaret.slice(0, caret) + textWithCaret.slice(caret + 1), caret)
}

function tier(score: number): number {
  return Math.floor(score / 1000)
}

function highlighted(path: string, ranges: readonly MatchRange[]): string {
  return ranges.map(([start, end]) => path.slice(start, end)).join('')
}

// ---------------------------------------------------------------------------------------------------------------------
// mentionTokenAt

describe('mentionTokenAt', () => {
  const rows: Array<[string, MentionToken | null]> = [
    // unquoted
    ['@|', { start: 0, end: 1, query: '', quoted: false }],
    ['@src|', { start: 0, end: 4, query: 'src', quoted: false }],
    ['@sr|c/app.ts more', { start: 0, end: 11, query: 'sr', quoted: false }],
    ['hello @wor|ld', { start: 6, end: 12, query: 'wor', quoted: false }],
    ['x\n@pa|th', { start: 2, end: 7, query: 'pa', quoted: false }],
    ['tab\t@a|', { start: 4, end: 6, query: 'a', quoted: false }],
    ['nbsp\u00A0@a|', { start: 5, end: 7, query: 'a', quoted: false }],
    ['ideographic\u3000@a|', { start: 12, end: 14, query: 'a', quoted: false }],
    ['@@ty|pes', { start: 0, end: 7, query: '@ty', quoted: false }],
    ['@a"b|', { start: 0, end: 4, query: 'a"b', quoted: false }],
    ['@one two\n@th|ree', { start: 9, end: 15, query: 'th', quoted: false }],
    ['@one @tw|o', { start: 5, end: 9, query: 'tw', quoted: false }],
    // not a token
    ['a@b|', null],
    ['mail me at me@example.com|', null],
    ['(@foo|', null],
    ['foo |@bar', null],
    ['|@bar', null],
    ['@bar |', null],
    ['@bar baz|', null],
    ['@bar\n|', null],
    ['@bar\nbaz|', null],
    ['|', null],
    ['plain text|', null],
    // quoted
    ['@"|', { start: 0, end: 2, query: '', quoted: true }],
    ['@"my fi|', { start: 0, end: 7, query: 'my fi', quoted: true }],
    ['@"my fi|le.txt" more', { start: 0, end: 14, query: 'my fi', quoted: true }],
    ['@"my file.txt|"', { start: 0, end: 14, query: 'my file.txt', quoted: true }],
    ['see @"a b|', { start: 4, end: 9, query: 'a b', quoted: true }],
    ['@"ab|c @def', { start: 0, end: 5, query: 'ab', quoted: true }],
    ['@"my file.txt" @"ot|', { start: 15, end: 19, query: 'ot', quoted: true }],
    ['@"foo @ba|r"', { start: 0, end: 11, query: 'foo @ba', quoted: true }],
    // the caret between `@` and `"`
    ['@|"abc"', { start: 0, end: 6, query: '', quoted: false }],
    ['@|"abc', { start: 0, end: 5, query: '', quoted: false }],
    // an abandoned open quote: a later `@` run at the caret wins
    ['@"abandoned quote @nex|t', { start: 18, end: 23, query: 'nex', quoted: false }],
    ['@"abandoned quote and|', { start: 0, end: 21, query: 'abandoned quote and', quoted: true }],
    // after a complete quoted mention
    ['@"my file.txt"|', null],
    ['@"my file.txt" |', null],
    ['@"a b" c d|', null],
    ['@"a b"c|', null],
    ['@"x @"y|', null],
    // quotes never span lines; `@"` must follow whitespace too
    ['@"a\nb|', null],
    ['@"a\r\nb|', null],
    ['x@"a b|', null],
  ]

  for (const [input, expected] of rows) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(tokenAt(input)).toEqual(expected)
    })
  }

  it('limits the query to 256 characters', () => {
    const name = 'a'.repeat(MENTION_QUERY_MAX_CHARS)
    expect(MENTION_QUERY_MAX_CHARS).toBe(256)
    expect(tokenAt(`@${name}|`)).toMatchObject({ query: name })
    expect(tokenAt(`@${name}a|`)).toBeNull()
    expect(tokenAt(`@"${name}|`)).toMatchObject({ query: name, quoted: true })
    expect(tokenAt(`@"${name}a|`)).toBeNull()
  })

  it('clamps the caret and rejects invalid input', () => {
    expect(mentionTokenAt('@ab', 99)).toEqual({ start: 0, end: 3, query: 'ab', quoted: false })
    expect(mentionTokenAt('@ab', Number.POSITIVE_INFINITY)).toMatchObject({ query: 'ab' })
    expect(mentionTokenAt('@ab', 2.7)).toMatchObject({ query: 'a' })
    expect(mentionTokenAt('@ab', -5)).toBeNull()
    expect(mentionTokenAt('@ab', Number.NaN)).toBeNull()
    expect(mentionTokenAt(null as unknown as string, 1)).toBeNull()
    expect(mentionTokenAt('@ab', '2' as unknown as number)).toBeNull()
  })

  it('inserting `formatMention(path) + " "` closes the token', () => {
    for (const path of ['src/app.ts', 'my file.txt', 'docs/'])
      expect(mentionTokenAt(`${formatMention(path)} `, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// parseMentions / formatMention

describe('parseMentions', () => {
  const rows: Array<[string, Array<[string, number, number]>]> = [
    ['see @src/app.ts and @"my file.txt", ok', [['src/app.ts', 4, 15], ['my file.txt', 20, 34]]],
    ['@a', [['a', 0, 2]]],
    ['a@b @c', [['c', 4, 6]]],
    ['me@example.com', []],
    ['@', []],
    ['@ x', []],
    ['@""', []],
    ['@"unclosed', []],
    ['@"unclosed @next', [['next', 11, 16]]],
    ['@a"b', []],
    ['@a"b @c', [['c', 5, 7]]],
    ['@"x\ny"', []],
    ['@@scope/pkg', [['@scope/pkg', 0, 11]]],
    ['@"abc"', [['abc', 0, 6]]],
    ['@"a b"c', [['a b', 0, 6]]],
    ['@one\n@two', [['one', 0, 4], ['two', 5, 9]]],
    ['x@"a b" @c', [['c', 8, 10]]],
    ['\u3000@x', [['x', 1, 3]]],
    ['(@x) @y)', [['y)', 5, 8]]],
    ['@"  "', [['  ', 0, 5]]],
    ['@"x @"y', [['x @', 0, 6]]],
  ]

  for (const [input, expected] of rows) {
    it(`${JSON.stringify(input)}`, () => {
      expect(parseMentions(input)).toEqual(expected.map(([path, start, end]) => ({ path, start, end })))
    })
  }

  it('never throws on invalid input', () => {
    expect(parseMentions(undefined as unknown as string)).toEqual([])
    expect(parseMentions('')).toEqual([])
  })
})

describe('formatMention', () => {
  const rows: Array<[string, string | null]> = [
    ['src/app.ts', '@src/app.ts'],
    ['my file.txt', '@"my file.txt"'],
    ['tab\there', '@"tab\there"'],
    ['nbsp\u00A0name', '@"nbsp\u00A0name"'],
    ['@scope/pkg', '@@scope/pkg'],
    ['docs/', '@docs/'],
    ['caf\u00E9.md', '@caf\u00E9.md'],
    ['', null],
    ['a"b', null],
    ['"quoted"', null],
    ['a\nb', null],
    ['a\rb', null],
    ['a\u2028b', null],
    ['a\u2029b', null],
  ]

  for (const [path, expected] of rows) {
    it(`${JSON.stringify(path)} -> ${JSON.stringify(expected)}`, () => {
      expect(formatMention(path)).toBe(expected)
      expect(isMentionablePath(path)).toBe(expected !== null)
      if (expected !== null)
        expect(parseMentions(expected)).toEqual([{ path, start: 0, end: expected.length }])
    })
  }

  it('rejects non-strings', () => {
    expect(formatMention(7 as unknown as string)).toBeNull()
    expect(isMentionablePath(null as unknown as string)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// scorePath / rankPaths

describe('scorePath', () => {
  it('ranks the tiers: basename prefix > basename substring > path substring > subsequence', () => {
    const prefix = scorePath('par', 'src/parser.ts')!
    const inBase = scorePath('ser', 'src/parser.ts')!
    const inPath = scorePath('src/p', 'src/parser.ts')!
    const subsequence = scorePath('prs', 'src/parser.ts')!
    expect([prefix, inBase, inPath, subsequence].map(match => tier(match.score))).toEqual([4, 3, 2, 1])
    expect(prefix.ranges).toEqual([[4, 7]])
    expect(inBase.ranges).toEqual([[7, 10]])
    expect(inPath.ranges).toEqual([[0, 5]])
    expect(subsequence.ranges).toEqual([[4, 5], [6, 8]])
  })

  it('is case-insensitive and reports ranges of the original path', () => {
    expect(scorePath('PAR', 'src/Parser.ts')).toEqual(scorePath('par', 'src/parser.ts'))
    expect(scorePath('par', 'SRC/PARSER.TS')?.ranges).toEqual([[4, 7]])
    // A character whose lower case is longer (U+0130) keeps the indexes of the path.
    const match = scorePath('x', '\u0130\u0130x')!
    expect(match.ranges).toEqual([[2, 3]])
  })

  it('returns null when nothing matches', () => {
    expect(scorePath('xyz', 'src/parser.ts')).toBeNull()
    expect(scorePath('parserx', 'src/parser.ts')).toBeNull()
    expect(scorePath('toolongquery', 'a.ts')).toBeNull()
    expect(scorePath('a', '')).toBeNull()
    expect(scorePath(3 as unknown as string, 'a')).toBeNull()
    expect(scorePath('a', null as unknown as string)).toBeNull()
  })

  it('matches every path with the empty query', () => {
    expect(scorePath('', 'src/parser.ts')).toEqual({ score: 0, ranges: [] })
    expect(scorePath('', '')).toEqual({ score: 0, ranges: [] })
  })

  it('prefers an exact basename, then a stem, then a word end, then a plain prefix', () => {
    const scores = ['lib/parser', 'lib/parser.ts', 'lib/parser-utils.ts', 'lib/parsers.ts'].map(path => scorePath('parser', path)!.score)
    expect(scores.every(score => tier(score) === 4)).toBe(true)
    expect([...scores].sort((left, right) => right - left)).toEqual(scores)
    expect(new Set(scores).size).toBe(4)
  })

  it('prefers word starts inside the basename', () => {
    expect(scorePath('parser', 'src/my-parser.ts')!.score).toBeGreaterThan(scorePath('parser', 'src/myparser.ts')!.score)
    expect(scorePath('parser', 'src/myParser.ts')!.score).toBeGreaterThan(scorePath('parser', 'src/myparser.ts')!.score)
  })

  it('prefers path matches at a segment start and matches that reach the basename', () => {
    expect(scorePath('chat/', 'src/chat/a.ts')!.score).toBeGreaterThan(scorePath('hat/', 'src/chat/a.ts')!.score)
    expect(scorePath('chat/in', 'src/chat/index.ts')!.score).toBeGreaterThan(scorePath('src/ch', 'src/chat/index.ts')!.score)
  })

  it('ignores trailing slashes of folders for the basename', () => {
    expect(scorePath('pars', 'src/parsers/')).toEqual({ score: scorePath('pars', 'src/parsers')!.score, ranges: [[4, 8]] })
  })

  it('ranks a subsequence in the basename above one spread over the folders', () => {
    const inBase = scorePath('chk', 'checkpoint.txt')!
    const spread = scorePath('chk', 'src/chat/hooks.ts')!
    expect(tier(inBase.score)).toBe(1)
    expect(inBase.score).toBeGreaterThan(spread.score)
    expect(inBase.ranges).toEqual([[0, 2], [4, 5]])
  })
})

describe('rankPaths', () => {
  const entries: MentionPathEntry[] = [
    { path: 'src/chat/hooks.ts', kind: 'file' },
    { path: 'checkpoint.txt', kind: 'file' },
    { path: 'src/chat', kind: 'dir' },
    { path: 'docs/check-keys.md', kind: 'file' },
    { path: 'src', kind: 'dir' },
    { path: 'README.md', kind: 'file' },
    { path: 'src/parser.ts', kind: 'file' },
    { path: 'src/parser.test.ts', kind: 'file' },
    { path: 'lib/parser.ts', kind: 'file' },
  ]

  it('orders by score, then the shorter path, then the path', () => {
    const result = rankPaths('chk', entries, 10)
    expect(result.items.map(item => item.path)).toEqual(['checkpoint.txt', 'docs/check-keys.md', 'src/chat/hooks.ts'])
    expect(result.truncated).toBe(false)
    expect(result.items[0]).toEqual({ path: 'checkpoint.txt', kind: 'file', ranges: [[0, 2], [4, 5]] })
    // Equal scores: lib/parser.ts and src/parser.ts have the same length, so the path decides.
    expect(rankPaths('parser', entries, 10).items.map(item => item.path)).toEqual(['lib/parser.ts', 'src/parser.ts', 'src/parser.test.ts'])
  })

  it('keeps the kind and leaves out entries that do not match', () => {
    const result = rankPaths('chat', entries, 10)
    expect(result.items[0]).toEqual({ path: 'src/chat', kind: 'dir', ranges: [[4, 8]] })
    expect(result.items.map(item => item.path)).toEqual(['src/chat', 'src/chat/hooks.ts'])
  })

  it('lists shallow paths first, then alphabetically, for the empty query', () => {
    const result = rankPaths('', entries, 50)
    expect(result.items.map(item => item.path)).toEqual([
      'README.md',
      'checkpoint.txt',
      'src',
      'docs/check-keys.md',
      'lib/parser.ts',
      'src/chat',
      'src/parser.test.ts',
      'src/parser.ts',
      'src/chat/hooks.ts',
    ])
    expect(result.items.every(item => item.ranges.length === 0)).toBe(true)
  })

  it('applies the limit and reports truncation', () => {
    expect(rankPaths('', entries, 3)).toMatchObject({ truncated: true })
    expect(rankPaths('', entries, 3).items).toHaveLength(3)
    expect(rankPaths('', entries, entries.length)).toMatchObject({ truncated: false })
    expect(rankPaths('', entries, 0)).toEqual({ items: [], truncated: true })
    expect(rankPaths('', entries, 2.9).items).toHaveLength(2)
    expect(rankPaths('', entries, -1)).toEqual({ items: [], truncated: true })
    expect(rankPaths('', entries, Number.NaN)).toEqual({ items: [], truncated: true })
    expect(rankPaths('', entries, Number.POSITIVE_INFINITY).items).toHaveLength(entries.length)
    expect(rankPaths('zzz', entries, 0)).toEqual({ items: [], truncated: false })
  })

  it('keeps the input order for duplicate paths and skips malformed entries', () => {
    const duplicates = [{ path: 'a.ts', kind: 'file' }, null, { path: 7 }, { path: 'a.ts', kind: 'dir' }] as unknown as MentionPathEntry[]
    expect(rankPaths('a', duplicates, 5).items.map(item => item.kind)).toEqual(['file', 'dir'])
    expect(rankPaths('a', null as unknown as MentionPathEntry[], 5)).toEqual({ items: [], truncated: false })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Seeded fuzzing

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const TEXT_ALPHABET = ['@', '@', '"', ' ', ' ', '\t', '\n', '\r', '\u2028', '\u00A0', 'a', 'b', 'A', '/', '.', '-', 'x@y', '@"', 'src', '\u0130', '\u00E9']
const PATH_ALPHABET = ['a', 'b', 'c', 'A', 'B', '/', '/', '.', '-', '_', ' ', '@', 'ts', 'src', 'test', '\u00E9', '\u0130', 'X', '1']

function randomString(random: () => number, alphabet: readonly string[], maxParts: number): string {
  const parts = Math.floor(random() * (maxParts + 1))
  let value = ''
  for (let index = 0; index < parts; index++)
    value += alphabet[Math.floor(random() * alphabet.length)]
  return value
}

function expectValidRanges(ranges: readonly MatchRange[], length: number, context: string): void {
  let previousEnd = -1
  for (const [start, end] of ranges) {
    expect(Number.isInteger(start) && Number.isInteger(end), context).toBe(true)
    expect(start, context).toBeGreaterThanOrEqual(0)
    expect(end, context).toBeLessThanOrEqual(length)
    expect(start, context).toBeLessThan(end)
    // Sorted and merged: a gap separates two ranges.
    expect(start, context).toBeGreaterThan(previousEnd)
    previousEnd = end
  }
}

describe('fuzzing', () => {
  it('mentionTokenAt and parseMentions keep their invariants on random texts', () => {
    const random = prng(0x5EED)
    let tokens = 0
    let mentions = 0
    for (let iteration = 0; iteration < 2000; iteration++) {
      const text = randomString(random, TEXT_ALPHABET, 14)
      const context = JSON.stringify(text)
      const found = parseMentions(text)
      let previousEnd = 0
      for (const mention of found) {
        mentions++
        expect(mention.start, context).toBeGreaterThanOrEqual(previousEnd)
        expect(mention.end, context).toBeLessThanOrEqual(text.length)
        expect(text[mention.start], context).toBe('@')
        // Never inside a word.
        if (mention.start > 0)
          expect(/\s/.test(text[mention.start - 1]!), context).toBe(true)
        expect(isMentionablePath(mention.path), context).toBe(true)
        expect(parseMentions(text.slice(mention.start, mention.end)), context).toEqual([{ path: mention.path, start: 0, end: mention.end - mention.start }])
        previousEnd = mention.end
      }
      for (let caret = 0; caret <= text.length; caret++) {
        const token = mentionTokenAt(text, caret)
        if (token === null)
          continue
        tokens++
        const where = `${context} @ ${caret}`
        expect(text[token.start], where).toBe('@')
        if (token.start > 0)
          expect(/\s/.test(text[token.start - 1]!), where).toBe(true)
        expect(token.start, where).toBeLessThan(caret)
        expect(caret, where).toBeLessThanOrEqual(token.end)
        expect(token.end, where).toBeLessThanOrEqual(text.length)
        expect(token.query, where).toBe(text.slice(token.start + (token.quoted ? 2 : 1), caret))
        expect(token.query.length, where).toBeLessThanOrEqual(MENTION_QUERY_MAX_CHARS)
        expect(/[\n\r\u2028\u2029]/.test(token.query), where).toBe(false)
        if (!token.quoted)
          expect(/\s/.test(token.query), where).toBe(false)
        // A token never sits inside a complete mention that ends before the caret.
        for (const mention of found)
          expect(mention.start < token.start && token.start < mention.end && mention.end <= caret, where).toBe(false)
      }
    }
    expect(tokens).toBeGreaterThan(500)
    expect(mentions).toBeGreaterThan(200)
  })

  it('formatMention round-trips every mentionable path', () => {
    const random = prng(20261003)
    let mentionable = 0
    for (let iteration = 0; iteration < 2000; iteration++) {
      const path = randomString(random, [...PATH_ALPHABET, '"', '\n', '\t'], 10)
      const formatted = formatMention(path)
      expect(formatted === null, JSON.stringify(path)).toBe(!isMentionablePath(path))
      if (formatted === null)
        continue
      mentionable++
      expect(parseMentions(formatted), JSON.stringify(path)).toEqual([{ path, start: 0, end: formatted.length }])
      expect(parseMentions(`see ${formatted} now`), JSON.stringify(path)).toEqual([{ path, start: 4, end: 4 + formatted.length }])
      // Typing the mention up to its end keeps the token open (until the closing quote), unless the path holds an `@`
      // after whitespace (inside an open quote, a later `@` run at the caret wins).
      const open = formatted.endsWith('"') ? formatted.slice(0, -1) : formatted
      if (!/\s@/.test(path))
        expect(mentionTokenAt(open, open.length), JSON.stringify(path)).toEqual({ start: 0, end: open.length, query: path, quoted: open !== formatted })
    }
    expect(mentionable).toBeGreaterThan(1000)
  })

  it('scorePath ranges stay in bounds, sorted, and spell the query', () => {
    const random = prng(42)
    let matched = 0
    for (let iteration = 0; iteration < 2000; iteration++) {
      const path = randomString(random, PATH_ALPHABET, 12)
      const query = random() < 0.5 ? randomString(random, PATH_ALPHABET, 3) : path.slice(Math.floor(random() * path.length), Math.floor(random() * path.length) + 2)
      const context = `${JSON.stringify(query)} in ${JSON.stringify(path)}`
      const match = scorePath(query, path)
      if (match === null)
        continue
      matched++
      expect(Number.isInteger(match.score), context).toBe(true)
      expect(match.score, context).toBeGreaterThanOrEqual(0)
      expect(match.score, context).toBeLessThan(5000)
      expectValidRanges(match.ranges, path.length, context)
      // The highlighted characters are the query (case-insensitively, per UTF-16 code unit).
      expect(highlighted(path, match.ranges).length, context).toBe(query.length)
      expect(scorePath(highlighted(path, match.ranges), query), context).not.toBeNull()
      expect(scorePath(query, path), context).toEqual(match)
    }
    expect(matched).toBeGreaterThan(800)
  })

  it('rankPaths is deterministic and independent of the input order', () => {
    const random = prng(7)
    for (let iteration = 0; iteration < 200; iteration++) {
      const paths = new Set<string>()
      const count = Math.floor(random() * 30)
      for (let index = 0; index < count; index++)
        paths.add(randomString(random, PATH_ALPHABET, 8))
      const list: MentionPathEntry[] = [...paths].map(path => ({ path, kind: random() < 0.3 ? 'dir' : 'file' }))
      const shuffled = [...list]
      for (let index = shuffled.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1))
        ;[shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!]
      }
      const query = randomString(random, PATH_ALPHABET, 2)
      const limit = Math.floor(random() * 12)
      const context = `${JSON.stringify(query)} limit ${limit}`
      const ranked = rankPaths(query, list, limit)
      expect(rankPaths(query, shuffled, limit), context).toEqual(ranked)
      expect(ranked.items.length, context).toBeLessThanOrEqual(limit)
      const all = rankPaths(query, list, Number.POSITIVE_INFINITY)
      expect(ranked.truncated, context).toBe(all.items.length > limit)
      expect(ranked.items, context).toEqual(all.items.slice(0, limit))
      expect(all.items.length, context).toBe(list.filter(entry => scorePath(query, entry.path) !== null).length)
      const scores = all.items.map(item => scorePath(query, item.path)!.score)
      for (let index = 1; index < scores.length; index++)
        expect(scores[index - 1]!, context).toBeGreaterThanOrEqual(scores[index]!)
      for (const item of all.items)
        expectValidRanges(item.ranges, item.path.length, context)
    }
  })
})
