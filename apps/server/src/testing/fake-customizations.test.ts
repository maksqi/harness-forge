// The fake customization service (Phase 10, C30-T8) follows the `CustomizationService` contract where callers can see
// it: the merged catalog with the shared precedence, bodies through the shared parser, personal CRUD in memory with
// the 400 / 409 answers, backups, events and counters.
import type { CustomizationEntry } from '@harness-forge/shared'
import { customizationListSchema, customizationSchema, HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from './fake-customizations.ts'
import { createRecordingEventBus } from './fakes.ts'

const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
const AGENT = '---\nname: reviewer\ndescription: Reviews diffs.\ntools: Read, Grep\n---\nReview the diff carefully.'

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('createFakeCustomizationService: the catalog', () => {
  it('merges builtins, global, personal and project entries with the precedence; project entries only in their project', async () => {
    const plugin = fakeCatalogEntry('agent', 'reviewer', { source: 'plugin', path: undefined, pluginId: 'acme' })
    const project = fakeCatalogEntry('agent', 'reviewer')
    const fake = createFakeCustomizationService({ entries: { '': [plugin], [PROJECT]: [project, fakeCatalogEntry('skill', 'notes')] } })
    const global = await fake.catalog(null)
    expect(global.agents().map(entry => [entry.name, entry.source])).toEqual([['explore', 'builtin'], ['general', 'builtin'], ['reviewer', 'plugin']])
    expect(global.skills()).toEqual([])
    const scoped = await fake.catalog(PROJECT)
    expect(scoped.agent('reviewer')).toMatchObject({ source: 'project', state: 'active', path: '.harness/agents/reviewer.md' })
    expect(scoped.entries.filter(entry => entry.name === 'reviewer').map(entry => [entry.source, entry.state, entry.shadowedBy?.source])).toEqual([
      ['project', 'active', undefined],
      ['plugin', 'shadowed', 'project'],
    ])
    expect(scoped.skill('notes')?.path).toBe('.harness/skills/notes/SKILL.md')
    expect(scoped.project).toMatchObject({ id: PROJECT, available: true })
    const list = await fake.list({ projectId: PROJECT, kind: 'skill' })
    expect(customizationListSchema.parse(list)).toEqual(list)
    expect(list.items.map(entry => entry.name)).toEqual(['notes'])
    expect((await createFakeCustomizationService({ builtins: false }).catalog(null)).entries).toEqual([])
    expect(fake.calls).toMatchObject({ catalog: 2, list: 1 })
  })

  it('load parses a body through the shared parser; a missing body, a changed name or an invalid body is refused', async () => {
    const entry = fakeCatalogEntry('agent', 'reviewer')
    const fake = createFakeCustomizationService({ entries: { [PROJECT]: [entry] }, bodies: { [catalogEntryKey(entry)]: AGENT } })
    const loaded = await fake.load(entry)
    expect(loaded.definition).toEqual({ kind: 'agent', fields: { name: 'reviewer', description: 'Reviews diffs.', tools: ['read_file', 'search_files'], model: null, instructions: 'Review the diff carefully.' } })
    expect((await fake.load((await fake.catalog(null)).agent('explore')!)).definition.kind).toBe('agent')

    fake.bodies.set(catalogEntryKey(entry), AGENT.replace('name: reviewer', 'name: other'))
    expect((await rejection(fake.load(entry))).code).toBe('not_found')
    // An agent without a description is an `error` diagnostic: a 400 with the diagnostics.
    fake.bodies.set(catalogEntryKey(entry), '---\nname: reviewer\n---\nReview.')
    const invalid = await rejection(fake.load(entry))
    expect(invalid.code).toBe('validation_error')
    expect((invalid.details as { diagnostics: Array<{ code: string }> }).diagnostics.map(item => item.code)).toContain('missing-field')
    // A plugin entry without a body is gone.
    expect((await rejection(fake.load(fakeCatalogEntry('agent', 'reviewer', { path: undefined, source: 'plugin', pluginId: 'acme' })))).code).toBe('not_found')
    fake.bodies.set(catalogEntryKey(entry), { kind: 'agent', fields: { name: 'reviewer', description: 'Parsed.', tools: null, model: 'inherit', instructions: 'Go.' } })
    expect((await fake.load(entry)).definition.fields.description).toBe('Parsed.')
    fake.bodies.delete(catalogEntryKey(entry))
    expect((await rejection(fake.load(entry))).code).toBe('not_found')
  })

  it('source answers bodies of project, plugin and builtin entries; personal ones are a 400', async () => {
    const entry = fakeCatalogEntry('command', 'review')
    const fake = createFakeCustomizationService({ entries: { [PROJECT]: [entry] }, bodies: { [catalogEntryKey(entry)]: '---\ndescription: Review.\n---\nReview $ARGUMENTS' } })
    expect(await fake.source({ projectId: PROJECT, kind: 'command', name: 'review', source: 'project' })).toEqual({ content: '---\ndescription: Review.\n---\nReview $ARGUMENTS', path: '.harness/commands/review.md' })
    expect((await fake.source({ kind: 'agent', name: 'explore', source: 'builtin' })).content).toMatch(/^---\nname: explore\n/)
    expect((await rejection(fake.source({ kind: 'agent', name: 'x', source: 'user' }))).code).toBe('validation_error')
    expect((await rejection(fake.source({ kind: 'command', name: 'review', source: 'project' }))).code).toBe('validation_error')
    expect((await rejection(fake.source({ projectId: PROJECT, kind: 'command', name: 'missing', source: 'project' }))).code).toBe('not_found')
  })
})

describe('createFakeCustomizationService: personal definitions', () => {
  it('create / get / update / remove in memory, with events; the entries join every catalog (off when disabled)', async () => {
    const events = createRecordingEventBus()
    const fake = createFakeCustomizationService({ events, now: () => 5 })
    const created = await fake.create({ kind: 'agent', content: AGENT })
    expect(customizationSchema.parse(created)).toEqual(created)
    expect(created).toMatchObject({ kind: 'agent', name: 'reviewer', description: 'Reviews diffs.', enabled: true, createdAt: 5, fields: { tools: ['read_file', 'search_files'] } })
    expect(await fake.get(created.id)).toEqual(created)
    const catalog = await fake.catalog(PROJECT)
    expect(catalog.agent('reviewer')).toMatchObject({ source: 'user', id: created.id, state: 'active' })
    expect((await fake.load(catalog.agent('reviewer')!)).definition.kind).toBe('agent')

    const off = await fake.update(created.id, { enabled: false })
    expect(off.enabled).toBe(false)
    expect((await fake.catalog(null)).entries.find((entry: CustomizationEntry) => entry.name === 'reviewer')?.state).toBe('off')
    expect((await fake.catalog(null)).agent('reviewer')).toBeNull()
    const renamed = await fake.update(created.id, { content: AGENT.replace('name: reviewer', 'name: critic') })
    expect(renamed).toMatchObject({ name: 'critic', enabled: false })
    await fake.remove(created.id)
    expect((await rejection(fake.get(created.id))).code).toBe('not_found')
    expect((await rejection(fake.remove(created.id))).code).toBe('not_found')
    expect(events.ofType('customization.changed').map(event => event.data)).toEqual([
      { kind: 'agent', id: created.id },
      { kind: 'agent', id: created.id },
      { kind: 'agent', id: created.id },
      { kind: 'agent', id: created.id },
    ])
  })

  it('refuses invalid content (400 with diagnostics), reserved names, a taken (kind, name) and the per-kind limit', async () => {
    const fake = createFakeCustomizationService()
    const invalid = await rejection(fake.create({ kind: 'agent', content: '---\ndescription: No name.\n---\nBody' }))
    expect(invalid.code).toBe('validation_error')
    expect((invalid.details as { diagnostics: Array<{ code: string }> }).diagnostics.map(entry => entry.code)).toContain('missing-field')
    const reserved = await rejection(fake.create({ kind: 'agent', content: '---\nname: explore\ndescription: Mine.\n---\nBody' }))
    expect((reserved.details as { diagnostics: Array<{ code: string }> }).diagnostics.map(entry => entry.code)).toContain('reserved-name')
    await fake.create({ kind: 'agent', content: AGENT })
    const taken = await rejection(fake.create({ kind: 'agent', content: AGENT }))
    expect(taken).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // The same name of another kind is fine.
    await fake.create({ kind: 'skill', content: '---\nname: reviewer\ndescription: A skill.\n---\nSteps.' })
    for (let index = 0; index < LIMITS.customizationsPerKindMax; index++)
      await fake.create({ kind: 'command', content: `---\nname: c${index}\ndescription: Command ${index}.\n---\nDo ${index}.` })
    expect([...fake.personal.values()].filter(row => row.kind === 'command')).toHaveLength(LIMITS.customizationsPerKindMax)
    expect((await rejection(fake.create({ kind: 'command', content: '---\nname: last\ndescription: One too many.\n---\nNo.' }))).code).toBe('conflict')
  })

  it('exportBackup lists every personal definition; restoreBackup creates, skips existing names and counts failures', async () => {
    const fake = createFakeCustomizationService()
    await fake.create({ kind: 'skill', content: '---\nname: notes\ndescription: Notes.\n---\nWrite notes.', enabled: false })
    await fake.create({ kind: 'agent', content: AGENT })
    const backup = await fake.exportBackup()
    expect(backup.items.map(item => [item.kind, item.name, item.enabled])).toEqual([['agent', 'reviewer', true], ['skill', 'notes', false]])

    const target = createFakeCustomizationService()
    await target.create({ kind: 'agent', content: AGENT })
    const result = await target.restoreBackup([...backup.items, { kind: 'command', name: 'broken', content: '---\ndescription: [x\n---\n', enabled: true }])
    expect(result).toMatchObject({ imported: 1, skipped: 1, failed: 1 })
    expect(result.warnings).toEqual(['The personal command "broken" was not restored.'])
    expect((await target.exportBackup()).items.map(item => item.name)).toEqual(['reviewer', 'notes'])
    target.invalidate(PROJECT)
    target.invalidate(null)
    target.stop()
    expect(target.invalidated).toEqual([PROJECT, null])
    expect(target.calls.stop).toBe(1)
  })
})
