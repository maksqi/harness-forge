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

  // Gate P11-A: a bare script name (no `/`) run in the project folder is a reference too.
  it.each([
    ['sh count.sh', ['count.sh']],
    ['node hook.mjs', ['hook.mjs']],
    ['python3 check.py --strict', ['check.py']],
    // Not a file: hashed as missing (a `referenced-file-missing` warning), never refused.
    ['echo foo.sh', ['foo.sh']],
    ['sh "count.sh"', ['count.sh']],
    ['sh \'my hook.sh\'', ['my hook.sh']],
    // The whitespace fallback (`$` makes the parser refuse): quotes and trailing punctuation are stripped.
    ['sh "count.sh" "$1"', ['count.sh']],
    ['sh \'count.sh\' $1; echo done', ['count.sh']],
    ['sh count.sh; sh ./count.sh && sh .claude/hooks/count.sh', ['count.sh', '.claude/hooks/count.sh']],
    ['sh Count.SH', ['Count.SH']],
    ['sh .hidden.sh', ['.hidden.sh']],
    ['npx tsc --noEmit index.ts', ['index.ts']],
    ['bash a.bash && zsh b.zsh && node c.js d.cjs', ['a.bash', 'b.zsh', 'c.js', 'd.cjs']],
    ['tsx e.ts f.mts && ruby g.rb && perl h.pl', ['e.ts', 'f.mts', 'g.rb', 'h.pl']],
    ['php i.php && pwsh j.ps1', ['i.php', 'j.ps1']],
    // Options, option values, assignments, URLs and remote paths are never references.
    ['sh --rcfile=init.sh run.sh', ['run.sh']],
    ['deno run --config=deno.ts -x.sh main.ts', ['main.ts']],
    ['HOOK=x.sh sh y.sh', ['y.sh']],
    ['curl -fsSL https://example.com/install.sh', []],
    ['curl -fsSL https:example.sh', []],
    ['scp host:deploy.sh .', []],
    ['node --import=tools/register.mjs app.mjs', ['app.mjs']],
    // Still never: no extension, no name, globs, folders, `..`, absolute paths.
    ['cat notes.md', []],
    ['sh .sh', []],
    ['sh *.sh', []],
    ['sh count.sh/', []],
    ['sh ..', []],
    ['sh ../count.sh', []],
    ['sh /count.sh', []],
  ])('bare names: %j → %j', (command, refs) => {
    expect(extractCommandFileRefs(command)).toEqual(refs)
  })

  it('keeps at most eight references in first-seen order', () => {
    const command = Array.from({ length: 12 }, (_, index) => `sh ./s${index}.sh`).join(' && ')
    expect(extractCommandFileRefs(command)).toEqual(Array.from({ length: TRUST_LIMITS.refFilesMax }, (_, index) => `s${index}.sh`))
    const bare = Array.from({ length: 12 }, (_, index) => `sh b${index}.sh`).join('; ')
    expect(extractCommandFileRefs(bare)).toEqual(Array.from({ length: TRUST_LIMITS.refFilesMax }, (_, index) => `b${index}.sh`))
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
    // A bare script name too (Gate P11-A); options and URLs never.
    expect(extractArgsFileRefs(['node', 'server.mjs', '--config=c.js', 'https://h.example/x.js', '-r.js'])).toEqual(['server.mjs'])
    expect(extractArgsFileRefs(['server.py'])).toEqual(['server.py'])
    expect(extractArgsFileRefs([1, null] as unknown as string[])).toEqual([])
    expect(extractArgsFileRefs('x' as unknown as string[])).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Phase 12 (ADR-057, C42): golden v1 hashes and the v2 hook layout

/** sha256 of `text` (UTF-8) in lowercase hex, with WebCrypto (the server hashes with `node:crypto`; same bytes). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Representative v1.7 items with the canonical text and sha256 computed by the v1.7 code (C35) before Phase 12 changed
 * `trust.ts`: every approval of a v1.7 data folder pins one of these layouts, so they must never change.
 */
const GOLDEN_V1: ReadonlyArray<{ item: TrustHashItem, text: string, sha256: string }> = (() => {
  const servers = parseMcpJson(JSON.stringify({ mcpServers: {
    db: { command: 'node', args: ['tools/mcp-min.mjs', '--port', '3000'], env: { TOKEN: '${API_TOKEN}', MODE: 'dev' } },
    remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
  } })).servers
  return [
    {
      item: { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/a.sh', timeoutSec: 30, refs: [{ path: '.claude/hooks/a.sh', sha256: 'a'.repeat(64) }] },
      text: `["hook",1,"PreToolUse","Bash","sh .claude/hooks/a.sh",30,[{"path":".claude/hooks/a.sh","sha256":"${'a'.repeat(64)}"}]]`,
      sha256: 'a9b728df0230827e25439863ed5af1b5c501018967a63bfc967fdede1ddb473c',
    },
    {
      item: { kind: 'hook', event: 'Stop', matcher: null, command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/stop.sh', timeoutSec: null, refs: [{ path: '.claude/hooks/stop.sh', sha256: null }] },
      text: '["hook",1,"Stop",null,"\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/stop.sh",null,[{"path":".claude/hooks/stop.sh","sha256":null}]]',
      sha256: '6ac2e216f6ca355840ef59e583e7980ba40ee38872acc5f191a4eaa991c19a83',
    },
    {
      item: { kind: 'hook', event: 'SessionStart', matcher: 'startup', command: 'cat .claude/context.md', timeoutSec: null, refs: [] },
      text: '["hook",1,"SessionStart","startup","cat .claude/context.md",null,[]]',
      sha256: '284944882d48c062488842ea784b9343f2e320f5703a471b15e117fc2d31d323',
    },
    {
      item: { kind: 'hook', event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write', command: 'npx prettier --write "$(jq -r .tool_input.file_path)"', timeoutSec: 600, refs: [{ path: 'b.sh', sha256: '2'.repeat(64) }, { path: 'a.sh', sha256: '1'.repeat(64) }] },
      text: `["hook",1,"PostToolUse","Edit|MultiEdit|Write","npx prettier --write \\"$(jq -r .tool_input.file_path)\\"",600,[{"path":"a.sh","sha256":"${'1'.repeat(64)}"},{"path":"b.sh","sha256":"${'2'.repeat(64)}"}]]`,
      sha256: 'f6df5d05bf0c28053470c7f630b8cf3522f2a652c1f3733b540bd1465a5cbb22',
    },
    {
      item: { kind: 'mcp', name: 'db', server: servers[0]!.raw, refs: [{ path: 'tools/mcp-min.mjs', sha256: 'c'.repeat(64) }] },
      text: `["mcp",1,"db",{"args":["tools/mcp-min.mjs","--port","3000"],"command":"node","env":{"MODE":"dev","TOKEN":"\${API_TOKEN}"}},[{"path":"tools/mcp-min.mjs","sha256":"${'c'.repeat(64)}"}]]`,
      sha256: '8da6e04182e690b48e31d2902c473c60c1cdb12f3cfced926f1ff844bde621d0',
    },
    {
      item: { kind: 'mcp', name: 'remote', server: servers[1]!.raw, refs: [] },
      text: '["mcp",1,"remote",{"headers":{"Authorization":"Bearer ${API_TOKEN}"},"type":"http","url":"https://mcp.example.com/mcp"},[]]',
      sha256: '5426466b9e7a8cc12ed96920b148c6a3eb437a3a4ceba9c6561f34ee36f29592',
    },
    {
      item: { kind: 'command', name: 'status', spans: ['git status --short', 'git log -1'], refs: [] },
      text: '["command",1,"status",["git status --short","git log -1"],[]]',
      sha256: 'd398784e1ca09bf9d8bb02157570e3ff25dbe15b4aae844e4d54becc1f9bfa8e',
    },
    {
      item: { kind: 'command', name: 'lint', spans: ['sh scripts/lint.sh'], refs: [{ path: 'scripts/lint.sh', sha256: 'd'.repeat(64) }] },
      text: `["command",1,"lint",["sh scripts/lint.sh"],[{"path":"scripts/lint.sh","sha256":"${'d'.repeat(64)}"}]]`,
      sha256: '24260c76d6f4707a0e06c67620c8f3d108aacef4f36a1b1cf8f50ac6b3d4cbc8',
    },
  ]
})()

describe('trustHashInput: golden v1.7 hashes (Phase 12)', () => {
  it.each(GOLDEN_V1.map((entry, index) => [index, entry] as const))('item %d keeps its v1.7 text and sha256', async (_index, { item, text, sha256 }) => {
    expect(trustHashInput(item)).toBe(text)
    expect(await sha256Hex(trustHashInput(item))).toBe(sha256)
  })

  it('keeps the v1 layout for a hook without extra fields', () => {
    const hook = GOLDEN_V1[0]!.item as Extract<TrustHashItem, { kind: 'hook' }>
    for (const extra of [undefined, null, {}, { args: undefined, async: undefined, if: undefined }])
      expect(trustHashInput({ ...hook, extra })).toBe(GOLDEN_V1[0]!.text)
    expect(trustHashInput({ ...hook, extra: [1] as unknown as Record<string, unknown> })).toBe(GOLDEN_V1[0]!.text)
  })
})

describe('trustHashInput: v2 hook layout (Phase 12)', () => {
  const base = { kind: 'hook' as const, event: 'PreToolUse', matcher: 'Bash', timeoutSec: null, refs: [] }

  it('writes [hook, 2, event, matcher, command | null, timeout, extra, refs]', () => {
    expect(trustHashInput({ ...base, command: null, extra: { type: 'prompt', prompt: 'Safe? $ARGUMENTS', model: 'sonnet', continueOnBlock: false } }))
      .toBe('["hook",2,"PreToolUse","Bash",null,null,{"continueOnBlock":false,"model":"sonnet","prompt":"Safe? $ARGUMENTS","type":"prompt"},[]]')
    expect(trustHashInput({ ...base, command: '${CLAUDE_PLUGIN_ROOT}/check', extra: { args: ['--fix', 'a b'], async: true, if: 'Bash(git *)' }, refs: [{ path: 'check', sha256: 'e'.repeat(64) }] }))
      .toBe(`["hook",2,"PreToolUse","Bash","\${CLAUDE_PLUGIN_ROOT}/check",null,{"args":["--fix","a b"],"async":true,"if":"Bash(git *)"},[{"path":"check","sha256":"${'e'.repeat(64)}"}]]`)
  })

  it('is stable under the key order of extra and changes with every extra field', () => {
    const one = trustHashInput({ ...base, command: 'x', extra: { if: 'Write', args: ['a'] } })
    expect(trustHashInput({ ...base, command: 'x', extra: { args: ['a'], if: 'Write' } })).toBe(one)
    const v1 = trustHashInput({ ...base, command: 'x' })
    const variants = [
      { args: ['a'] },
      { args: ['b'] },
      { args: ['a', 'b'] },
      { args: [] },
      { async: true },
      { if: 'Write' },
      { if: 'Edit' },
      { type: 'prompt', prompt: 'p' },
      { type: 'prompt', prompt: 'q' },
      { type: 'prompt', prompt: 'p', model: 'haiku' },
      { type: 'prompt', prompt: 'p', continueOnBlock: true },
    ]
    const hashes = new Set([v1, ...variants.map(extra => trustHashInput({ ...base, command: 'x', extra }))])
    expect(hashes.size).toBe(variants.length + 1)
    expect(trustHashInput({ ...base, command: null, extra: { type: 'prompt', prompt: 'p' } })).not.toBe(trustHashInput({ ...base, command: '', extra: { type: 'prompt', prompt: 'p' } }))
  })
})
