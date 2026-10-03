import { describe, expect, it } from 'vitest'
import {
  likeContainsPattern,
  makeSnippet,
  messagePlainText,
  normalizeForSearch,
  replaceControlChars,
  sanitizeTitle,
  SNIPPET_MAX_LENGTH,
  titleMatches,
  toSearchText,
  truncateCodePoints,
  wellFormed,
} from './text.ts'

// The Greek word for "world" in three casings: non-ASCII letters that SQLite's LIKE does not fold.
const GREEK_WORLD_UPPER = '\u039A\u039F\u03A3\u039C\u039F\u03A3'
const GREEK_WORLD_LOWER = '\u03BA\u03BF\u03C3\u03BC\u03BF\u03C2'
const GREEK_WORLD_TITLE = '\u039A\u03BF\u03C3\u03BC\u03BF\u03C2'

describe('message text', () => {
  it('joins the text parts and ignores every other part', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'text', text: 'First' },
      { type: 'reasoning', text: 'hidden thoughts' },
      { type: 'tool-web_fetch', toolCallId: 'x', state: 'output-available', input: { url: 'u' }, output: 'o' },
      { type: 'text', text: 'Second' },
      { type: 'file', mediaType: 'image/png', url: '/api/files/file_0000000000000000' },
      null,
    ]
    expect(messagePlainText(parts)).toBe('First\nSecond')
  })

  it('includes the text of steers at their place, never compaction summaries or notices (Phase 9)', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'text', text: 'Working on it' },
      {
        type: 'data-steer',
        id: 'steer_1',
        data: {
          id: 'msg_steer00000000001',
          parts: [{ type: 'text', text: 'Also cover the PINEAPPLE case' }, { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/files/file_0000000000000001' }],
          queuedAt: 1,
          deliveredAt: 2,
        },
      },
      { type: 'step-start' },
      { type: 'text', text: 'Done' },
      {
        type: 'data-compaction',
        data: { trigger: 'auto', keep: 'last-user', summary: 'SECRET-SUMMARY of the work', modelRef: 'mock:compact', messagesCompacted: 4, tokensBefore: 900, tokensAfter: 100, createdAt: 3 },
      },
      { type: 'data-notice', data: { level: 'warning', code: 'compaction-failed', message: 'NOTICE-TEXT' } },
      // An invalid steer is not text.
      { type: 'data-steer', data: { id: 'not-an-id', parts: [{ type: 'text', text: 'INVALID-STEER' }], queuedAt: 1, deliveredAt: 2 } },
    ]
    expect(messagePlainText(parts)).toBe('Working on it\nAlso cover the PINEAPPLE case\nDone')
    const search = toSearchText(parts)
    expect(search).toContain('pineapple')
    expect(search).not.toContain('secret-summary')
    expect(search).not.toContain('notice-text')
    expect(search).not.toContain('invalid-steer')
    // A /compact reply (only the marker) has no search text.
    expect(toSearchText([{ type: 'step-start' }, parts[5]])).toBe('')
    // A user message that is only a steer still reads as text.
    expect(messagePlainText([parts[2]])).toBe('Also cover the PINEAPPLE case')
  })

  it('stores search text NFC-normalized and lowercased with Unicode rules', () => {
    expect(toSearchText([{ type: 'text', text: `Hello \u00DCBER ${GREEK_WORLD_UPPER}` }])).toBe(`hello \u00FCber ${GREEK_WORLD_LOWER}`)
    // A decomposed "e" + combining acute becomes the composed character.
    expect(toSearchText([{ type: 'text', text: 'Cafe\u0301' }])).toBe('caf\u00E9')
  })
})

describe('like patterns and title matches', () => {
  it('escapes %, _ and the escape character', () => {
    expect(likeContainsPattern('100%')).toBe('%100\\%%')
    expect(likeContainsPattern('a_b')).toBe('%a\\_b%')
    expect(likeContainsPattern('c:\\dir')).toBe('%c:\\\\dir%')
  })

  it('matches titles case-insensitively across scripts', () => {
    expect(titleMatches(`Hi, ${GREEK_WORLD_UPPER}`, normalizeForSearch(GREEK_WORLD_LOWER))).toBe(true)
    expect(titleMatches('Straße Plans', normalizeForSearch('STRASSE'))).toBe(false)
    expect(titleMatches('Refactor AUTH flow', normalizeForSearch('auth'))).toBe(true)
    expect(titleMatches(null, 'auth')).toBe(false)
  })
})

describe('makeSnippet', () => {
  const long = `${'lorem ipsum '.repeat(30)}the NEEDLE is here ${'dolor sit amet '.repeat(30)}`

  it('returns short text whole, with whitespace collapsed', () => {
    expect(makeSnippet('  one\n\ntwo\tthree ', 'two')).toBe('one two three')
  })

  it('cuts long text around the first case-insensitive match', () => {
    const snippet = makeSnippet(long, 'needle')
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH)
    expect(snippet).toContain('the NEEDLE is here')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('starts at the beginning when the query is not in the text', () => {
    const snippet = makeSnippet(long, 'absent')
    expect(snippet.startsWith('lorem ipsum')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH)
  })

  it('uses the whole window for a match near the end', () => {
    const text = `${'a'.repeat(300)} final match`
    const snippet = makeSnippet(text, 'match')
    expect(snippet.endsWith('final match')).toBe(true)
    expect(snippet.length).toBe(SNIPPET_MAX_LENGTH)
  })

  it('never splits a surrogate pair and treats regex characters literally', () => {
    const emoji = '\u{1F600}'.repeat(200)
    const snippet = makeSnippet(`${emoji} (a+b)* ${emoji}`, '(a+b)*')
    expect(snippet).toContain('(a+b)*')
    expect(wellFormed(snippet)).toBe(snippet)
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH)
  })

  it('finds Unicode matches case-insensitively', () => {
    const text = `${'x '.repeat(100)}${GREEK_WORLD_TITLE} end ${'y '.repeat(100)}`
    expect(makeSnippet(text, GREEK_WORLD_UPPER)).toContain(`${GREEK_WORLD_TITLE} end`)
  })
})

describe('titles and strings', () => {
  it('sanitizes titles: control characters, line breaks, whitespace, length', () => {
    expect(sanitizeTitle('  Hello\nworld\t\u0007!  ')).toBe('Hello world !')
    expect(sanitizeTitle('evil\u202Egnp.exe')).toBe('evil gnp.exe')
    expect(sanitizeTitle(' \n\t ')).toBeNull()
    expect(Array.from(sanitizeTitle('\u{1F600}'.repeat(250))!)).toHaveLength(200)
  })

  it('replaces lone surrogates and control characters', () => {
    expect(wellFormed('a\uD800b\uDC00c\u{1F600}')).toBe('a\uFFFDb\uFFFDc\u{1F600}')
    expect(replaceControlChars('a\u0000b\u009Fc', '')).toBe('abc')
    expect(truncateCodePoints('\u{1F600}\u{1F601}\u{1F602}', 2)).toBe('\u{1F600}\u{1F601}')
  })
})
