import type { CommandDefinition } from '@harness-forge/plugin-sdk'
import type { CommandServices } from './commands.ts'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { expandTemplate, parseSlashCommand, resolveCommand } from './commands.ts'

describe('parseSlashCommand', () => {
  it('reads /name at the start followed by whitespace or the end', () => {
    expect(parseSlashCommand('/summarize some text')).toEqual({ name: 'summarize', input: 'some text' })
    expect(parseSlashCommand('/summarize')).toEqual({ name: 'summarize', input: '' })
    expect(parseSlashCommand('  /fix\n  the bug  ')).toEqual({ name: 'fix', input: 'the bug' })
    expect(parseSlashCommand('/sum-up it')).toEqual({ name: 'sum-up', input: 'it' })
  })

  it('ignores text that is not a command', () => {
    expect(parseSlashCommand('hello /summarize')).toBeNull()
    expect(parseSlashCommand('/Summarize x')).toBeNull()
    expect(parseSlashCommand('/summarize,now')).toBeNull()
    expect(parseSlashCommand('/1abc')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand(`/${'a'.repeat(40)}`)).toBeNull()
  })
})

describe('expandTemplate', () => {
  it('replaces every {{input}} or appends the input after a blank line', () => {
    expect(expandTemplate('Say {{input}} twice: {{input}}', 'hi')).toBe('Say hi twice: hi')
    expect(expandTemplate('No placeholder.', 'extra')).toBe('No placeholder.\n\nextra')
    expect(expandTemplate('No placeholder.', '')).toBe('No placeholder.')
    expect(expandTemplate('A {{input}} B', '')).toBe('A  B')
  })
})

function services(commands: Record<string, CommandDefinition>, pluginId = 'demo'): CommandServices {
  return {
    registry: {
      commands: {
        get: name => (commands[name] === undefined ? undefined : { pluginId, definition: commands[name] }),
        list: () => [],
        register: () => ({ dispose() {} }),
      },
    },
    plugins: {
      guard: async (_pluginId, fn) => {
        try {
          return await fn(new AbortController().signal)
        }
        catch (error) {
          throw new HarnessError({ code: 'plugin_error', message: error instanceof Error ? error.message : 'failed', details: { pluginId, phase: 'tool' } })
        }
      },
    },
  }
}

const context = { chatId: 'chat', signal: new AbortController().signal }

describe('resolveCommand', () => {
  it('expands template commands', async () => {
    const result = await resolveCommand(services({ tldr: { name: 'tldr', description: 'x', template: 'TL;DR: {{input}}' } }), '/tldr long text', context)
    expect(result).toEqual({ kind: 'prompt', invocation: { name: 'tldr', input: 'long text', type: 'prompt', expansion: 'TL;DR: long text' } })
  })

  it('ignores unknown and client-only commands', async () => {
    const all = services({ new: { name: 'new', description: 'x', template: 'never' } })
    expect(await resolveCommand(all, '/unknown x', context)).toBeNull()
    expect(await resolveCommand(all, '/new', context)).toBeNull()
    expect(await resolveCommand(all, 'plain text', context)).toBeNull()
  })

  it('runs run commands: prompt and reply results', async () => {
    const commands: Record<string, CommandDefinition> = {
      ask: { name: 'ask', description: 'x', run: async ({ input, chatId }) => ({ type: 'prompt', text: `${chatId}: ${input}` }) },
      roll: { name: 'roll', description: 'x', run: async () => ({ type: 'reply', markdown: '**4**' }) },
    }
    expect(await resolveCommand(services(commands), '/ask why', context)).toEqual({ kind: 'prompt', invocation: { name: 'ask', input: 'why', type: 'prompt', expansion: 'chat: why' } })
    expect(await resolveCommand(services(commands), '/roll', context)).toEqual({ kind: 'reply', invocation: { name: 'roll', input: '', type: 'reply' }, markdown: '**4**' })
  })

  it('reports a failing or invalid run command as plugin_error', async () => {
    const commands: Record<string, CommandDefinition> = {
      boom: { name: 'boom', description: 'x', run: async () => {
        throw new Error('exploded')
      } },
      odd: { name: 'odd', description: 'x', run: async () => ({ type: 'other' }) as never },
    }
    const failed = await resolveCommand(services(commands), '/boom', context)
    expect(failed?.kind).toBe('failed')
    expect(failed?.kind === 'failed' ? failed.error.toJSON().error : null).toMatchObject({ code: 'plugin_error', message: 'exploded' })
    expect(failed?.invocation).toEqual({ name: 'boom', input: '', type: 'reply' })
    const odd = await resolveCommand(services(commands), '/odd', context)
    expect(odd?.kind === 'failed' ? odd.error.message : '').toBe('The /odd command returned an invalid result.')
  })

  it('rejects an expansion larger than 64 KB', async () => {
    const big = services({ big: { name: 'big', description: 'x', template: '{{input}}' } })
    await expect(resolveCommand(big, `/big ${'x'.repeat(LIMITS.commandExpansionBytes + 1)}`, context)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('rethrows the abort of a stopped run', async () => {
    const controller = new AbortController()
    const slow: CommandServices = {
      ...services({}),
      registry: services({ slow: { name: 'slow', description: 'x', run: async () => ({ type: 'reply', markdown: 'late' }) } }).registry,
      plugins: {
        guard: async () => {
          controller.abort(new DOMException('stopped', 'AbortError'))
          throw controller.signal.reason
        },
      },
    }
    await expect(resolveCommand(slow, '/slow', { chatId: 'chat', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
