// Unique test data, so specs never depend on each other or on leftovers of an earlier run on the same server.
import { randomBytes } from 'node:crypto'

let sequence = 0

/** A short id that is unique across tests, workers and runs: `<prefix>-<time><seq><random>` (lowercase, no spaces). */
export function uniqueId(prefix = 'e2e'): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}${sequence.toString(36)}${randomBytes(3).toString('hex')}`
}

/** `count` plain words (`word1 word2 ...`, prefixed), e.g. for a message that streams for a while. */
export function wordList(count: number, prefix = 'word'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`)
}

/** The first `count` whitespace-separated words of `text`, joined with single spaces. */
export function firstWords(text: string, count: number): string {
  return text.split(/\s+/).filter(word => word !== '').slice(0, count).join(' ')
}

/**
 * A pattern that matches `text` in rendered markdown, where the typographer turns straight quotes into curly ones
 * (`"a"` renders as `“a”`): `await expect(message).toContainText(looseQuotes('Tool result: {"a":1}'))`.
 */
export function looseQuotes(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(/"/g, '["“”]').replace(/'/g, '[\'‘’]'))
}
