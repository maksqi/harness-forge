// `prepareRun` with the Phase 12 definition keys (W12.7-T8, T9; ADR-058): a command's Claude model name runs the turn on
// the model the `modelAliases` setting names, or the request's model with the `command-model-unavailable` notice when it
// does not resolve; the turn's tools narrow to the command's `allowed-tools` without its `disallowed-tools` (the catalog
// entry, subtracted from the registered tools; restrict-only), a fork's `/name` keeps `task`. The catalog is the fake
// service; models are the mock provider's.
import type { ChatRequestBody, CustomizationEntry } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { PreparedRun } from './prepare.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { catalogEntryKey, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { NOTICES } from './notices.ts'
import { commitHistory, prepareRun, withAliasNotice } from './prepare.ts'
import { createRunRegistry } from './runs.ts'
import { chatBody, testChatId } from './testing.ts'

let nextChat = 0xD000

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

describe('prepareRun: Claude model names and restrict-only tools (W12.7-T8, T9)', () => {
  let t: TestApp
  let fake: FakeCustomizationService

  async function prepare(body: ChatRequestBody): Promise<PreparedRun> {
    const run = createRunRegistry().acquire(body.chatId, body.modelRef)
    const prepared = await prepareRun(t.deps, run, body, createSilentLogger())
    await commitHistory(t.deps, body.chatId, prepared.writes)
    return prepared
  }

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake', hooks: 'fake' })
    fake = t.deps.customizations as FakeCustomizationService
    await fake.create({ kind: 'command', content: '---\nname: fast\ndescription: Fast.\nmodel: sonnet\n---\nGo $ARGUMENTS' })
    await fake.create({ kind: 'command', content: '---\nname: safe\ndescription: Safe.\nallowed-tools: Read, Bash\n---\nLook $ARGUMENTS' })
    await fake.create({ kind: 'command', content: '---\nname: quiet\ndescription: Quiet.\n---\nHush $ARGUMENTS' })
  })

  afterAll(async () => {
    await t.close()
  })

  it('model: sonnet runs on the modelAliases model; unset, the request\'s model answers with the notice', async () => {
    await t.deps.settings.update({ modelAliases: { sonnet: 'mock:agents', opus: null, haiku: null, fable: null } })
    const aliased = await prepare(chatBody(newChatId(), '/fast now'))
    expect(aliased.resolved.modelRef).toBe('mock:agents')
    expect(aliased.requestModelRef).toBe('mock:echo')
    expect(aliased.userMessage?.metadata?.command).toMatchObject({ name: 'fast', modelRef: 'mock:agents' })
    expect(aliased.notices).toEqual([])

    await t.deps.settings.update({ modelAliases: { sonnet: null, opus: null, haiku: null, fable: null } })
    const fallback = await prepare(chatBody(newChatId(), '/fast now'))
    expect(fallback.resolved.modelRef).toBe('mock:echo')
    expect(fallback.userMessage?.metadata?.command?.modelRef).toBeUndefined()
    expect(fallback.notices).toEqual([NOTICES.commandModelUnavailable('sonnet')])
  })

  it('disallowed-tools remove tools of the turn (with and without allowed-tools); a fork keeps task', async () => {
    const registered = t.deps.registry.tools.list().map(tool => tool.definition.name)
    expect(registered).toContain('shell')
    const file = (name: string, content: string, fields: Partial<CustomizationEntry>): void => {
      const entry = fakeCatalogEntry('command', name, { source: 'project', path: `.harness/commands/${name}.md`, ...fields })
      fake.entries.set('', [...(fake.entries.get('') ?? []), entry])
      fake.bodies.set(catalogEntryKey(entry), content)
    }
    file('nosh', '---\ndescription: x\ndisallowed-tools: Bash\n---\nNo shell $ARGUMENTS', { disallowedTools: ['shell'] })
    file('nosh-read', '---\ndescription: x\nallowed-tools: Read, Bash\ndisallowed-tools: Bash\n---\nRead $ARGUMENTS', { tools: ['read_file', 'shell'], disallowedTools: ['shell'] })
    file('delve', '---\ndescription: x\ncontext: fork\nallowed-tools: Read\ndisallowed-tools: Agent, Write\n---\nDig $ARGUMENTS', { context: 'fork', disallowedTools: ['task', 'write_file'] })

    const nosh = await prepare(chatBody(newChatId(), '/nosh x'))
    expect(nosh.turnRestriction).toEqual([...registered.filter(name => name !== 'shell'), 'mcp__*'])
    const read = await prepare(chatBody(newChatId(), '/nosh-read x'))
    expect(read.userMessage?.metadata?.command?.allowedTools).toEqual(['read_file', 'shell'])
    expect(read.turnRestriction).toEqual(['read_file'])
    const delve = await prepare(chatBody(newChatId(), '/delve the cache'))
    expect(delve.userMessage?.metadata?.command?.allowedTools).toEqual(['read_file', 'task'])
    expect(delve.turnRestriction).toEqual(['read_file', 'task'])
    expect(delve.userMessage?.metadata?.command?.expansion).toContain('call the task tool once with type "general"')
    // No key: exactly the Phase 10 restriction.
    expect((await prepare(chatBody(newChatId(), '/quiet x'))).turnRestriction).toBeNull()
    expect((await prepare(chatBody(newChatId(), '/safe x'))).turnRestriction).toEqual(['read_file', 'shell'])
  })

  it('withAliasNotice adds the notice once and only for an unresolved Claude model name', () => {
    const model = { target: { kind: 'chat' }, imageOptions: undefined, notices: [] } as never
    const unresolved = { kind: 'prompt', invocation: { name: 'x', input: '', type: 'prompt', expansion: 'x' }, modelUnavailable: 'opus' } as const
    expect(withAliasNotice(model, unresolved).notices).toEqual([NOTICES.commandModelUnavailable('opus')])
    expect(withAliasNotice(withAliasNotice(model, unresolved), unresolved).notices).toHaveLength(1)
    expect(withAliasNotice(model, { ...unresolved, invocation: { ...unresolved.invocation, modelRef: 'mock:echo' } }).notices).toEqual([])
    expect(withAliasNotice(model, null).notices).toEqual([])
  })
})
