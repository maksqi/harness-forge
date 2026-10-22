import type { ToolMode } from '../enums.ts'
import type { ModelWebSearchKind, WebSearchResolution, WebSearchResolveInput } from './web-search.ts'
import { describe, expect, it } from 'vitest'
import {
  isProviderExecutedPart,
  MODEL_WEB_SEARCH_KINDS,
  resolveWebSearch,
  SEARCH_WEB_TOOL_NAME,
  sourceDomain,
  WEB_SEARCH_BACKENDS,
  WEB_SEARCH_MAX_USES,
  WEB_SEARCH_MODES,
  WEB_SEARCH_UNAVAILABLE_REASONS,
} from './web-search.ts'

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const TOOL_MODES: readonly ToolMode[] = ['off', 'ask', 'edits', 'plan', 'auto']

/** A turn in `auto` mode, Ask tool mode, a model with tools, no native search, no backend key. */
const BASE: WebSearchResolveInput = {
  mode: 'auto',
  toolMode: 'ask',
  native: null,
  preferNative: true,
  builtinAvailable: false,
  modelTools: true,
  functionTools: 1,
}

describe('constants', () => {
  it('keeps the contract values', () => {
    expect(SEARCH_WEB_TOOL_NAME).toBe('search_web')
    expect(WEB_SEARCH_MAX_USES).toBe(5)
    expect(WEB_SEARCH_MODES).toEqual(['off', 'auto'])
    expect(MODEL_WEB_SEARCH_KINDS).toEqual(['native', 'exclusive'])
    expect(WEB_SEARCH_UNAVAILABLE_REASONS).toEqual(['tool-mode-off', 'tools-conflict', 'tools-unsupported', 'no-backend'])
    expect(WEB_SEARCH_BACKENDS).toEqual(['brave', 'tavily', 'exa'])
  })
})

describe('resolveWebSearch: the rules in order', () => {
  it.each<[string, Partial<WebSearchResolveInput>, WebSearchResolution]>([
    // 1. mode off wins over everything
    ['mode off', { mode: 'off', native: 'native', builtinAvailable: true }, { kind: 'off' }],
    ['mode off with tools off', { mode: 'off', toolMode: 'off' }, { kind: 'off' }],
    // 2. tool mode off
    ['tool mode off with native search', { toolMode: 'off', native: 'native' }, { kind: 'unavailable', reason: 'tool-mode-off' }],
    ['tool mode off with a backend', { toolMode: 'off', builtinAvailable: true }, { kind: 'unavailable', reason: 'tool-mode-off' }],
    // 3. native and preferred
    ['native, preferred', { native: 'native' }, { kind: 'native', exclusive: false }],
    ['native, preferred, with a backend too', { native: 'native', builtinAvailable: true }, { kind: 'native', exclusive: false }],
    ['native, preferred, model without tools (OpenRouter plugin)', { native: 'native', modelTools: false }, { kind: 'native', exclusive: false }],
    ['native, preferred, many function tools', { native: 'native', functionTools: 30 }, { kind: 'native', exclusive: false }],
    // 4. exclusive native without other function tools
    ['exclusive, preferred, no function tools', { native: 'exclusive', functionTools: 0 }, { kind: 'native', exclusive: true }],
    ['exclusive, preferred, no function tools, backend too', { native: 'exclusive', functionTools: 0, builtinAvailable: true }, { kind: 'native', exclusive: true }],
    // 5. builtin
    ['no native, backend', { builtinAvailable: true }, { kind: 'builtin' }],
    ['native not preferred, backend', { native: 'native', preferNative: false, builtinAvailable: true }, { kind: 'builtin' }],
    ['exclusive with function tools, backend', { native: 'exclusive', builtinAvailable: true }, { kind: 'builtin' }],
    ['exclusive not preferred, no function tools, backend', { native: 'exclusive', preferNative: false, functionTools: 0, builtinAvailable: true }, { kind: 'builtin' }],
    // 6. unavailable
    ['exclusive with function tools, no backend', { native: 'exclusive' }, { kind: 'unavailable', reason: 'tools-conflict' }],
    ['exclusive with function tools, backend but no tool support', { native: 'exclusive', builtinAvailable: true, modelTools: false }, { kind: 'unavailable', reason: 'tools-conflict' }],
    ['no native, backend, model without tools', { builtinAvailable: true, modelTools: false }, { kind: 'unavailable', reason: 'tools-unsupported' }],
    ['no native, no backend, model without tools', { modelTools: false }, { kind: 'unavailable', reason: 'tools-unsupported' }],
    ['native not preferred, model without tools', { native: 'native', preferNative: false, modelTools: false, builtinAvailable: true }, { kind: 'unavailable', reason: 'tools-unsupported' }],
    ['no native, no backend', {}, { kind: 'unavailable', reason: 'no-backend' }],
    ['native not preferred, no backend', { native: 'native', preferNative: false }, { kind: 'unavailable', reason: 'no-backend' }],
    ['exclusive not preferred, no backend', { native: 'exclusive', preferNative: false, functionTools: 0 }, { kind: 'unavailable', reason: 'no-backend' }],
  ])('%s', (_label, change, expected) => {
    expect(resolveWebSearch({ ...BASE, ...change })).toEqual(expected)
  })

  it('lets Plan, Accept edits, Ask and Auto search (it is read-only)', () => {
    for (const toolMode of ['ask', 'edits', 'plan', 'auto'] as const) {
      expect(resolveWebSearch({ ...BASE, toolMode, native: 'native' })).toEqual({ kind: 'native', exclusive: false })
      expect(resolveWebSearch({ ...BASE, toolMode, builtinAvailable: true })).toEqual({ kind: 'builtin' })
    }
  })

  /** An independent statement of the rules: every reachable outcome with the conditions that lead to it. */
  function expected(input: WebSearchResolveInput): WebSearchResolution {
    const { mode, toolMode, native, preferNative, builtinAvailable, modelTools, functionTools } = input
    const outcomes: [boolean, WebSearchResolution][] = [
      [mode === 'off', { kind: 'off' }],
      [toolMode === 'off', { kind: 'unavailable', reason: 'tool-mode-off' }],
      [native === 'native' && preferNative, { kind: 'native', exclusive: false }],
      [native === 'exclusive' && preferNative && functionTools === 0, { kind: 'native', exclusive: true }],
      [builtinAvailable && modelTools, { kind: 'builtin' }],
      [native === 'exclusive' && preferNative && functionTools > 0, { kind: 'unavailable', reason: 'tools-conflict' }],
      [!modelTools, { kind: 'unavailable', reason: 'tools-unsupported' }],
      [true, { kind: 'unavailable', reason: 'no-backend' }],
    ]
    return outcomes.find(([applies]) => applies)![1]
  }

  it('matches the full truth table', () => {
    const natives: readonly (ModelWebSearchKind | null)[] = [null, 'native', 'exclusive']
    let cases = 0
    const seen = new Set<string>()
    for (const mode of WEB_SEARCH_MODES) {
      for (const toolMode of TOOL_MODES) {
        for (const native of natives) {
          for (const preferNative of [false, true]) {
            for (const builtinAvailable of [false, true]) {
              for (const modelTools of [false, true]) {
                for (const functionTools of [0, 1, 7]) {
                  const input = { mode, toolMode, native, preferNative, builtinAvailable, modelTools, functionTools }
                  const result = resolveWebSearch(input)
                  expect(result, JSON.stringify(input)).toEqual(expected(input))
                  seen.add(JSON.stringify(result))
                  cases++
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(720)
    // Every outcome is reachable.
    expect(seen.size).toBe(1 + 2 + 1 + WEB_SEARCH_UNAVAILABLE_REASONS.length)
  })

  it('reads hostile input defensively and never throws', () => {
    const resolve = (input: unknown) => resolveWebSearch(input as WebSearchResolveInput)
    for (const input of [null, undefined, 5, 'auto', [], {}])
      expect(resolve(input)).toEqual({ kind: 'off' })
    expect(resolve({ ...BASE, mode: 'on' })).toEqual({ kind: 'off' })
    expect(resolve({ ...BASE, mode: 'AUTO' })).toEqual({ kind: 'off' })
    expect(resolve({ ...BASE, native: 'yes' })).toEqual({ kind: 'unavailable', reason: 'no-backend' })
    expect(resolve({ ...BASE, native: 'native', preferNative: 'true' })).toEqual({ kind: 'unavailable', reason: 'no-backend' })
    expect(resolve({ ...BASE, builtinAvailable: 1 })).toEqual({ kind: 'unavailable', reason: 'no-backend' })
    // A missing or odd function tool count keeps an exclusive model away from native search.
    for (const functionTools of [undefined, Number.NaN, '0', null])
      expect(resolve({ ...BASE, native: 'exclusive', functionTools })).toEqual({ kind: 'unavailable', reason: 'tools-conflict' })
    expect(resolve({ ...BASE, native: 'exclusive', functionTools: -1 })).toEqual({ kind: 'native', exclusive: true })
    const trap = Object.defineProperty({ ...BASE }, 'toolMode', { get() {
      throw new Error('boom')
    } })
    expect(resolve(trap)).toEqual({ kind: 'off' })
  })
})

describe('isProviderExecutedPart', () => {
  it.each<[string, unknown, boolean]>([
    ['a provider-executed UI tool part', { type: 'tool-web_search', toolCallId: 'srvtoolu_1', state: 'output-available', input: { query: 'x' }, output: [], providerExecuted: true }, true],
    ['a provider-executed Google search part', { type: 'tool-google_search', toolCallId: 'c1', state: 'input-available', providerExecuted: true }, true],
    ['a provider-executed dynamic tool part', { type: 'dynamic-tool', toolName: 'web_search', toolCallId: 'c1', state: 'output-available', providerExecuted: true }, true],
    ['a provider-executed model tool call', { type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: {}, providerExecuted: true }, true],
    ['a provider-executed model tool result', { type: 'tool-result', toolCallId: 'c1', toolName: 'web_search', output: {}, providerExecuted: true }, true],
    ['a provider-executed stream chunk', { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_search', input: {}, providerExecuted: true }, true],
    ['a client tool part', { type: 'tool-search_web', toolCallId: 'c1', state: 'output-available' }, false],
    ['an explicit false', { type: 'tool-web_search', toolCallId: 'c1', providerExecuted: false }, false],
    ['a string flag', { type: 'tool-web_search', providerExecuted: 'true' }, false],
    ['a numeric flag', { type: 'tool-web_search', providerExecuted: 1 }, false],
    ['a text part', { type: 'text', text: 'x', providerExecuted: true }, false],
    ['a source part', { type: 'source-url', sourceId: 's', url: 'https://example.com', providerExecuted: true }, false],
    ['a bare tool- prefix', { type: 'tool-', providerExecuted: true }, false],
    ['a type that is not a string', { type: 5, providerExecuted: true }, false],
    ['no type', { providerExecuted: true }, false],
    ['an inherited flag', Object.create({ type: 'tool-web_search', providerExecuted: true }), false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['a string', 'tool-web_search', false],
    ['a number', 1, false],
    ['an array', [{ type: 'tool-web_search', providerExecuted: true }], false],
  ])('%s → %s', (_label, part, expected) => {
    expect(isProviderExecutedPart(part)).toBe(expected)
  })

  it('never throws on getters that throw', () => {
    const trap = Object.defineProperty({ type: 'tool-web_search' }, 'providerExecuted', { enumerable: true, get() {
      throw new Error('boom')
    } })
    expect(isProviderExecutedPart(trap)).toBe(false)
    expect(isProviderExecutedPart(new Proxy({}, { has: () => {
      throw new Error('boom')
    }, getOwnPropertyDescriptor: () => {
      throw new Error('boom')
    } }))).toBe(false)
  })
})

describe('sourceDomain', () => {
  it.each<[string, string | null]>([
    ['https://example.com/a?b=1#c', 'example.com'],
    ['https://www.Example.com/path', 'example.com'],
    ['HTTPS://WWW.EXAMPLE.COM', 'example.com'],
    ['http://example.com:8080/x', 'example.com'],
    ['https://user:pass@docs.example.org/x', 'docs.example.org'],
    ['https://sub.www.example.com', 'sub.www.example.com'],
    ['https://www2.example.com', 'www2.example.com'],
    ['https://www.com', 'www.com'],
    ['https://example.com./', 'example.com'],
    // Internationalized hosts show as punycode, so a lookalike Unicode domain stays visible.
    ['https://münchen.de/stadt', 'xn--mnchen-3ya.de'],
    ['https://www.MÜNCHEN.de', 'xn--mnchen-3ya.de'],
    ['https://user@münchen.de:8443/', 'xn--mnchen-3ya.de'],
    ['https://xn--mnchen-3ya.de/', 'xn--mnchen-3ya.de'],
    ['https://XN--MNCHEN-3YA.DE/', 'xn--mnchen-3ya.de'],
    ['https://例え.jp/', 'xn--r8jz45g.jp'],
    ['https://\uFF45\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45.com', 'example.com'],
    ['https://ex%61mple.com/', 'example.com'],
    ['http://0x7f.1/', '127.0.0.1'],
    ['http://[::1]:8080/', '[::1]'],
    ['https://evil.example\\@good.example/', 'evil.example'],
    ['  https://example.com  ', 'example.com'],
    ['ftp://example.com/file', null],
    ['mailto:ada@example.com', null],
    ['javascript:alert(1)', null],
    ['data:text/plain,hello', null],
    ['file:///etc/hosts', null],
    ['example.com', null],
    ['/relative/path', null],
    ['//example.com', null],
    ['https://', null],
    ['', null],
  ])('%j → %j', (url, expected) => {
    expect(sourceDomain(url)).toBe(expected)
  })

  it('never throws on values that are not strings', () => {
    for (const value of [null, undefined, 5, {}, [], new URL('https://example.com')])
      expect(sourceDomain(value as unknown as string)).toBeNull()
  })
})

// Seeded fuzz loops run several times slower on CI runners than locally: a generous timeout above the time budget.
describe('fuzzing', { timeout: 30_000 }, () => {
  it('never throws on random input and keeps its invariants', () => {
    const random = prng(0x5EA2)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const leaves: unknown[] = [null, undefined, true, false, 0, 1, -1, Number.NaN, '', 'auto', 'off', 'native', 'exclusive', 'ask', 'plan', 'tool-x', 'dynamic-tool', 'tool-call', 'text']
    const value = (depth: number): unknown => {
      const roll = random()
      if (depth > 3 || roll < 0.5)
        return pick(leaves)
      if (roll < 0.6)
        return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1))
      const object: Record<string, unknown> = {}
      for (const key of ['mode', 'toolMode', 'native', 'preferNative', 'builtinAvailable', 'modelTools', 'functionTools', 'type', 'providerExecuted']) {
        if (random() < 0.6)
          object[key] = value(depth + 1)
      }
      return object
    }
    const urlPieces = ['https://', 'http://', 'ftp://', 'www.', 'WWW.', 'example', '.com', '.', ':', '8080', '@', '/', '?', '#', '\\', '[', ']', '::1', 'xn--', 'ü', '例', '%41', ' ', '\u0000', '-', 'a']
    const started = Date.now()
    const kinds = new Set(['off', 'native', 'builtin', 'unavailable'])
    for (let iteration = 0; iteration < 5000; iteration++) {
      const input = value(0)
      const resolution = resolveWebSearch(input as WebSearchResolveInput)
      expect(kinds.has(resolution.kind)).toBe(true)
      if (resolution.kind === 'unavailable')
        expect(WEB_SEARCH_UNAVAILABLE_REASONS).toContain(resolution.reason)
      expect(typeof isProviderExecutedPart(input)).toBe('boolean')
      let url = ''
      for (let count = Math.floor(random() * 10); count > 0; count--)
        url += pick(urlPieces)
      const domain = sourceDomain(url)
      if (domain !== null) {
        expect(domain.length).toBeGreaterThan(0)
        expect(domain).toBe(domain.toLowerCase())
        expect(domain).not.toMatch(/[\s/?#@\\]/)
        expect(domain).toMatch(/^[\x21-\x7E]+$/)
        expect(/https?:/i.test(url)).toBe(true)
      }
    }
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})
