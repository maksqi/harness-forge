import type { ClaudePermissionRule, ShellRuleFromPermission } from './claude-permissions.ts'
import { describe, expect, it } from 'vitest'
import {
  parseClaudePermissionRule,
  PERMISSION_RULE_MAX_CHARS,
  SHELL_RULE_FROM_PERMISSION_MESSAGES,
  SHELL_RULE_FROM_PERMISSION_REASONS,
  shellRuleFromPermission,
  toolNamesFromPermission,
} from './claude-permissions.ts'

function rule(raw: string): ClaudePermissionRule {
  const parsed = parseClaudePermissionRule(raw)
  if (parsed === null)
    throw new Error(`not a rule: ${raw}`)
  return parsed
}

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('parseClaudePermissionRule', () => {
  it.each([
    ['Bash', { tool: 'Bash', specifier: null, raw: 'Bash' }],
    ['  Bash(npm run test:*)  ', { tool: 'Bash', specifier: 'npm run test:*', raw: 'Bash(npm run test:*)' }],
    ['Read(./.env)', { tool: 'Read', specifier: './.env', raw: 'Read(./.env)' }],
    ['WebFetch(domain:example.com)', { tool: 'WebFetch', specifier: 'domain:example.com', raw: 'WebFetch(domain:example.com)' }],
    ['Edit(src/**)', { tool: 'Edit', specifier: 'src/**', raw: 'Edit(src/**)' }],
    ['mcp__github__create_issue', { tool: 'mcp__github__create_issue', specifier: null, raw: 'mcp__github__create_issue' }],
    ['mcp__github__*', { tool: 'mcp__github__*', specifier: null, raw: 'mcp__github__*' }],
    ['mcp__github', { tool: 'mcp__github', specifier: null, raw: 'mcp__github' }],
    ['Bash(echo (nested))', { tool: 'Bash', specifier: 'echo (nested)', raw: 'Bash(echo (nested))' }],
    ['Bash( git status )', { tool: 'Bash', specifier: 'git status', raw: 'Bash( git status )' }],
    ['Bash()', { tool: 'Bash', specifier: '', raw: 'Bash()' }],
  ])('parses %j', (raw, expected) => {
    expect(parseClaudePermissionRule(raw)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    'Bash (git status)',
    'Bash(git status',
    'Bash(git status) extra',
    '(git status)',
    'Bash*',
    'Read*(x)',
    '9Bash',
    'Bash(a\u0000b)',
    'Bash(a\nb)',
    'Bash(a\tb)',
    'Bash.Tool',
  ])('refuses %j', (raw) => {
    expect(parseClaudePermissionRule(raw)).toBeNull()
  })

  it('refuses rules over the length cap and non-strings', () => {
    expect(parseClaudePermissionRule(`Bash(${'a'.repeat(PERMISSION_RULE_MAX_CHARS)})`)).toBeNull()
    expect(parseClaudePermissionRule(`B${'a'.repeat(200)}`)).toBeNull()
    expect(parseClaudePermissionRule(42 as unknown as string)).toBeNull()
    expect(parseClaudePermissionRule(null as unknown as string)).toBeNull()
  })
})

describe('shellRuleFromPermission', () => {
  const cases: Array<[string, ShellRuleFromPermission]> = [
    ['Bash(npm run test:*)', { ok: true, prefix: 'npm run test' }],
    ['Bash(npm run *)', { ok: true, prefix: 'npm run' }],
    ['Bash(git log  :*)', { ok: true, prefix: 'git log' }],
    ['Bash(git   diff   *)', { ok: true, prefix: 'git diff' }],
    ['Bash(pnpm test)', { ok: true, prefix: 'pnpm test', warning: 'prefix-broader' }],
    ['Bash(git status)', { ok: true, prefix: 'git status', warning: 'prefix-broader' }],
    ['Bash(ls)', { ok: true, prefix: 'ls', warning: 'prefix-broader' }],
    ['Bash(node scripts/build.mjs:*)', { ok: true, prefix: 'node scripts/build.mjs' }],
    ['Bash', { ok: false, reason: 'whole-tool' }],
    ['Bash(*)', { ok: false, reason: 'wildcard-only' }],
    ['Bash(:*)', { ok: false, reason: 'wildcard-only' }],
    ['Bash(* *)', { ok: false, reason: 'wildcard-only' }],
    ['Bash()', { ok: false, reason: 'invalid' }],
    ['Bash(git * --force)', { ok: false, reason: 'inner-wildcard' }],
    ['Bash(npm*)', { ok: false, reason: 'inner-wildcard' }],
    ['Bash(rm -rf *.log)', { ok: false, reason: 'inner-wildcard' }],
    ['Bash(sudo:*)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(bash:*)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(env:*)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(python3:*)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(npx *)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(eval:*)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(cd:*)', { ok: false, reason: 'refused-prefix' }],
    ['Bash(ls && rm -rf /)', { ok: false, reason: 'invalid' }],
    ['Bash(echo $HOME)', { ok: false, reason: 'invalid' }],
    ['Bash(cat foo > bar)', { ok: false, reason: 'invalid' }],
    ['Read(./src/**)', { ok: false, reason: 'not-bash' }],
    ['WebFetch', { ok: false, reason: 'not-bash' }],
    ['mcp__github__*', { ok: false, reason: 'not-bash' }],
  ]
  it.each(cases)('maps %j', (raw, expected) => {
    expect(shellRuleFromPermission(rule(raw))).toEqual(expected)
  })

  it('has one message per reason and never throws on malformed input', () => {
    for (const reason of SHELL_RULE_FROM_PERMISSION_REASONS)
      expect(SHELL_RULE_FROM_PERMISSION_MESSAGES[reason]).toMatch(/\.$/)
    expect(shellRuleFromPermission(null as unknown as ClaudePermissionRule)).toEqual({ ok: false, reason: 'not-bash' })
    expect(shellRuleFromPermission({ tool: 'Bash', specifier: 7, raw: 'x' } as unknown as ClaudePermissionRule)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('toolNamesFromPermission', () => {
  it.each([
    ['WebFetch', ['web_fetch']],
    ['Write', ['write_file']],
    ['Edit', ['edit_file']],
    ['MultiEdit', ['edit_file']],
    ['Read', ['read_file']],
    ['Grep', ['search_files']],
    ['Glob', ['find_files']],
    ['LS', ['list_directory']],
    ['Bash', ['shell']],
    ['mcp__github__*', ['mcp__github__*']],
    ['mcp__github__create_issue', ['mcp__github__create_issue']],
    ['mcp__github', ['mcp__github']],
    ['mcp__', []],
    ['WebFetch(domain:example.com)', []],
    ['Bash(rm:*)', []],
    ['NotAClaudeTool', []],
    ['toString', []],
    ['constructor', []],
  ])('maps %j', (raw, expected) => {
    expect(toolNamesFromPermission(rule(raw))).toEqual(expected)
  })

  it('returns nothing for malformed input', () => {
    expect(toolNamesFromPermission(null as unknown as ClaudePermissionRule)).toEqual([])
    expect(toolNamesFromPermission({ tool: 3, specifier: null, raw: '' } as unknown as ClaudePermissionRule)).toEqual([])
  })
})

describe('fuzzing', () => {
  it('never throws on random rules and keeps its invariants', () => {
    const random = prng(0xC41)
    const alphabet = ['Bash', 'Read', 'mcp__x__', '(', ')', '*', ':', ' ', 'a', 'npm', '-', '&&', '$', '"', '\'', '\\', '\n', '\u0000', 'é', '/', '.']
    const started = Date.now()
    for (let round = 0; round < 3000; round++) {
      let text = ''
      const length = Math.floor(random() * 12)
      for (let index = 0; index < length; index++)
        text += alphabet[Math.floor(random() * alphabet.length)]
      const parsed = parseClaudePermissionRule(text)
      if (parsed === null)
        continue
      expect(parsed.raw).toBe(text.trim())
      const mapped = shellRuleFromPermission(parsed)
      if (mapped.ok) {
        expect(parsed.tool).toBe('Bash')
        expect(mapped.prefix).not.toContain('*')
        expect(mapped.prefix.trim()).toBe(mapped.prefix)
      }
      for (const tool of toolNamesFromPermission(parsed))
        expect(tool).toMatch(/^[\w*-]+$/)
    }
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
