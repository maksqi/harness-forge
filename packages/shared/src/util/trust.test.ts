/* eslint-disable no-template-curly-in-string -- literal shell variables (`${CLAUDE_PROJECT_DIR}`) are test data */
import type { TrustHashItem } from './trust.ts'
import { describe, expect, it } from 'vitest'
import { parseMcpJson } from './mcp-config.ts'
import { canonicalJson, extractArgsFileRefs, extractCommandFileRefs, TRUST_ITEM_KINDS, TRUST_LIMITS, trustHashInput } from './trust.ts'

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('canonicalJson', () => {
  it('sorts keys recursively and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
    expect(canonicalJson(JSON.parse('{ "type" : "stdio",\n  "command": "node",\n\t"args": ["a b"] }'))).toBe(canonicalJson({ args: ['a b'], command: 'node', type: 'stdio' }))
    expect(canonicalJson('é"\\\n')).toBe(JSON.stringify('é"\\\n'))
    expect(canonicalJson([1, 'two', true, null])).toBe('[1,"two",true,null]')
  })

  it('follows JSON semantics for unusual values', () => {
    expect(canonicalJson({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 })).toBe('{"d":1}')
    expect(canonicalJson([undefined, () => 1, Number.NaN, Infinity, -0])).toBe('[null,null,null,null,0]')
    expect(canonicalJson(12n)).toBe('"12"')
    expect(canonicalJson(undefined)).toBe('null')
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(canonicalJson(cyclic)).toBe('{"a":1,"self":null}')
    const shared = { x: 1 }
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]')
    const throwing = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get: () => {
        throw new Error('no')
      },
    })
    expect(canonicalJson(throwing)).toBe('null')
    expect(canonicalJson(JSON.parse('{"__proto__":{"a":1}}'))).toBe('{"__proto__":{"a":1}}')
  })

  it('handles deep nesting without recursion', () => {
    const depth = 50_000
    const text = `${'['.repeat(depth)}${']'.repeat(depth)}`
    expect(canonicalJson(JSON.parse(text))).toBe(text)
  })
})

describe('trustHashInput', () => {
  const hook: TrustHashItem = { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/a.sh', timeoutSec: 30, refs: [{ path: '.claude/hooks/a.sh', sha256: 'aa' }] }

  it('writes [kind, 1, fields, refs]', () => {
    expect(TRUST_ITEM_KINDS).toEqual(['hook', 'mcp', 'command'])
    expect(trustHashInput(hook)).toBe('["hook",1,"PreToolUse","Bash","sh .claude/hooks/a.sh",30,[{"path":".claude/hooks/a.sh","sha256":"aa"}]]')
    expect(trustHashInput({ kind: 'command', name: 'status', spans: ['git status --short', 'git log -1'], refs: [] })).toBe('["command",1,"status",["git status --short","git log -1"],[]]')
    expect(trustHashInput({ kind: 'mcp', name: 'db', server: { command: 'node', args: ['s.mjs'] }, refs: [{ path: 's.mjs', sha256: null }] }))
      .toBe('["mcp",1,"db",{"args":["s.mjs"],"command":"node"},[{"path":"s.mjs","sha256":null}]]')
  })

  it('is stable under key order, whitespace and ref order', () => {
    const one = parseMcpJson('{"mcpServers":{"db":{"command":"node","args":["s.mjs"],"env":{"A":"1","B":"${TOKEN}"}}}}').servers[0]!
    const two = parseMcpJson('{\n  "mcpServers": {\n    "db": {\n      "env": { "B": "${TOKEN}", "A": "1" },\n      "args": [ "s.mjs" ],\n      "command": "node"\n    }\n  }\n}\n').servers[0]!
    const refsA = [{ path: 'b.sh', sha256: '2' }, { path: 'a.sh', sha256: '1' }]
    const refsB = [{ path: 'a.sh', sha256: '1' }, { path: 'b.sh', sha256: '2' }, { path: 'a.sh', sha256: '1' }]
    expect(trustHashInput({ kind: 'mcp', name: 'db', server: one.raw, refs: refsA })).toBe(trustHashInput({ kind: 'mcp', name: 'db', server: two.raw, refs: refsB }))
  })

  it('changes with every field and every referenced file', () => {
    const base = trustHashInput(hook)
    const variants: TrustHashItem[] = [
      { ...hook, event: 'PostToolUse' },
      { ...hook, matcher: null },
      { ...hook, matcher: 'Bash|Write' },
      { ...hook, command: 'sh .claude/hooks/b.sh' },
      { ...hook, timeoutSec: null },
      { ...hook, refs: [] },
      { ...hook, refs: [{ path: '.claude/hooks/a.sh', sha256: 'ab' }] },
      { ...hook, refs: [{ path: '.claude/hooks/a.sh', sha256: null }] },
      { kind: 'command', name: 'PreToolUse', spans: [], refs: hook.refs },
    ]
    const hashes = new Set([base, ...variants.map(trustHashInput)])
    expect(hashes.size).toBe(variants.length + 1)
    expect(trustHashInput({ kind: 'command', name: 'a', spans: ['x', 'y'], refs: [] })).not.toBe(trustHashInput({ kind: 'command', name: 'a', spans: ['y', 'x'], refs: [] }))
  })

  it('never throws on malformed items', () => {
    for (const item of [null, undefined, 1, {}, { kind: 'other' }, { kind: 'hook' }, { kind: 'command', spans: 'x', refs: 'y' }, { kind: 'mcp', refs: [null, 1, { path: 2 }] }])
      expect(typeof trustHashInput(item as unknown as TrustHashItem)).toBe('string')
  })
})

describe('extractCommandFileRefs', () => {
  it.each([
    ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/check-style.sh', ['.claude/hooks/check-style.sh']],
    ['"$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh"', ['.claude/hooks/check.sh']],
    ['$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh --fix', ['.claude/hooks/check.sh']],
    ['bash ${CLAUDE_PROJECT_DIR}/scripts/lint', ['scripts/lint']],
    ['"${HARNESS_PROJECT_DIR}"/tools/x.py && echo ok', ['tools/x.py']],
    ['$HARNESS_PROJECT_DIR/./a//b.sh', ['a/b.sh']],
    ['sh .claude/hooks/guard.sh', ['.claude/hooks/guard.sh']],
    ['sh .harness/hooks/guard.sh; sh ./local.sh', ['.harness/hooks/guard.sh', 'local.sh']],
    ['python3 scripts/check.py --strict', ['scripts/check.py']],
    ['node tools/mcp-min.mjs', ['tools/mcp-min.mjs']],
    ['python3 \'scripts/my hook.py\'', ['scripts/my hook.py']],
    ['./run.sh && ./run.sh', ['run.sh']],
    ['npm test', []],
    ['npx prettier --write src/index.ts', ['src/index.ts']],
    ['cat README.md', []],
    ['sh ../outside.sh', []],
    ['sh ./a/../../b.sh', []],
    ['sh /usr/local/bin/x.sh', []],
    ['sh ~/x.sh', []],
    ['sh .claude/hooks/', []],
    ['sh .claude', []],
    ['echo $CLAUDE_PROJECT_DIRX/a.sh', []],
    ['sh "$OTHER_DIR"/a.sh', []],
    ['sh .claude/hooks/*.sh', []],
    ['sh \'$CLAUDE_PROJECT_DIR/a.sh\'', []],
    ['jq -r .tool_input.file_path | xargs ./fmt.sh 2>/dev/null', ['fmt.sh']],
    ['', []],
  ])('%j → %j', (command, refs) => {
    expect(extractCommandFileRefs(command)).toEqual(refs)
  })

  it('keeps at most eight references in first-seen order', () => {
    const command = Array.from({ length: 12 }, (_, index) => `sh ./s${index}.sh`).join(' && ')
    expect(extractCommandFileRefs(command)).toEqual(Array.from({ length: TRUST_LIMITS.refFilesMax }, (_, index) => `s${index}.sh`))
  })

  it('never throws and stays bounded on random input', () => {
    const random = prng(0x7257)
    const units = [' ', '"', '\'', '$', '$CLAUDE_PROJECT_DIR', '${HARNESS_PROJECT_DIR}', '/', './', '..', '.claude/', 'a', '.sh', '.py', ';', '&&', '|', '\\', '`', '(', '\n', '\0', 'é', '*']
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const command = Array.from({ length: Math.floor(random() * 30) }, () => units[Math.floor(random() * units.length)]).join('')
      const refs = extractCommandFileRefs(command)
      expect(refs.length).toBeLessThanOrEqual(TRUST_LIMITS.refFilesMax)
      for (const ref of refs) {
        expect(ref.startsWith('/')).toBe(false)
        expect(ref.split('/')).not.toContain('..')
        expect(ref.split('/')).not.toContain('.')
        expect(ref).not.toMatch(/[\0$"'`*\\]/)
      }
    }
    expect(extractCommandFileRefs(`sh ./a.sh ${'x '.repeat(200_000)}`)).toEqual(['a.sh'])
    expect(extractCommandFileRefs(`sh ./a.sh $${')'.repeat(65_000)}x ${'/'.repeat(60_000)}a.sh`)).toEqual(['a.sh'])
    expect(extractCommandFileRefs(null as unknown as string)).toEqual([])
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('extractArgsFileRefs', () => {
  it('reads each argument as one literal word', () => {
    expect(extractArgsFileRefs(['node', 'tools/mcp min.mjs', '--port', '3000'])).toEqual(['tools/mcp min.mjs'])
    expect(extractArgsFileRefs(['${CLAUDE_PROJECT_DIR}/server.js', './b.py', '"./c.sh"'])).toEqual(['server.js', 'b.py'])
    expect(extractArgsFileRefs(['../x.js', '/abs/y.js'])).toEqual([])
    expect(extractArgsFileRefs([1, null] as unknown as string[])).toEqual([])
    expect(extractArgsFileRefs('x' as unknown as string[])).toEqual([])
  })
})
