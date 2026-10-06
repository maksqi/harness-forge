// User-invocable skills in `/` (W11.5-T5): resolution order client → harness → definition command → plugin command →
// an active user-invocable skill (a command wins a name); the expansion is `expandArguments(content, input)` (text only:
// spans and references are never run or read); the invocation is `kind: 'skill'` with the skill's source; names of up
// to 64 characters; `listServerCommands` and `isServerCommandFor` include the skills. The catalog is the fake.
import type { CommandDefinition } from '@harness-forge/plugin-sdk'
import type { CustomizationEntry } from '@harness-forge/shared'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { CommandExpansionHost, CommandResolution, CommandServices } from './commands.ts'
import { commandInvocationSchema, commandSummarySchema } from '@harness-forge/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { invocableSkill, isServerCommandFor, listServerCommands, resolveCommand } from './commands.ts'

const PROJECT = 'prj_0123456789abcdef'
const OTHER = 'prj_fedcba9876543210'
const LONG = `deploy-${'x'.repeat(50)}`

function registryOf(commands: Record<string, CommandDefinition>): CommandServices['registry'] {
  return {
    commands: {
      get: (name: string) => (commands[name] === undefined ? undefined : { pluginId: 'demo', definition: commands[name] }),
      list: () => Object.values(commands).map(definition => ({ pluginId: 'demo', definition })),
      register: () => ({ dispose() {} }),
    },
  } as unknown as CommandServices['registry']
}

function skillFile(fake: FakeCustomizationService, projectId: string, name: string, content: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  const entry = fakeCatalogEntry('skill', name, { source: 'project', ...fields })
  const key = fields.source === 'plugin' ? '' : projectId
  fake.entries.set(key, [...(fake.entries.get(key) ?? []), entry])
  fake.bodies.set(catalogEntryKey(entry), content)
  return entry
}

/** A host that records every question: a skill never asks it anything. */
function silentHost(asked: string[]): CommandExpansionHost {
  return {
    projectId: PROJECT,
    shellEnabled: true,
    workspace: async () => {
      asked.push('workspace')
      return null
    },
    trusted: async () => {
      asked.push('trusted')
      return true
    },
  }
}

describe('user-invocable skills in / (W11.5-T5)', () => {
  let fake: FakeCustomizationService

  beforeEach(() => {
    fake = createFakeCustomizationService()
    skillFile(fake, PROJECT, 'deploy', '---\nname: deploy\ndescription: Deploys.\nargument-hint: <env>\n---\nDeploy to $ARGUMENTS with !`rm -rf /tmp/never` and @README.md.', { argumentHint: '<env>' })
    skillFile(fake, PROJECT, 'internal', '---\nname: internal\ndescription: Internal.\ndisable-model-invocation: true\n---\nInternal notes.', { modelInvocable: false })
    skillFile(fake, PROJECT, 'hidden', '---\nname: hidden\ndescription: Hidden.\nuser-invocable: false\n---\nHidden.', { userInvocable: false })
    skillFile(fake, PROJECT, 'stale', '---\nname: stale\ndescription: Stale.\nuser-invocable: false\n---\nStale.')
    skillFile(fake, PROJECT, LONG, `---\nname: ${LONG}\ndescription: Long.\n---\nLong $1.`)
    skillFile(fake, PROJECT, 'packed', '---\nname: packed\ndescription: Packed.\n---\nPacked $ARGUMENTS.', { source: 'plugin', pluginId: 'skill-pack' })
  })

  async function resolve(text: string, commands: Record<string, CommandDefinition> = {}, projectId: string | null = PROJECT, asked: string[] = []): Promise<CommandResolution | null> {
    const services: CommandServices = { registry: registryOf(commands), plugins: { guard: async (_id, fn) => fn(new AbortController().signal) }, customizations: fake }
    return resolveCommand(services, text, { chatId: 'chat', signal: new AbortController().signal, catalog: await fake.catalog(projectId), expansion: silentHost(asked) })
  }

  it('/deploy prod expands the skill content as text (no spans run, no files read) into a skill invocation', async () => {
    const asked: string[] = []
    const resolution = await resolve('/deploy prod', {}, PROJECT, asked)
    const invocation = resolution?.kind === 'prompt' ? resolution.invocation : undefined
    expect(invocation).toEqual({
      name: 'deploy',
      input: 'prod',
      type: 'prompt',
      expansion: 'Deploy to prod with !`rm -rf /tmp/never` and @README.md.',
      kind: 'skill',
      source: 'project',
    })
    expect(commandInvocationSchema.safeParse(invocation).success).toBe(true)
    expect(asked).toEqual([])
  })

  it('a disable-model-invocation skill still runs; a plugin skill carries its source; names up to 64 characters', async () => {
    expect(await resolve('/internal')).toMatchObject({ kind: 'prompt', invocation: { name: 'internal', expansion: 'Internal notes.', kind: 'skill' } })
    expect(await resolve('/packed it', {}, null)).toMatchObject({ kind: 'prompt', invocation: { name: 'packed', expansion: 'Packed it.', kind: 'skill', source: 'plugin' } })
    expect(await resolve(`/${LONG} a b`)).toMatchObject({ kind: 'prompt', invocation: { name: LONG, input: 'a b', expansion: 'Long a.', kind: 'skill' } })
  })

  it('a user-invocable: false skill is not a command; a skill whose file turned it off since is a validation_error', async () => {
    expect(await resolve('/hidden')).toBeNull()
    await expect(resolve('/stale')).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
    // Another project's chat has no such skill.
    expect(await resolve('/deploy prod', {}, OTHER)).toBeNull()
  })

  it('a command of any source wins the name over a skill', async () => {
    expect(await resolve('/deploy prod', { deploy: { name: 'deploy', description: 'Plugin.', template: 'PLUGIN {{input}}' } })).toMatchObject({ kind: 'prompt', invocation: { expansion: 'PLUGIN prod' } })
    await fake.create({ kind: 'command', content: '---\nname: deploy\ndescription: Mine.\n---\nMINE $ARGUMENTS' })
    const mine = await resolve('/deploy prod')
    expect(mine).toMatchObject({ kind: 'prompt', invocation: { expansion: 'MINE prod', source: 'user' } })
    expect(mine?.invocation).not.toHaveProperty('kind')
  })

  it('never takes a client or harness command name', async () => {
    skillFile(fake, PROJECT, 'compact', '---\nname: compact\ndescription: Forged.\n---\nForged.')
    skillFile(fake, PROJECT, 'model', '---\nname: model\ndescription: Forged.\n---\nForged.')
    const catalog = await fake.catalog(PROJECT)
    expect(invocableSkill(catalog, 'compact')).toBeNull()
    expect(invocableSkill(catalog, 'model')).toBeNull()
    expect(invocableSkill(catalog, 'deploy')).toMatchObject({ name: 'deploy' })
    expect(invocableSkill(null, 'deploy')).toBeNull()
    expect(await resolve('/compact keep it')).toMatchObject({ kind: 'compact' })
    expect(await resolve('/model x')).toBeNull()
  })

  it('listServerCommands lists the user-invocable skills after the commands that own their names', async () => {
    await fake.create({ kind: 'command', content: '---\nname: internal\ndescription: My internal command.\n---\nCommand.' })
    const listed = listServerCommands(registryOf({ tldr: { name: 'tldr', description: 'TL;DR.', template: 'T' } }), await fake.catalog(PROJECT))
    for (const item of listed)
      expect(commandSummarySchema.safeParse(item).success, item.name).toBe(true)
    expect(listed.map(item => `${item.name}:${item.kind}:${item.source}`)).toEqual([
      'compact:command:harness',
      'deploy:skill:project',
      `${LONG}:skill:project`,
      'internal:command:user',
      'packed:skill:plugin',
      'stale:skill:project',
      'tldr:command:plugin',
    ])
    expect(listed.find(item => item.name === 'deploy')).toEqual({ name: 'deploy', kind: 'skill', description: 'The deploy skill.', source: 'project', argumentHint: '<env>' })
    expect(listed.find(item => item.name === 'packed')).toEqual({ name: 'packed', kind: 'skill', description: 'The packed skill.', source: 'plugin', pluginId: 'skill-pack' })
    // Without a project: the global entries only (the personal command and the plugin skill).
    expect(listServerCommands(registryOf({}), await fake.catalog(null)).map(item => `${item.name}:${item.kind}`)).toEqual(['compact:command', 'internal:command', 'packed:skill'])
  })

  it('isServerCommandFor counts the user-invocable skills of the chat\'s project', async () => {
    const deps = { registry: registryOf({}), customizations: fake } as unknown as Parameters<typeof isServerCommandFor>[0]
    expect(await isServerCommandFor(deps, PROJECT, '/deploy prod')).toBe(true)
    expect(await isServerCommandFor(deps, PROJECT, `/${LONG}`)).toBe(true)
    expect(await isServerCommandFor(deps, PROJECT, '/hidden')).toBe(false)
    expect(await isServerCommandFor(deps, OTHER, '/deploy prod')).toBe(false)
    expect(await isServerCommandFor(deps, null, '/packed')).toBe(true)
  })
})
