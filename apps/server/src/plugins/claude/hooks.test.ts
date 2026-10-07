/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` is literal plugin content */
// Hooks of Claude Code plugins (W12.1-T5): `hooks/hooks.json`, the hook files and the inline maps of `plugin.json`
// merged per event, read with prompts on; unknown events and handler types stay diagnostics; more than 50 handlers are
// trimmed before the registration; every command handler of any event is an executable; the registry keeps the
// environment and the prompt handlers.
import type { HooksConfig } from '@harness-forge/plugin-sdk'
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createRegistryCore } from '../../registry/index.ts'
import { claudePluginFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { readClaudeHooks } from './hooks.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function root(files: FixtureTree): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-claude-hooks-')))
  roots.push(dir)
  await writeFileTree(dir, files)
  return dir
}

function json(value: unknown): { content: string, mode: number } {
  return { content: JSON.stringify(value), mode: 0o644 }
}

function registry() {
  return createRegistryCore(() => ({
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    guard: async (_id, fn) => fn(new AbortController().signal),
    log: () => {},
    isRunnable: () => true,
  }))
}

describe('readClaudeHooks', () => {
  it('review-kit: one command handler, two diagnostics, two executables (any event), the http host', async () => {
    const dir = await root(claudePluginFiles('review-kit'))
    const read = await readClaudeHooks({ root: dir, files: ['hooks/hooks.json'], inline: [] })
    expect(read.component.commands).toEqual([expect.objectContaining({ event: 'PostToolUse', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh' })])
    expect(read.component.diagnostics.map(item => item.code)).toEqual(['unsupported-type', 'unknown-event'])
    expect(read.executables.map(item => item.label)).toEqual(['PostToolUse Write|Edit', 'TeammateIdle *'])
    expect(read.hosts).toEqual(['hooks.example.com'])
    expect(read.unsupported).toEqual([{ component: 'hooks.PostToolUse (http)', reason: 'HTTP hook handlers are not supported; they never run.' }])
  })

  it('merges the files and the inline maps per event, prompt handlers included', async () => {
    const dir = await root({
      'hooks/hooks.json': json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh a.sh' }] }] } }),
      'more/hooks.json': json({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the work done? [[ph:ok]]' }] }] } }),
    })
    const read = await readClaudeHooks({
      root: dir,
      files: ['hooks/hooks.json', 'more/hooks.json'],
      inline: [{ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh', args: ['--strict'] }] }] }],
    })
    expect(read.component.config).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'sh a.sh' }] }, { hooks: [{ type: 'prompt', prompt: 'Is the work done? [[ph:ok]]' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh', args: ['--strict'] }] }],
    })
    expect(read.component.commands.map(spec => spec.command)).toEqual(['sh a.sh', 'sh guard.sh'])
    expect(read.component.prompts.map(spec => spec.prompt)).toEqual(['Is the work done? [[ph:ok]]'])
    expect(read.executables.map(item => item.command)).toEqual(['sh a.sh', 'sh guard.sh --strict'])
  })

  it('reports a file without the hooks wrapper, invalid JSON and a missing file; keeps the rest', async () => {
    const dir = await root({ 'a.json': json({ Stop: [] }), 'b.json': { content: '{', mode: 0o644 } })
    const read = await readClaudeHooks({ root: dir, files: ['a.json', 'b.json', 'missing.json'], inline: [] })
    expect(read.diagnostics.map(item => [item.code, item.path])).toEqual([['not-an-object', 'a.json'], ['invalid-json', 'b.json'], ['read-failed', 'missing.json']])
    expect(read.component.commands).toEqual([])
  })

  it('trims more than LIMITS.pluginHooksMax handlers (a warning) so the registration never throws', async () => {
    const handlers = Array.from({ length: LIMITS.pluginHooksMax + 5 }, (_, index) => ({ type: 'command', command: `sh hook-${index}.sh` }))
    const dir = await root({ 'hooks/hooks.json': json({ hooks: { PostToolUse: [{ hooks: handlers }] } }) })
    const read = await readClaudeHooks({ root: dir, files: ['hooks/hooks.json'], inline: [] })
    expect(read.component.commands).toHaveLength(LIMITS.pluginHooksMax)
    expect(read.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'too-many', level: 'warning' })]))
    // The trust consent still lists every handler declared.
    expect(read.executables).toHaveLength(LIMITS.pluginHooksMax + 5)
    const core = registry()
    core.hookCommands.register('kit', { root: dir, hooks: read.component.config, env: { CLAUDE_PLUGIN_DATA: '/data/kit' } })
    expect(core.hookCommands.get('kit')).toMatchObject({ env: { CLAUDE_PLUGIN_DATA: '/data/kit' }, prompts: [] })
    expect(core.contributions('kit').commandHooks).toBe(LIMITS.pluginHooksMax)
  })
})

describe('registry.hookCommands (plugin API 1.6.0)', () => {
  const config = { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done? [[ph:ok]]', timeout: 5 }, { type: 'command', command: 'sh stop.sh' }] }] } as unknown as HooksConfig

  it('reads prompt handlers, adds the registration prompts and keeps a frozen environment', () => {
    const core = registry()
    const extra = { event: 'UserPromptSubmit', matcher: null, prompt: 'Allowed? [[ph:ok]]', model: null, timeoutSec: null, continueOnBlock: false, position: [0, 0] } as const
    core.hookCommands.register('kit', { root: '/srv/kit', hooks: config, env: { CLAUDE_PLUGIN_OPTION_A: 'x' }, prompts: [extra] })
    const entry = core.hookCommands.get('kit')!
    expect(entry.hooks.map(spec => spec.command)).toEqual(['sh stop.sh'])
    expect(entry.prompts.map(spec => [spec.event, spec.prompt, spec.timeoutSec])).toEqual([['Stop', 'Done? [[ph:ok]]', 5], ['UserPromptSubmit', 'Allowed? [[ph:ok]]', null]])
    expect(entry.env).toEqual({ CLAUDE_PLUGIN_OPTION_A: 'x' })
    expect(Object.isFrozen(entry.env)).toBe(true)
    expect(entry.diagnostics).toEqual([])
  })

  it.each([
    [{ env: { PATH: '/tmp' } }, 'env'],
    [{ env: { CLAUDE_PLUGIN_ROOT: '/x' } }, 'env'],
    [{ env: { 'BAD-NAME': 'x' } }, 'env'],
    [{ env: { OK: 'a\0b' } }, 'env'],
    [{ env: 'x' }, 'env'],
    [{ prompts: [{ event: 'SessionStart', matcher: null, prompt: 'x', model: null, timeoutSec: null, continueOnBlock: false, position: [0, 0] }] }, 'prompts'],
    [{ prompts: 'x' }, 'prompts'],
  ])('refuses %j with validation_error on %s', (extra, path) => {
    const core = registry()
    expect(() => core.hookCommands.register('kit', { root: '/srv/kit', hooks: {}, ...(extra as object) })).toThrow(expect.objectContaining({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: expect.arrayContaining([path]) })] } }))
  })

  it('counts the registration prompts against the handler limit', () => {
    const core = registry()
    const prompts = Array.from({ length: LIMITS.pluginHooksMax }, () => ({ event: 'Stop', matcher: null, prompt: 'x', model: null, timeoutSec: null, continueOnBlock: false, position: [0, 0] }))
    expect(() => core.hookCommands.register('kit', { root: '/srv/kit', hooks: config, prompts: prompts as never })).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })
})
