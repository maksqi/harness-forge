// The JSON files of the project definition editor (Phase 12, W12.4-T3; open point 11): the `hooks` / `mcpServers` splice
// keeps every other key and the key order, a missing file starts from `{}`, a file that is not a JSON object is refused,
// and the diagnostics are the project config reader's.
import type { HarnessError } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { jsonFileDiagnostics, readJsonObject, spliceJsonKey } from './settings-file.ts'

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function refusal(fn: () => unknown): HarnessError {
  try {
    fn()
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a refusal')
}

const HOOKS = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh .claude/hooks/check.sh' }] }] }

describe('spliceJsonKey', () => {
  it('replaces hooks in place and keeps every other key, value and the key order', () => {
    const before = '{"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[]},"env":{"A":"1"},"model":"sonnet"}'
    const text = spliceJsonKey('settings', bytes(before), HOOKS)
    expect(text.endsWith('}\n')).toBe(true)
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['permissions', 'hooks', 'env', 'model'])
    expect(parsed).toEqual({ permissions: { allow: ['Bash(ls)'] }, hooks: HOOKS, env: { A: '1' }, model: 'sonnet' })
    expect(text).toBe(`${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: HOOKS, env: { A: '1' }, model: 'sonnet' }, null, 2)}\n`)
  })

  it('adds a missing key last, removes it with null, and starts a missing file from {}', () => {
    expect(Object.keys(JSON.parse(spliceJsonKey('settings', bytes('{"b":1,"a":2}'), HOOKS)) as object)).toEqual(['b', 'a', 'hooks'])
    expect(spliceJsonKey('settings', bytes('{"b":1,"hooks":{},"a":2}'), null)).toBe('{\n  "b": 1,\n  "a": 2\n}\n')
    expect(spliceJsonKey('settings', null, HOOKS)).toBe(`${JSON.stringify({ hooks: HOOKS }, null, 2)}\n`)
    expect(spliceJsonKey('settings', null, null)).toBe('{}\n')
    expect(spliceJsonKey('mcp', bytes('{"mcpServers":{"a":{"command":"node"}},"x":true}'), { b: { url: 'https://example.invalid/mcp' } }))
      .toBe(`${JSON.stringify({ mcpServers: { b: { url: 'https://example.invalid/mcp' } }, x: true }, null, 2)}\n`)
  })

  it('drops a byte order mark and keeps a "__proto__" key as data', () => {
    const text = spliceJsonKey('settings', bytes('\uFEFF{"__proto__":{"x":1},"hooks":null}'), HOOKS)
    expect(text.startsWith('{')).toBe(true)
    expect(text).toContain('"__proto__"')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('refuses a file on disk that is not JSON, not an object or over 256 KiB (400 on the edited key)', () => {
    expect(refusal(() => spliceJsonKey('settings', bytes('{"hooks": '), HOOKS))).toMatchObject({
      code: 'validation_error',
      details: { diagnostics: [{ level: 'error', code: 'invalid-json' }], issues: [{ path: ['hooks'] }] },
    })
    expect(refusal(() => spliceJsonKey('mcp', bytes('[1,2]'), {}))).toMatchObject({
      details: { diagnostics: [{ code: 'not-an-object' }], issues: [{ path: ['mcpServers'] }] },
    })
    expect(refusal(() => readJsonObject('settings', bytes(`{"a":"${'x'.repeat(LIMITS.projectSettingsFileBytes)}"}`)))).toMatchObject({
      details: { diagnostics: [{ code: 'too-large' }] },
    })
  })
})

describe('jsonFileDiagnostics', () => {
  it('settings: the hook reader with prompt hooks, prefixed with event and position', () => {
    const text = JSON.stringify({ hooks: { Nope: [], Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the work done? $ARGUMENTS' }, { type: 'agent' }] }] } })
    const diagnostics = jsonFileDiagnostics('settings', text, '.claude/settings.json')
    expect(diagnostics.map(item => [item.level, item.code])).toEqual([['info', 'unknown-event'], ['warning', 'unsupported-type']])
    expect(diagnostics[1]!.message).toMatch(/^Stop \(group 1, hook 2\): /)
  })

  it('.mcp.json: the server reader; a removed mcpServers key is no error', () => {
    expect(jsonFileDiagnostics('mcp', '{}\n', '.mcp.json').map(item => item.code)).toEqual(['missing-servers'])
    expect(jsonFileDiagnostics('mcp', '{}\n', '.mcp.json', true)).toEqual([])
    const diagnostics = jsonFileDiagnostics('mcp', JSON.stringify({ mcpServers: { broken: { type: 'ftp', url: 'ftp://example.invalid' } } }), '.mcp.json')
    expect(diagnostics).toEqual([{ level: 'error', code: 'unsupported-type', message: 'Server "broken": The server type is not supported; use "stdio", "http" or "sse".' }])
  })
})
