// `importDefinitions` (W12.7-T2; ADR-055) through the real service over the in-memory test database: one pass in the
// write queue, create / overwrite (keeps `enabled`) / rename (`setDefinitionName`, a missing `name:` inserted), span
// commands turned off unless enabled, builtin / reserved names, invalid content, taken names and the per-kind cap fail
// the item (never a throw), and exactly ONE `customization.changed {}` for N items. `restoreBackup` reports `turnedOff`.
import type { ServerEvent } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { CustomizationImportItem } from './types.ts'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { importedEnabled, importFailure, prepareImportItem } from './import.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function open(): Promise<{ t: TestApp, events: ServerEvent[] }> {
  const t = await createTestApp({ builtins: [] })
  cleanups.push(() => t.close())
  const events: ServerEvent[] = []
  const subscription = t.deps.events.subscribe(event => events.push(event))
  cleanups.push(async () => subscription.dispose())
  return { t, events }
}

const REVIEWER = '---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\nmodel: sonnet\ncolor: green\n---\nReview the code.\n'
const DEPLOY = '---\nname: deploy\ndescription: Deploy.\n---\nStatus: !`git status --short`\nDeploy $ARGUMENTS.\n'
const NOTE = '---\nname: note\ndescription: Note.\n---\nWrite a note about $ARGUMENTS.\n'
/** A command without `name:` (the planner inserts it for a rename; a create needs it). */
const NAMELESS = '---\ndescription: Component.\n---\nCreate a component named $1.\n'

function changed(events: readonly ServerEvent[]): ServerEvent[] {
  return events.filter(event => event.type === 'customization.changed')
}

describe('importDefinitions (W12.7-T2)', () => {
  it('n items in one pass: created, a span command off, failures per item, exactly one customization.changed {}', async () => {
    const { t, events } = await open()
    const items: CustomizationImportItem[] = [
      { kind: 'agent', content: REVIEWER, action: 'create' },
      { kind: 'command', content: DEPLOY, action: 'create' },
      { kind: 'command', content: NOTE, action: 'create' },
      { kind: 'command', content: NAMELESS, action: 'create' },
      { kind: 'agent', content: '---\nname: explore\ndescription: Mine.\n---\nx', action: 'create' },
      { kind: 'command', content: '---\nname: compact\ndescription: Mine.\n---\nx', action: 'create' },
    ]
    const results = await t.deps.customizations.importDefinitions(items)
    expect(results.map(result => (result.ok ? result.outcome : 'failed'))).toEqual(['created', 'created', 'created', 'failed', 'failed', 'failed'])
    const created = results.flatMap(result => (result.ok ? [result.customization] : []))
    expect(created.map(row => [row.kind, row.name, row.enabled])).toEqual([['agent', 'reviewer', true], ['command', 'deploy', false], ['command', 'note', true]])
    expect(created[0]!.content).toBe(REVIEWER)
    expect(results[3]).toEqual({ ok: false, message: 'The personal command was not imported: Add a name.' })
    expect(results[4]).toEqual({ ok: false, message: 'The personal agent was not imported: Line 2: explore is a built-in name.' })
    expect(changed(events)).toEqual([expect.objectContaining({ type: 'customization.changed', data: {} })])
    // The catalog lists them at once (the cache was dropped).
    const catalog = await t.deps.customizations.catalog(null)
    expect(catalog.agent('reviewer')).toMatchObject({ source: 'user', color: 'green', modelAlias: 'sonnet' })
    expect(catalog.entries.find(entry => entry.name === 'deploy')?.state).toBe('off')
  })

  it('a span command is on when the item enables it; overwrite keeps enabled (a span overwrite turns it off without enable)', async () => {
    const { t, events } = await open()
    const enabled = await t.deps.customizations.importDefinitions([{ kind: 'command', content: DEPLOY, action: 'create', enable: true }])
    expect(enabled[0]).toMatchObject({ ok: true, outcome: 'created', customization: { name: 'deploy', enabled: true } })
    const note = await t.deps.customizations.create({ kind: 'command', content: NOTE })
    await t.deps.customizations.update(note.id, { enabled: false })
    events.length = 0
    const overwritten = await t.deps.customizations.importDefinitions([
      { kind: 'command', content: NOTE.replace('Write a note', 'Write a short note'), action: 'overwrite' },
      { kind: 'command', content: DEPLOY.replace('Deploy $ARGUMENTS', 'Ship $ARGUMENTS'), action: 'overwrite' },
      { kind: 'command', content: DEPLOY.replace('deploy', 'release'), action: 'overwrite', enable: true },
    ])
    expect(overwritten.map(result => (result.ok ? [result.outcome, result.customization.name, result.customization.enabled] : result.message))).toEqual([
      ['updated', 'note', false],
      ['updated', 'deploy', false],
      ['created', 'release', true],
    ])
    expect((await t.deps.customizations.get(note.id)).content).toContain('Write a short note')
    expect(changed(events)).toHaveLength(1)
  })

  it('rename creates under the new name (name: inserted or replaced, every other line kept); a taken name fails', async () => {
    const { t } = await open()
    await t.deps.customizations.create({ kind: 'command', content: NOTE })
    const results = await t.deps.customizations.importDefinitions([
      { kind: 'command', content: NOTE, action: 'rename', renameTo: 'note-2' },
      { kind: 'command', content: NAMELESS, action: 'rename', renameTo: 'component' },
      { kind: 'command', content: NOTE, action: 'create' },
      { kind: 'command', content: NOTE, action: 'rename', renameTo: 'note-2' },
      { kind: 'command', content: NOTE, action: 'rename', renameTo: 'Bad Name' },
      { kind: 'command', content: NOTE, action: 'rename' },
    ])
    expect(results[0]).toMatchObject({ ok: true, outcome: 'created', customization: { name: 'note-2' } })
    expect(results[0]!.ok ? results[0]!.customization.content : '').toBe(NOTE.replace('name: note', 'name: note-2'))
    expect(results[1]).toMatchObject({ ok: true, customization: { name: 'component', description: 'Component.' } })
    expect(results.slice(2).map(result => (result.ok ? 'ok' : result.message))).toEqual([
      'The personal command "note" was not imported: a personal command with this name already exists.',
      'The personal command "note-2" was not imported: a personal command with this name already exists.',
      'The personal command was not imported: the new name is not valid.',
      'The personal command was not imported: the new name is not valid.',
    ])
  })

  it('the per-kind cap fails the items beyond it; nothing changed = no event; never a throw for bad items', async () => {
    const { t, events } = await open()
    const items: CustomizationImportItem[] = Array.from({ length: LIMITS.customizationsPerKindMax + 2 }, (_, index) => ({
      kind: 'skill',
      content: `---\nname: skill-${index}\ndescription: Skill ${index}.\n---\nBody ${index}.`,
      action: 'create',
    }))
    const results = await t.deps.customizations.importDefinitions(items)
    expect(results.filter(result => result.ok)).toHaveLength(LIMITS.customizationsPerKindMax)
    expect(results.at(-1)).toEqual({ ok: false, message: `The personal skill "skill-${LIMITS.customizationsPerKindMax + 1}" was not imported: the limit of ${LIMITS.customizationsPerKindMax} personal skills is reached.` })
    expect(changed(events)).toHaveLength(1)
    events.length = 0
    const bad = await t.deps.customizations.importDefinitions([
      { kind: 'nope' as never, content: 'x', action: 'create' },
      { kind: 'agent', content: 5 as never, action: 'create' },
    ])
    expect(bad.every(result => !result.ok)).toBe(true)
    expect(changed(events)).toHaveLength(0)
    expect(await t.deps.customizations.importDefinitions([])).toEqual([])
  })

  it('logs counts only, never a content or a name', async () => {
    const { t } = await open()
    await t.deps.customizations.importDefinitions([{ kind: 'command', content: DEPLOY, action: 'create' }])
    expect(t.logs.text()).toContain('customizations imported')
    expect(t.logs.text()).not.toContain('git status')
    expect(t.logs.text()).not.toContain('Deploy')
  })
})

describe('import helpers', () => {
  it('prepareImportItem, importedEnabled and importFailure', () => {
    expect(prepareImportItem({ kind: 'command', content: NAMELESS, action: 'rename', renameTo: 'comp' }).name).toBe('comp')
    expect(() => prepareImportItem({ kind: 'command', content: NAMELESS, action: 'create' })).toThrow('Add a name.')
    expect(importedEnabled({}, false, null)).toBe(true)
    expect(importedEnabled({}, true, null)).toBe(false)
    expect(importedEnabled({ enable: true }, true, null)).toBe(true)
    expect(importedEnabled({ enable: true }, true, false)).toBe(false)
    expect(importedEnabled({}, true, true)).toBe(false)
    expect(importedEnabled({}, false, true)).toBe(true)
    expect(importFailure('agent', 'a\u0000b', 'x.')).toBe('The personal agent "a?b" was not imported: x.')
    expect(importFailure('agent', 'x'.repeat(400), 'y').length).toBeLessThanOrEqual(300)
  })
})

describe('restoreBackup: turnedOff (W12.7-T2)', () => {
  it('counts the restored span commands that came back off', async () => {
    const { t } = await open()
    const result = await t.deps.customizations.restoreBackup([
      { kind: 'command', name: 'deploy', content: DEPLOY, enabled: true },
      { kind: 'command', name: 'note', content: NOTE, enabled: true },
      { kind: 'command', name: 'off', content: DEPLOY.replace('deploy', 'off'), enabled: false },
    ])
    expect(result).toMatchObject({ imported: 3, skipped: 0, failed: 0, turnedOff: 1 })
  })
})
