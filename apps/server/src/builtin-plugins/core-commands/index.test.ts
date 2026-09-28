import type { CommandDefinition, PluginContext } from '@harness-forge/plugin-sdk'
import { CLIENT_COMMANDS, COMMAND_NAME_PATTERN, declarativeCommandSchema, pluginManifestBaseSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import coreCommands, { BUILTIN_COMMANDS, manifest } from './index.ts'

describe('core-commands plugin', () => {
  it('exports a builtin manifest', () => {
    expect(pluginManifestBaseSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('core-commands')
  })

  it('defines template commands that follow the command rules', () => {
    expect(BUILTIN_COMMANDS.length).toBeGreaterThan(0)
    const names = BUILTIN_COMMANDS.map(command => command.name)
    expect(new Set(names).size).toBe(names.length)
    for (const command of BUILTIN_COMMANDS) {
      expect(command.name).toMatch(COMMAND_NAME_PATTERN)
      expect(CLIENT_COMMANDS as readonly string[]).not.toContain(command.name)
      expect(command.template).toContain('{{input}}')
      expect(command.run).toBeUndefined()
      expect(declarativeCommandSchema.safeParse({ name: command.name, description: command.description, template: command.template }).success, command.name).toBe(true)
    }
  })

  it('does not take names used by the PLUGINS.md examples', () => {
    const names = BUILTIN_COMMANDS.map(command => command.name)
    for (const example of ['tldr', 'acme', 'sample-tldr', 'sample-count'])
      expect(names).not.toContain(example)
  })

  it('registers every command through ctx.commands.register', async () => {
    const registered: CommandDefinition[] = []
    const ctx = {
      commands: {
        register(definition: CommandDefinition) {
          registered.push(definition)
          return { dispose() {} }
        },
      },
    } as unknown as PluginContext
    await coreCommands.setup(ctx)
    expect(registered).toEqual([...BUILTIN_COMMANDS])
  })
})
