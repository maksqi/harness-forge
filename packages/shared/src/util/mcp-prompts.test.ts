import type { McpPromptArgument, McpPromptBinding } from './mcp-prompts.ts'
import { describe, expect, it } from 'vitest'
import { MCP_SERVER_ID_PATTERN, mcpToolName } from '../ids.ts'
import { DEFINITION_LIMITS } from './definitions.ts'
import {
  bindMcpPromptArguments,
  isMcpPromptCommandName,
  MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS,
  MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS,
  MCP_PROMPT_ARGUMENTS_MAX,
  MCP_PROMPT_INPUT_MAX_CHARS,
  MCP_PROMPT_NAME_PATTERN,
  MCP_PROMPT_PREFIX,
  mcpPromptArgumentHint,
  mcpPromptCommandName,
  mcpPromptServerId,
} from './mcp-prompts.ts'

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const required = (name: string): McpPromptArgument => ({ name, required: true })
const optional = (name: string): McpPromptArgument => ({ name })

// ---------------------------------------------------------------------------------------------------------------------
// Names

describe('mcp prompt command names', () => {
  it('builds names like mcpToolName (sanitized, at most 64 characters)', () => {
    expect(MCP_PROMPT_PREFIX).toBe('mcp__')
    expect(mcpPromptCommandName('github', 'create_pr')).toBe('mcp__github__create_pr')
    expect(mcpPromptCommandName('github', 'review code.v2')).toBe('mcp__github__review_code_v2')
    const long = mcpPromptCommandName('my-server', 'p'.repeat(80))
    expect(long).toHaveLength(64)
    expect(long).toBe(mcpToolName('my-server', 'p'.repeat(80)))
    for (const name of ['mcp__github__create_pr', long, mcpPromptCommandName('a', '')])
      expect(isMcpPromptCommandName(name)).toBe(true)
  })

  it.each([
    ['mcp__github__create_pr', true],
    ['mcp__a', true],
    [`mcp__${'a'.repeat(59)}`, true],
    [`mcp__${'a'.repeat(60)}`, false],
    ['mcp__', false],
    ['MCP__a__b', false],
    ['mcp__a b', false],
    ['mcp__a:b', false],
    ['mcp__a__b\n', false],
    ['review', false],
    ['/mcp__a__b', false],
  ])('isMcpPromptCommandName(%j) → %s', (name, expected) => {
    expect(isMcpPromptCommandName(name)).toBe(expected)
    expect(MCP_PROMPT_NAME_PATTERN.test(name)).toBe(expected)
  })

  it('rejects non-strings', () => {
    expect(isMcpPromptCommandName(undefined as unknown as string)).toBe(false)
    expect(isMcpPromptCommandName(7 as unknown as string)).toBe(false)
  })

  it.each([
    ['mcp__github__create_pr', 'github'],
    ['mcp__my-server__x', 'my-server'],
    ['mcp__a___b', 'a'],
    ['mcp__a__', 'a'],
    ['mcp__github', null],
    ['mcp____x', null],
    ['mcp__Git__x', null],
    ['mcp__-a__x', null],
    [`mcp__${'a'.repeat(33)}__x`, null],
    ['review', null],
  ])('mcpPromptServerId(%j) → %j', (name, serverId) => {
    expect(mcpPromptServerId(name)).toBe(serverId)
  })

  it('finds the server id of every built name, shortened ones included', () => {
    const random = prng(0xC49)
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_ .:/é'
    for (let iteration = 0; iteration < 500; iteration++) {
      const length = 1 + Math.floor(random() * 32)
      let serverId = ''
      for (let index = 0; index < length; index++)
        serverId += 'abcdefghijklmnopqrstuvwxyz0123456789-'[Math.floor(random() * 37)]
      serverId = serverId.replace(/^-+|-+$/g, '') || 'x'
      if (!MCP_SERVER_ID_PATTERN.test(serverId))
        continue
      let prompt = ''
      for (let index = Math.floor(random() * 90); index > 0; index--)
        prompt += alphabet[Math.floor(random() * alphabet.length)]
      const name = mcpPromptCommandName(serverId, prompt)
      expect(name.length).toBeLessThanOrEqual(64)
      expect(isMcpPromptCommandName(name), name).toBe(true)
      expect(mcpPromptServerId(name), name).toBe(serverId)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Argument hint

describe('mcpPromptArgumentHint', () => {
  it('uses the cap of every other argument hint', () => {
    expect(MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS).toBe(DEFINITION_LIMITS.argumentHintMaxChars)
  })

  it.each([
    [[], null],
    [[required('pr'), optional('base')], '<pr> [base]'],
    [[optional('base'), required('pr')], '[base] <pr>'],
    [[{ name: 'q', required: false, description: 'Query' }], '[q]'],
    [[{ name: 'pr number', required: true }], '<pr_number>'],
    [[required('<x>'), optional('[y]')], '<_x_> [_y_]'],
    [[required('a\u0007\u200Bb\tc\n')], '<ab_c_>'],
    [[required('\u0007'), optional('ok')], '<arg1> [ok]'],
    [[required('título')], '<título>'],
    [[required('a'), required('a'), optional('b')], '<a> [b]'],
    [[null, 3, { name: 4 }, { name: '' }, { required: true }, optional('x')], '[x]'],
  ] as Array<[unknown[], string | null]>)('%j → %j', (args, hint) => {
    expect(mcpPromptArgumentHint(args as McpPromptArgument[])).toBe(hint)
  })

  it('shortens long names and long hints', () => {
    const long = 'n'.repeat(40)
    expect(mcpPromptArgumentHint([required(long)])).toBe(`<${'n'.repeat(31)}…>`)
    const many = Array.from({ length: 12 }, (_, index) => required(`argument_${index}`))
    const hint = mcpPromptArgumentHint(many)!
    expect(hint.length).toBeLessThanOrEqual(MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS)
    expect(hint.endsWith(' …')).toBe(true)
    expect(hint.startsWith('<argument_0> <argument_1> ')).toBe(true)
    expect(hint).not.toContain('<argument_11>')
    // Whole items only.
    expect(hint.slice(0, -2).split(' ').every(item => /^<argument_\d+>$/.test(item))).toBe(true)
  })

  it('reads the first MCP_PROMPT_ARGUMENTS_MAX entries only', () => {
    const args = Array.from({ length: MCP_PROMPT_ARGUMENTS_MAX + 5 }, (_, index) => optional(String.fromCharCode(97 + index)))
    const hint = mcpPromptArgumentHint(args)!
    expect(hint).toContain('[t]')
    expect(hint).not.toContain('[u]')
  })

  it('never throws on malformed input', () => {
    expect(mcpPromptArgumentHint(null as unknown as McpPromptArgument[])).toBeNull()
    expect(mcpPromptArgumentHint('a' as unknown as McpPromptArgument[])).toBeNull()
    const throwing = Object.defineProperty({}, 'name', {
      get: () => {
        throw new Error('no')
      },
    })
    expect(mcpPromptArgumentHint([throwing as McpPromptArgument, required('ok')])).toBe('<ok>')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Binding

describe('bindMcpPromptArguments', () => {
  const prBase = [required('pr'), optional('base')]
  const ok = (values: Record<string, string>): McpPromptBinding => ({ ok: true, values })
  const missing = (...names: string[]): McpPromptBinding => ({ ok: false, missing: names })

  it.each([
    // positional, in declared order; the last argument takes the rest
    ['', missing('pr')],
    ['   ', missing('pr')],
    ['42', ok({ pr: '42' })],
    ['42 main', ok({ pr: '42', base: 'main' })],
    ['42 main extra  words', ok({ pr: '42', base: 'main extra words' })],
    ['  42 \t\n main\nmore  ', ok({ pr: '42', base: 'main more' })],
    // by name
    ['base=dev 42', ok({ pr: '42', base: 'dev' })],
    ['base=dev 42 and more', ok({ pr: '42 and more', base: 'dev' })],
    ['pr=7 base=dev', ok({ pr: '7', base: 'dev' })],
    ['base=dev', missing('pr')],
    ['pr=1 pr=2', ok({ pr: '2' })],
    ['pr=a=b', ok({ pr: 'a=b' })],
    ['pr=', missing('pr')],
    ['pr= main', missing('pr')],
    // every argument by name: the rest continues the argument named before it, else the last one
    ['pr=7 base=dev more words', ok({ pr: '7', base: 'dev more words' })],
    ['pr=7 more base=dev', ok({ pr: '7 more', base: 'dev' })],
    ['more pr=7 base=dev', ok({ pr: '7', base: 'dev more' })],
    // undeclared or quoted names are plain positional words
    ['x=y', ok({ pr: 'x=y' })],
    ['x=y base=dev', ok({ pr: 'x=y', base: 'dev' })],
    ['"base=dev" 42', ok({ pr: 'base=dev', base: '42' })],
    ['\'pr=1\'', ok({ pr: 'pr=1' })],
    ['ba"se"=dev', ok({ pr: 'base=dev' })],
    ['=dev', ok({ pr: '=dev' })],
    ['PR=1', ok({ pr: 'PR=1' })],
    // quoting
    ['"a b" c', ok({ pr: 'a b', base: 'c' })],
    ['\'a b\' \'c d\'', ok({ pr: 'a b', base: 'c d' })],
    ['a"b c"d e', ok({ pr: 'ab cd', base: 'e' })],
    ['"unclosed quote', ok({ pr: 'unclosed quote' })],
    ['42 \'unclosed  rest', ok({ pr: '42', base: 'unclosed  rest' })],
    ['"say \\"hi\\"" x', ok({ pr: 'say "hi"', base: 'x' })],
    ['"a\\b" c\\d', ok({ pr: 'a\\b', base: 'c\\d' })],
    ['\'a\\\'', ok({ pr: 'a\\' })],
    ['pr="Fix the bug" base=\'release 2\'', ok({ pr: 'Fix the bug', base: 'release 2' })],
    // an empty word fills its argument with nothing
    ['"" main', missing('pr')],
    ['42 ""', ok({ pr: '42' })],
  ] as Array<[string, McpPromptBinding]>)('%j', (input, expected) => {
    expect(bindMcpPromptArguments(prBase, input)).toEqual(expected)
  })

  it('skips an optional argument with an empty word', () => {
    const args = [optional('a'), required('b'), optional('c')]
    expect(bindMcpPromptArguments(args, '"" x')).toEqual(ok({ b: 'x' }))
    expect(bindMcpPromptArguments(args, 'x')).toEqual(missing('b'))
    expect(bindMcpPromptArguments(args, 'b=x c=y z')).toEqual(ok({ a: 'z', b: 'x', c: 'y' }))
  })

  it('reports every missing required argument in declared order', () => {
    const args = [required('a'), optional('b'), required('c')]
    expect(bindMcpPromptArguments(args, '')).toEqual(missing('a', 'c'))
    expect(bindMcpPromptArguments(args, 'x')).toEqual(missing('c'))
    expect(bindMcpPromptArguments(args, 'x y')).toEqual(missing('c'))
    expect(bindMcpPromptArguments(args, 'x y z w')).toEqual(ok({ a: 'x', b: 'y', c: 'z w' }))
    expect(bindMcpPromptArguments(args, 'c=1 x')).toEqual(ok({ a: 'x', c: '1' }))
  })

  it('binds optional-only prompts and ignores input without arguments', () => {
    expect(bindMcpPromptArguments([optional('q')], '')).toEqual(ok({}))
    expect(bindMcpPromptArguments([optional('q')], 'what is new')).toEqual(ok({ q: 'what is new' }))
    expect(bindMcpPromptArguments([], 'anything at all')).toEqual(ok({}))
  })

  it('keeps argument names that are Object.prototype members as plain keys', () => {
    const bound = bindMcpPromptArguments([required('__proto__'), optional('constructor')], 'x') as Extract<McpPromptBinding, { ok: true }>
    expect(bound.ok).toBe(true)
    expect(Object.getPrototypeOf(bound.values)).toBe(Object.prototype)
    expect(Object.keys(bound.values)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(bound.values, '__proto__')?.value).toBe('x')
    expect(bindMcpPromptArguments([required('constructor')], '')).toEqual(missing('constructor'))
    expect(bindMcpPromptArguments([optional('a'), required('toString')], 'toString=1')).toEqual(ok({ toString: '1' }))
  })

  it('reads the first MCP_PROMPT_ARGUMENTS_MAX declared arguments only', () => {
    const args = Array.from({ length: MCP_PROMPT_ARGUMENTS_MAX + 1 }, (_, index) => required(`a${index}`))
    const words = Array.from({ length: MCP_PROMPT_ARGUMENTS_MAX }, (_, index) => `v${index}`)
    const bound = bindMcpPromptArguments(args, `${words.join(' ')} a20=late`)
    expect(bound.ok).toBe(true)
    const values = (bound as Extract<McpPromptBinding, { ok: true }>).values
    expect(Object.keys(values)).toHaveLength(MCP_PROMPT_ARGUMENTS_MAX)
    expect(values.a19).toBe('v19 a20=late')
    expect(values).not.toHaveProperty('a20')
  })

  it('caps values and the input without splitting a surrogate pair', () => {
    const big = 'x'.repeat(MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS + 10)
    expect(bindMcpPromptArguments([required('a')], big)).toEqual(ok({ a: 'x'.repeat(MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS) }))
    const astral = `${'x'.repeat(MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS - 1)}\u{1F600}`
    expect(bindMcpPromptArguments([required('a')], astral)).toEqual(ok({ a: 'x'.repeat(MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS - 1) }))
    // Text after MCP_PROMPT_INPUT_MAX_CHARS is not read.
    const input = `a ${' '.repeat(MCP_PROMPT_INPUT_MAX_CHARS)} b`
    expect(bindMcpPromptArguments([required('first'), optional('second')], input)).toEqual(ok({ first: 'a' }))
  })

  it('never throws on malformed input', () => {
    expect(bindMcpPromptArguments(null as unknown as McpPromptArgument[], 'x')).toEqual(ok({}))
    expect(bindMcpPromptArguments([required('a')], null as unknown as string)).toEqual(missing('a'))
    expect(bindMcpPromptArguments([null, 1, { name: 2 }, { name: '' }, optional('a')] as unknown as McpPromptArgument[], 'v')).toEqual(ok({ a: 'v' }))
    const throwing = Object.defineProperty({}, 'name', {
      get: () => {
        throw new Error('no')
      },
    })
    expect(bindMcpPromptArguments([throwing as McpPromptArgument, required('a')], 'v')).toEqual(ok({ a: 'v' }))
    const hostile = new Proxy([], {
      get: () => {
        throw new Error('no')
      },
    })
    expect(bindMcpPromptArguments(hostile as unknown as McpPromptArgument[], 'v')).toEqual(ok({}))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Seeded fuzzing

// Seeded fuzz loops run several times slower on CI runners than locally: a generous timeout above the time budget.
describe('fuzzing', { timeout: 30_000 }, () => {
  const NAMES = ['a', 'b', 'pr', 'base', 'title', '__proto__', 'x y', '', 'a', 'body']
  const UNITS = [' ', ' ', '\t', '\n', '"', '"', '\'', '\\', '\\"', '=', 'a', 'b', 'pr', 'base=', 'pr=', 'x=', 'title=', 'v', 'w', 'é', '\u{1F600}', '""', '\u0000']

  function randomArgs(random: () => number): McpPromptArgument[] {
    return Array.from({ length: Math.floor(random() * 6) }, () => ({ name: NAMES[Math.floor(random() * NAMES.length)] as string, required: random() < 0.5 }))
  }

  it('never throws and keeps its invariants', () => {
    const random = prng(0xB1D)
    const started = Date.now()
    for (let iteration = 0; iteration < 4000; iteration++) {
      const args = randomArgs(random)
      const input = Array.from({ length: Math.floor(random() * 16) }, () => UNITS[Math.floor(random() * UNITS.length)]).join('')
      const context = `${JSON.stringify(args)} ${JSON.stringify(input)}`
      const declared = [...new Set(args.filter(arg => arg.name !== '').map(arg => arg.name))]
      const requiredNames = declared.filter(name => args.find(arg => arg.name === name)?.required === true)
      const result = bindMcpPromptArguments(args, input)
      expect(bindMcpPromptArguments(args, input), context).toEqual(result)
      if (result.ok) {
        for (const [name, value] of Object.entries(result.values)) {
          expect(declared, context).toContain(name)
          expect(typeof value, context).toBe('string')
          expect(value.length, context).toBeGreaterThan(0)
          expect(value.length, context).toBeLessThanOrEqual(MCP_PROMPT_ARGUMENT_VALUE_MAX_CHARS)
        }
        for (const name of requiredNames)
          expect(Object.hasOwn(result.values, name), context).toBe(true)
      }
      else {
        expect(result.missing.length, context).toBeGreaterThan(0)
        expect(result.missing, context).toEqual(requiredNames.filter(name => result.missing.includes(name)))
      }
      const hint = mcpPromptArgumentHint(args)
      if (declared.length === 0) {
        expect(hint, context).toBeNull()
      }
      else {
        expect(hint!.length, context).toBeLessThanOrEqual(MCP_PROMPT_ARGUMENT_HINT_MAX_CHARS)
        expect(/[\p{Cc}\p{Cf}]/u.test(hint!), context).toBe(false)
      }
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('binds single-quoted values positionally in declared order', () => {
    const random = prng(0x5EED49)
    const valueUnits = ['a', 'b', ' ', '"', '=', 'pr=', '\\', 'é', '\t', 'x y']
    for (let iteration = 0; iteration < 1000; iteration++) {
      const count = 1 + Math.floor(random() * 5)
      const args = Array.from({ length: count }, (_, index) => ({ name: index === 0 ? 'pr' : `arg${index}`, required: random() < 0.5 }))
      const values = args.map(() => Array.from({ length: Math.floor(random() * 6) }, () => valueUnits[Math.floor(random() * valueUnits.length)]).join(''))
      const input = values.map(value => `'${value}'`).join(' ')
      const expected = Object.fromEntries(args.flatMap((arg, index) => values[index] === '' ? [] : [[arg.name, values[index] as string]]))
      const result = bindMcpPromptArguments(args, input)
      const missingNames = args.filter((arg, index) => arg.required && values[index] === '').map(arg => arg.name)
      expect(result, input).toEqual(missingNames.length > 0 ? { ok: false, missing: missingNames } : { ok: true, values: expected })
    }
  })
})
