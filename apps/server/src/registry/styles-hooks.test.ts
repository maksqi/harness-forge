// The registries of plugin API 1.5.0 (ADR-048, ADR-051; W11.7-T1 / T2): `registry.styles` (output styles: validation,
// reserved builtin names, first-wins conflicts, the per-plugin cap, ownership, change events, contributions) and
// `registry.hookCommands` (one registration of command hooks per plugin, read with the shared `readHooksConfig`: valid
// handlers and diagnostics, the 50-handler cap, the root, conflicts, ownership), plus the 1.5.0 code events of
// `registry.hooks` (`prompt.submit`, `session.start`, `run.stop`, `subagent.stop`, `compact.before`, `notification`
// and the `tool.after` output `context?`).
import type { HookMap, HooksConfig, OutputStyleDefinition } from '@harness-forge/plugin-sdk'
import type { GuardOptions } from '../plugins/types.ts'
import type { RegistryServices } from './index.ts'
import type { RegistryChange } from './types.ts'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger } from '../logger.ts'
import { guardCall } from '../plugins/guard.ts'
import { createRegistryCore } from './index.ts'

interface Harness {
  registry: ReturnType<typeof createRegistryCore>
  logs: Array<{ pluginId: string, level: string, message: string }>
  inactive: Set<string>
}

function harness(): Harness {
  const logs: Harness['logs'] = []
  const inactive = new Set<string>()
  const services: RegistryServices = {
    logger: createMemoryLogger().logger,
    log: (pluginId, level, message) => logs.push({ pluginId, level, message }),
    isRunnable: pluginId => !inactive.has(pluginId),
    guard: <T>(pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, guardOptions: GuardOptions) => guardCall({
      log: (id, level, message) => logs.push({ pluginId: id, level, message }),
      redactText: text => text,
      lifecycleSignal: () => undefined,
      isInactive: () => false,
    }, pluginId, fn, guardOptions),
  }
  return { registry: createRegistryCore(() => services), logs, inactive }
}

function style(name: string, extra: Partial<OutputStyleDefinition> = {}): OutputStyleDefinition {
  return { name, description: `Style ${name}.`, content: `Write in the ${name} way.`, ...extra }
}

const ROOT = '/srv/harness/plugins/acme'

const HOOKS: HooksConfig = {
  PostToolUse: [
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'sh "$HARNESS_PLUGIN_ROOT/scripts/after-edit.sh"', timeout: 30 }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'sh stop.sh' }, { type: 'command', command: '  sh again.sh  ' }] }],
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code
}

function thrown(fn: () => unknown): { code: unknown, message: string, details: unknown } {
  try {
    fn()
  }
  catch (error) {
    const { code, message, details } = error as { code?: unknown, message: string, details?: unknown }
    return { code, message, details }
  }
  throw new Error('expected a throw')
}

describe('registry.styles (plugin API 1.5.0)', () => {
  it('validates a style and stores a frozen copy (description trimmed, keepCodingInstructions filled in)', () => {
    const { registry } = harness()
    registry.styles.register('acme', { name: 'terse', description: '  Short answers.  ', content: 'Be brief.' })
    const entry = registry.styles.get('terse')
    expect(entry).toEqual({ pluginId: 'acme', definition: { name: 'terse', description: 'Short answers.', content: 'Be brief.', keepCodingInstructions: false } })
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry?.definition)).toBe(true)
    registry.styles.register('acme', style('teacher', { keepCodingInstructions: true }))
    expect(registry.styles.get('teacher')?.definition.keepCodingInstructions).toBe(true)
  })

  it('refuses invalid styles and the builtin names with validation_error naming the field', () => {
    const { registry } = harness()
    for (const name of ['default', 'explanatory', 'learning']) {
      const error = thrown(() => registry.styles.register('acme', style(name)))
      expect(error.code).toBe('validation_error')
      expect(error.message).toContain('builtin style')
      expect(error.details).toMatchObject({ issues: [{ path: ['name'] }] })
    }
    expect(codeOf(thrown(() => registry.styles.register('acme', style('Terse'))))).toBe('validation_error')
    expect(codeOf(thrown(() => registry.styles.register('acme', style('terse', { description: '  ' }))))).toBe('validation_error')
    expect(codeOf(thrown(() => registry.styles.register('acme', style('terse', { content: '' }))))).toBe('validation_error')
    expect(codeOf(thrown(() => registry.styles.register('acme', style('terse', { content: 'x'.repeat(64 * 1024 + 1) }))))).toBe('validation_error')
    expect(codeOf(thrown(() => registry.styles.register('acme', { ...style('terse'), extra: true } as OutputStyleDefinition)))).toBe('validation_error')
    expect(codeOf(thrown(() => registry.styles.register('acme', style('terse', { keepCodingInstructions: 'yes' as unknown as boolean }))))).toBe('validation_error')
    expect(codeOf(thrown(() => registry.styles.register('acme', null as unknown as OutputStyleDefinition)))).toBe('validation_error')
    expect(registry.styles.list()).toEqual([])
  })

  it('first registration wins: a name another plugin (or the same one) registered throws conflict', () => {
    const { registry } = harness()
    registry.styles.register('alpha', style('reviewer'))
    const error = thrown(() => registry.styles.register('beta', style('reviewer')))
    expect(error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(error.message).toBe('The output style "reviewer" is already registered by the plugin "alpha".')
    expect(codeOf(thrown(() => registry.styles.register('alpha', style('reviewer'))))).toBe('conflict')
    expect(registry.styles.owner('reviewer')).toBe('alpha')
  })

  it('caps the styles of one plugin at LIMITS.pluginOutputStylesMax', () => {
    const { registry } = harness()
    for (let index = 0; index < LIMITS.pluginOutputStylesMax; index++)
      registry.styles.register('acme', style(`s${index}`))
    const error = thrown(() => registry.styles.register('acme', style('one-more')))
    expect(error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['name'] }] } })
    expect(error.message).toContain(`more than ${LIMITS.pluginOutputStylesMax}`)
    // Another plugin is not affected.
    registry.styles.register('other', style('one-more'))
    expect(registry.contributions('acme').outputStyles).toHaveLength(LIMITS.pluginOutputStylesMax)
  })

  it('lists by name, disposes exactly its entry (idempotent), announces style changes and feeds the contributions', () => {
    const { registry } = harness()
    const styleChanges: string[] = []
    const all: RegistryChange[] = []
    registry.styles.onChange(change => styleChanges.push(`${change.action}:${change.pluginId}:${change.key}`))
    registry.onChange(change => all.push(change))
    const zeta = registry.styles.register('acme', style('zeta'))
    registry.styles.register('acme', style('alpha'))
    registry.styles.register('other', style('mid'))
    registry.tools.register('acme', { name: 'acme_tool', description: 'Tool.', inputSchema: z.object({}), execute: async () => 'ok' })
    expect(registry.styles.list().map(entry => entry.definition.name)).toEqual(['alpha', 'mid', 'zeta'])
    expect(registry.contributions('acme').outputStyles).toEqual(['alpha', 'zeta'])
    zeta.dispose()
    zeta.dispose()
    expect(registry.styles.get('zeta')).toBeUndefined()
    expect(styleChanges).toEqual(['added:acme:zeta', 'added:acme:alpha', 'added:other:mid', 'removed:acme:zeta'])
    expect(all.filter(change => change.kind === 'style')).toHaveLength(4)
    // A disposed name can be registered again (by anyone); the old handle never removes the new entry.
    registry.styles.register('other', style('zeta'))
    zeta.dispose()
    expect(registry.styles.owner('zeta')).toBe('other')
  })

  it('removeOwner drops every style of a plugin with a removed change each', () => {
    const { registry } = harness()
    const removed: string[] = []
    registry.styles.onChange((change) => {
      if (change.action === 'removed')
        removed.push(change.key)
    })
    registry.styles.register('acme', style('a'))
    registry.styles.register('acme', style('b'))
    registry.styles.register('other', style('c'))
    expect(registry.removeOwner('acme')).toBe(2)
    expect(removed.sort()).toEqual(['a', 'b'])
    expect(registry.styles.list().map(entry => entry.definition.name)).toEqual(['c'])
    expect(registry.contributions('acme').outputStyles).toEqual([])
  })
})

describe('registry.hookCommands (plugin API 1.5.0)', () => {
  it('reads the hooks with readHooksConfig: valid handlers in declaration order, the root and no diagnostics', () => {
    const { registry } = harness()
    registry.hookCommands.register('acme', { root: ROOT, hooks: HOOKS })
    const entry = registry.hookCommands.get('acme')
    expect(entry).toEqual({
      pluginId: 'acme',
      root: ROOT,
      hooks: [
        { event: 'PostToolUse', matcher: 'Write|Edit|MultiEdit', command: 'sh "$HARNESS_PLUGIN_ROOT/scripts/after-edit.sh"', timeoutSec: 30, position: [0, 0] },
        { event: 'Stop', matcher: null, command: 'sh stop.sh', timeoutSec: null, position: [0, 0] },
        { event: 'Stop', matcher: null, command: 'sh again.sh', timeoutSec: null, position: [0, 1] },
      ],
      diagnostics: [],
      // Phase 12 (C43): no extra environment, no prompt handlers.
      env: {},
      prompts: [],
    })
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry?.hooks)).toBe(true)
    expect(Object.isFrozen(entry?.hooks[0])).toBe(true)
    expect(registry.contributions('acme').commandHooks).toBe(3)
  })

  it('keeps diagnostics: unknown events, prompt handlers and invalid matchers never run and are not counted', () => {
    const { registry } = harness()
    const hooks = {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: 'sh never.sh' }] },
        { matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Is this safe?' }, { type: 'command', command: 'sh guard.sh', extra: 1 }] },
      ],
      OnSave: [{ hooks: [{ type: 'command', command: 'sh save.sh' }] }],
    } as unknown as HooksConfig
    registry.hookCommands.register('acme', { root: ROOT, hooks })
    const entry = registry.hookCommands.get('acme')!
    expect(entry.hooks.map(spec => spec.command)).toEqual(['sh guard.sh'])
    expect(entry.diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual(['ignored-field', 'invalid-matcher', 'unknown-event', 'unsupported-type'])
    // Diagnostics never quote a command.
    expect(JSON.stringify(entry.diagnostics)).not.toContain('never.sh')
    expect(registry.contributions('acme').commandHooks).toBe(1)
  })

  it('refuses a relative root, a hooks value that is not an object and more than 50 handlers', () => {
    const { registry } = harness()
    expect(thrown(() => registry.hookCommands.register('acme', { root: 'plugins/acme', hooks: HOOKS }))).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['root'] }] } })
    expect(thrown(() => registry.hookCommands.register('acme', { root: '', hooks: HOOKS }))).toMatchObject({ code: 'validation_error' })
    expect(thrown(() => registry.hookCommands.register('acme', { root: ROOT, hooks: [] as unknown as HooksConfig }))).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['hooks'] }] } })
    expect(thrown(() => registry.hookCommands.register('acme', { root: ROOT, hooks: null as unknown as HooksConfig }))).toMatchObject({ code: 'validation_error' })
    const handlers = Array.from({ length: LIMITS.pluginHooksMax + 1 }, (_, index) => ({ type: 'command' as const, command: `sh hook-${index}.sh` }))
    const tooMany = thrown(() => registry.hookCommands.register('acme', { root: ROOT, hooks: { Stop: [{ hooks: handlers }] } }))
    expect(tooMany).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['hooks'] }] } })
    expect(tooMany.message).toContain(`at most ${LIMITS.pluginHooksMax}`)
    expect(registry.hookCommands.list()).toEqual([])
    // Exactly 50 handlers are fine.
    registry.hookCommands.register('acme', { root: ROOT, hooks: { Stop: [{ hooks: handlers.slice(0, LIMITS.pluginHooksMax) }] } })
    expect(registry.contributions('acme').commandHooks).toBe(LIMITS.pluginHooksMax)
  })

  it('one registration per plugin; registry order; dispose and removeOwner announce hookCommands changes', () => {
    const { registry } = harness()
    const changes: string[] = []
    registry.hookCommands.onChange(change => changes.push(`${change.kind}:${change.action}:${change.pluginId}:${change.key}`))
    const zeta = registry.hookCommands.register('zeta', { root: '/srv/zeta', hooks: HOOKS })
    registry.hookCommands.register('alpha', { root: '/srv/alpha', hooks: HOOKS })
    registry.hookCommands.register('core-tools', { root: '/srv/core', hooks: HOOKS })
    expect(thrown(() => registry.hookCommands.register('alpha', { root: '/srv/alpha', hooks: HOOKS }))).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(registry.hookCommands.list().map(entry => entry.pluginId)).toEqual(['core-tools', 'alpha', 'zeta'])
    zeta.dispose()
    zeta.dispose()
    expect(registry.hookCommands.get('zeta')).toBeUndefined()
    expect(registry.removeOwner('alpha')).toBe(1)
    expect(registry.hookCommands.list().map(entry => entry.pluginId)).toEqual(['core-tools'])
    expect(changes).toEqual([
      'hookCommands:added:zeta:zeta',
      'hookCommands:added:alpha:alpha',
      'hookCommands:added:core-tools:core-tools',
      'hookCommands:removed:zeta:zeta',
      'hookCommands:removed:alpha:alpha',
    ])
    expect(registry.contributions('alpha').commandHooks).toBe(0)
  })
})

describe('code hook events of plugin API 1.5.0 (registry.hooks)', () => {
  const context = { chatId: 'c1', modelRef: 'mock:hooks' }

  it('runs every new event in call order and commits the output drafts', async () => {
    const { registry } = harness()
    const seen: string[] = []
    registry.hooks.on('acme', 'prompt.submit', (input, output) => {
      seen.push(`prompt.submit:${input.prompt}:${input.projectId}:${input.command ?? '-'}`)
      output.context = 'Remember the style guide.'
    })
    registry.hooks.on('guard', 'prompt.submit', (input, output) => {
      if (input.prompt.includes('secret'))
        output.block = 'No secrets, please.'
    })
    registry.hooks.on('acme', 'session.start', (input, output) => {
      seen.push(`session.start:${input.source}`)
      output.context = 'Session context.'
    })
    registry.hooks.on('acme', 'run.stop', (input, output) => {
      seen.push(`run.stop:${input.origin}:${input.hookActive}`)
      if (!input.hookActive)
        output.continue = 'Run the tests first.'
    })
    registry.hooks.on('acme', 'subagent.stop', (input, output) => {
      seen.push(`subagent.stop:${input.type}:${input.report}`)
      output.continue = 'Check one more file.'
    })
    registry.hooks.on('acme', 'compact.before', input => void seen.push(`compact.before:${input.trigger}:${input.focus}`))
    registry.hooks.on('acme', 'notification', input => void seen.push(`notification:${input.type}`))
    registry.hooks.on('acme', 'tool.after', (input, output) => {
      seen.push(`tool.after:${input.tool}`)
      output.context = 'A file changed.'
    })

    const prompt: HookMap['prompt.submit'][1] = {}
    await registry.hooks.run('prompt.submit', { ...context, prompt: 'share the secret', projectId: 'prj_aaaaaaaaaaaaaaaa', command: 'deploy' }, prompt)
    expect(prompt).toEqual({ context: 'Remember the style guide.', block: 'No secrets, please.' })
    const session: HookMap['session.start'][1] = {}
    await registry.hooks.run('session.start', { ...context, source: 'compact', projectId: null }, session)
    expect(session).toEqual({ context: 'Session context.' })
    const stop: HookMap['run.stop'][1] = {}
    await registry.hooks.run('run.stop', { ...context, origin: 'request', hookActive: false, projectId: null }, stop)
    expect(stop).toEqual({ continue: 'Run the tests first.' })
    const again: HookMap['run.stop'][1] = {}
    await registry.hooks.run('run.stop', { ...context, origin: 'hook', hookActive: true, projectId: null }, again)
    expect(again).toEqual({})
    const child: HookMap['subagent.stop'][1] = {}
    await registry.hooks.run('subagent.stop', { ...context, type: 'explore', toolCallId: 'call_1', report: 'done', hookActive: false }, child)
    expect(child).toEqual({ continue: 'Check one more file.' })
    await registry.hooks.run('compact.before', { ...context, trigger: 'manual', focus: 'the API' }, undefined)
    await registry.hooks.run('notification', { ...context, type: 'permission_prompt', message: 'The agent needs your permission to use Bash.' }, undefined)
    const after: HookMap['tool.after'][1] = { output: { ok: true } }
    await registry.hooks.run('tool.after', { ...context, tool: 'write_file', toolCallId: 'call_2', input: {} }, after)
    expect(after).toEqual({ output: { ok: true }, context: 'A file changed.' })

    expect(seen).toEqual([
      'prompt.submit:share the secret:prj_aaaaaaaaaaaaaaaa:deploy',
      'session.start:compact',
      'run.stop:request:false',
      'run.stop:hook:true',
      'subagent.stop:explore:done',
      'compact.before:manual:the API',
      'notification:permission_prompt',
      'tool.after:write_file',
    ])
    expect(registry.contributions('acme').hooks).toEqual(['tool.after', 'prompt.submit', 'session.start', 'run.stop', 'subagent.stop', 'compact.before', 'notification'])
  })

  it('a failing or inactive handler changes nothing and never blocks (only tool.before rethrows)', async () => {
    const { registry, logs, inactive } = harness()
    registry.hooks.on('broken', 'prompt.submit', (_input, output) => {
      output.block = 'half-written'
      throw new Error('prompt hook failed')
    })
    registry.hooks.on('asleep', 'run.stop', (_input, output) => {
      output.continue = 'never'
    })
    inactive.add('asleep')
    const prompt: HookMap['prompt.submit'][1] = {}
    await expect(registry.hooks.run('prompt.submit', { ...context, prompt: 'hi', projectId: null }, prompt)).resolves.toBeUndefined()
    expect(prompt).toEqual({})
    expect(logs.some(entry => entry.pluginId === 'broken' && entry.message.includes('prompt hook failed'))).toBe(true)
    const stop: HookMap['run.stop'][1] = {}
    await registry.hooks.run('run.stop', { ...context, origin: 'request', hookActive: false, projectId: null }, stop)
    expect(stop).toEqual({})
  })
})
