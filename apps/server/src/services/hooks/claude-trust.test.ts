/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` are literal plugin content */
// Claude Code plugin hooks and the trust pin (v1.8.1, ADR-053): the whole tree is hashed again right before every
// command hook spawn, so an edited file of a trusted plugin stops its next hook (a non-blocking `error` in the record and
// the run log, nothing spawned) and the plugin turns `untrusted` until it is trusted again; an unchanged tree spawns.
// `GET /hooks` lists the hooks of an untrusted Claude Code plugin as `pending` (as written: no option value), and as
// `active` once it is trusted. Real `sh` processes; every spawned pid is dead at the end.
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import type { HookHarness } from './testing.ts'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { hookListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudePluginFiles, UID_MARK_FILE, writeFileTree } from '../../testing/claude-fixtures.ts'
import { PLUGIN_CHANGED_ERROR } from './snapshot.ts'
import { createHookTestKit, hookScope, testSignal, waitFor } from './testing.ts'

const posix = process.platform !== 'win32'
const kit = createHookTestKit()
afterEach(kit.cleanup)

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Writes a Claude Code plugin into `<dataDir>/plugins/<id>`, records it (`format: 'claude'`, pinned when `trust`) and loads it. */
async function installClaude(h: HookHarness, id: string, files: FixtureTree, trust: boolean): Promise<string> {
  const dir = join(h.t.env.paths.plugins, id)
  await writeFileTree(dir, files)
  const inspection = await h.t.deps.plugins.inspectDirectory(dir, { format: 'claude' })
  await h.t.deps.plugins.saveRecord({ id, source: 'copy', format: 'claude', version: inspection.manifest.version, ...(trust ? { trustedHash: inspection.sha256 } : {}) })
  await h.t.deps.plugins.load(id)
  return dir
}

describe.skipIf(!posix)('the tree of a trusted Claude Code plugin is checked before every hook spawn', () => {
  it('unchanged: the hook spawns; edited: the next hook does not spawn, is recorded and the plugin turns untrusted', async () => {
    const h = await kit.open()
    const dir = await installClaude(h, 'uid-mark', claudePluginFiles('uid-mark'), true)
    const { plugins, registry } = h.t.deps
    expect(plugins.state('uid-mark')).toBe('active')
    const marker = join(h.root, UID_MARK_FILE)
    const snapshot = await h.hooks.snapshot(hookScope(h))

    const first = await snapshot.run('UserPromptSubmit', { prompt: 'hello' }, { signal: testSignal() })
    expect(first).toMatchObject({ ran: true, block: false, record: null })
    expect(h.spawned).toHaveLength(1)
    expect(await exists(marker)).toBe(true)
    await rm(marker)

    // An edit after the load (and after the snapshot): the registration still holds the reviewed handler.
    const script = join(dir, 'scripts/mark.sh')
    await writeFile(script, `${await readFile(script, 'utf8')}# edited after the trust\n`)
    const second = await snapshot.run('UserPromptSubmit', { prompt: 'again' }, { signal: testSignal() })
    expect(h.spawned).toHaveLength(1)
    expect(await exists(marker)).toBe(false)
    expect(second).toMatchObject({ ran: true, block: false, continue: true, decision: null })
    expect(second.record).toMatchObject({ event: 'UserPromptSubmit', outcome: 'error', hooks: [{ source: 'plugin', pluginId: 'uid-mark', exitCode: null, error: PLUGIN_CHANGED_ERROR }] })
    expect(h.hooks.runs(1)).toEqual([expect.objectContaining({ event: 'UserPromptSubmit', source: 'plugin', pluginId: 'uid-mark', outcome: 'error', error: PLUGIN_CHANGED_ERROR })])

    // The plugin is loaded again and waits for trust: nothing of it is registered, its hooks are listed pending.
    await waitFor(() => plugins.state('uid-mark') === 'untrusted')
    expect(registry.hookCommands.get('uid-mark')).toBeUndefined()
    expect((await h.hooks.snapshot(hookScope(h))).has('UserPromptSubmit')).toBe(false)
    const listed = hookListSchema.parse(await h.hooks.list({}))
    expect(listed.items).toContainEqual(expect.objectContaining({ key: 'plugin:uid-mark:0', source: 'plugin', state: 'pending', pluginId: 'uid-mark', event: 'UserPromptSubmit', command: '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh' }))
    expect(h.events.some(event => event.type === 'plugin.changed')).toBe(true)

    // Trusted again (the edited tree): the hook spawns once more.
    await plugins.trust('uid-mark', (await plugins.get('uid-mark')).trust.hash!)
    expect(plugins.state('uid-mark')).toBe('active')
    const third = await (await h.hooks.snapshot(hookScope(h))).run('UserPromptSubmit', { prompt: 'trusted again' }, { signal: testSignal() })
    expect(third.record).toBeNull()
    expect(h.spawned).toHaveLength(2)
    expect(await exists(marker)).toBe(true)
  })

  it('a new file in the tree stops an async hook too (the run log only)', async () => {
    const h = await kit.open()
    const files: FixtureTree = {
      ...claudePluginFiles('uid-mark'),
      'hooks/hooks.json': { content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh', async: true }] }] } }), mode: 0o644 },
    }
    const dir = await installClaude(h, 'uid-mark', files, true)
    const snapshot = await h.hooks.snapshot(hookScope(h))
    await writeFile(join(dir, 'notes.md'), 'added later\n')
    const result = await snapshot.run('Stop', { stopHookActive: false }, { signal: testSignal() })
    expect(result.record).toBeNull()
    await waitFor(() => h.hooks.runs(1).some(run => run.event === 'Stop' && run.error === PLUGIN_CHANGED_ERROR))
    expect(h.spawned).toHaveLength(0)
    await waitFor(() => h.t.deps.plugins.state('uid-mark') === 'untrusted')
  })
})

describe('the hooks of an untrusted Claude Code plugin in GET /hooks', () => {
  it('are listed pending as written (no option value), cached per trust hash, and active once trusted', async () => {
    const h = await kit.open()
    const files: FixtureTree = {
      ...claudePluginFiles('uid-mark'),
      '.claude-plugin/plugin.json': { content: JSON.stringify({ name: 'uid-mark', version: '1.0.0', userConfig: { API_TOKEN: { type: 'string', title: 'Token', sensitive: true } } }), mode: 0o644 },
      'hooks/hooks.json': {
        content: JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh' }] }],
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh', '--token=${user_config.API_TOKEN}'], timeout: 5 }] }],
            Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the work done?' }, { type: 'http', url: 'https://hooks.example.com/stop' }] }],
          },
        }),
        mode: 0o644,
      },
    }
    await installClaude(h, 'uid-mark', files, false)
    const { plugins } = h.t.deps
    expect(plugins.state('uid-mark')).toBe('untrusted')
    const secret = 'HF_CANARY-m1-untrusted-claude-hook'
    await plugins.updateSettings('uid-mark', { API_TOKEN: secret })
    expect(plugins.state('uid-mark')).toBe('untrusted')

    const record = vi.spyOn(plugins, 'record')
    const list = hookListSchema.parse(await h.hooks.list({}))
    const own = list.items.filter(item => item.source === 'plugin' && item.pluginId === 'uid-mark')
    expect(own).toEqual([
      expect.objectContaining({ key: 'plugin:uid-mark:0', state: 'pending', event: 'UserPromptSubmit', command: '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh' }),
      expect.objectContaining({ key: 'plugin:uid-mark:1', state: 'pending', event: 'PreToolUse', matcher: 'Bash', command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh', '--token=${user_config.API_TOKEN}'], timeout: 5 }),
      expect.objectContaining({ key: 'plugin:uid-mark:prompt:0', state: 'pending', event: 'Stop', type: 'prompt', prompt: 'Is the work done?' }),
    ])
    expect(JSON.stringify(list)).not.toContain(secret)
    expect(JSON.stringify(list.diagnostics)).toContain('unsupported-type')
    // The second listing is served from the cache (the host's trust hash did not change).
    const reads = record.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    await h.hooks.list({})
    expect(record.mock.calls.length).toBe(reads)

    await plugins.trust('uid-mark', (await plugins.get('uid-mark')).trust.hash!)
    expect(plugins.state('uid-mark')).toBe('active')
    const trusted = hookListSchema.parse(await h.hooks.list({}))
    expect(trusted.items.filter(item => item.source === 'plugin' && item.pluginId === 'uid-mark').map(item => [item.key, item.state])).toEqual([
      ['plugin:uid-mark:0', 'active'],
      ['plugin:uid-mark:1', 'active'],
      ['plugin:uid-mark:prompt:0', 'active'],
    ])
    expect(JSON.stringify(trusted)).not.toContain(secret)
  })

  it('lists nothing for an untrusted plugin whose folder no longer reads, nor for a disabled one', async () => {
    const h = await kit.open()
    const dir = await installClaude(h, 'uid-mark', claudePluginFiles('uid-mark'), false)
    await writeFile(join(dir, '.claude-plugin/plugin.json'), '{ "name": ')
    // The host's last read still says untrusted; the folder no longer reads as the plugin: nothing is listed.
    expect(h.t.deps.plugins.state('uid-mark')).toBe('untrusted')
    const list = await h.hooks.list({})
    expect(list.items.filter(item => item.source === 'plugin' && item.pluginId === 'uid-mark')).toEqual([])
    await h.t.deps.plugins.disable('uid-mark')
    expect((await h.hooks.list({})).items.filter(item => item.source === 'plugin' && item.pluginId === 'uid-mark')).toEqual([])
  })
})
