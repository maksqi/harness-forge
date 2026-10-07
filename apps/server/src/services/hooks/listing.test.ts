// `GET /hooks` in Phase 12 (W12.5-T5 / -T7, open point 14, ADR-057): the hooks of an untrusted harness plugin listed
// `pending` from its manifest (the `hook-pack` example) and `active` once trusted; prompt handlers and the handler fields
// of plugin and project hooks; the kill-switch states of prompt hooks.
import type { PromptHookSpec } from '@harness-forge/shared'
import type { PluginTestApp } from '../../plugins/__fixtures__/harness.ts'
import type { RegisteredHookCommands } from '../../registry/types.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hookListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginTestApp, removeTempDirs } from '../../plugins/__fixtures__/harness.ts'
import { listHooks, pluginCommandEntries, untrustedPluginEntries } from './listing.ts'

const HOOK_PACK = fileURLToPath(new URL('../../../../../examples/plugins/hook-pack/', import.meta.url))

const apps: PluginTestApp[] = []

afterEach(async () => {
  for (const created of apps.splice(0))
    await created.close()
  removeTempDirs()
})

function hookPackFiles(): Record<string, string> {
  return {
    'plugin.json': readFileSync(`${HOOK_PACK}plugin.json`, 'utf8'),
    'scripts/remind-tests.sh': readFileSync(`${HOOK_PACK}scripts/remind-tests.sh`, 'utf8'),
  }
}

const PROMPT: PromptHookSpec = { event: 'Stop', matcher: null, prompt: 'Is the work done?', model: 'haiku', timeoutSec: 20, continueOnBlock: false, position: [1, 0], statusMessage: 'Asking…' }

describe('untrusted plugin rows (open point 14)', () => {
  it('an untrusted hook-pack lists its PostToolUse hook as pending; trusting it makes the row active', async () => {
    const h = await createPluginTestApp({ plugins: [{ id: 'hook-pack', files: hookPackFiles() }] })
    apps.push(h)
    expect(h.t.deps.plugins.state('hook-pack')).toBe('untrusted')
    const pending = hookListSchema.parse(await h.t.deps.hooks.list({}))
    const command = 'sh "$HARNESS_PLUGIN_ROOT/scripts/remind-tests.sh"'
    expect(pending.items).toEqual([{ kind: 'command', key: 'plugin:hook-pack:0', source: 'plugin', state: 'pending', pluginId: 'hook-pack', event: 'PostToolUse', matcher: 'Write|Edit|MultiEdit', command, timeout: 10, diagnostics: [] }])

    await h.install({ id: 'hook-pack', trust: true })
    await h.t.deps.plugins.load('hook-pack')
    expect(h.t.deps.plugins.state('hook-pack')).toBe('active')
    const active = await h.t.deps.hooks.list({})
    expect(active.items).toEqual([expect.objectContaining({ key: 'plugin:hook-pack:0', state: 'active', pluginId: 'hook-pack', command })])
  })

  it('the rows of a manifest: valid handlers pending (prompt handlers too), an invalid matcher listed invalid', () => {
    const { entries, rest } = untrustedPluginEntries({
      pluginId: 'demo',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh', if: 'Bash(git:*)', statusMessage: 'Guarding…' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?', continueOnBlock: true }] }],
        Nope: [],
      },
    })
    expect(entries).toEqual([
      expect.objectContaining({ key: 'plugin:demo:0', state: 'pending', event: 'PreToolUse', command: 'sh guard.sh', if: 'Bash(git:*)', statusMessage: 'Guarding…' }),
      expect.objectContaining({ key: 'plugin:demo:prompt:0', state: 'pending', event: 'Stop', type: 'prompt', command: '', prompt: 'Done?', continueOnBlock: true }),
    ])
    expect(rest.map(diagnostic => diagnostic.code)).toEqual(['unknown-event'])
  })
})

describe('the listing of prompt hooks and handler fields', () => {
  const registration: RegisteredHookCommands = {
    pluginId: 'kit',
    root: '/opt/kit',
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'sh', args: ['scripts/check.sh', '--strict'], timeoutSec: null, position: [0, 0], async: true }],
    diagnostics: [],
    env: {},
    prompts: [PROMPT],
  }

  it('plugin entries: the exec form and async; prompt entries with their model; prompt hooks are blocked only by the setting and safe mode', () => {
    const { entries } = pluginCommandEntries(registration, true, false, true)
    expect(entries).toEqual([
      { kind: 'command', key: 'plugin:kit:0', source: 'plugin', state: 'blocked', pluginId: 'kit', event: 'PreToolUse', matcher: 'Bash', command: 'sh', args: ['scripts/check.sh', '--strict'], async: true, timeout: null, diagnostics: [] },
      { kind: 'command', key: 'plugin:kit:prompt:0', source: 'plugin', state: 'active', pluginId: 'kit', event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Is the work done?', model: 'haiku', statusMessage: 'Asking…', timeout: 20, diagnostics: [] },
    ])
    const shellOff = listHooks({ query: {}, switches: { setting: true, shell: false, safeMode: false }, personal: [], plugins: [registration], isActive: () => true, code: [] })
    expect(shellOff.items.map(item => item.state)).toEqual(['blocked', 'active'])
    const safe = listHooks({ query: {}, switches: { setting: true, shell: true, safeMode: true }, personal: [], plugins: [registration], isActive: () => true, code: [] })
    expect(safe.items.map(item => item.state)).toEqual(['blocked', 'blocked'])
    expect(hookListSchema.safeParse(safe).success).toBe(true)
  })
})
