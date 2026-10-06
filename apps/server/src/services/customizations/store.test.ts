// The personal definitions (W10.1-T3) through the real service over the in-memory test database: create (parsed, the
// denormalized columns, `cus_` ids), a duplicate (409 `exists`), invalid content and reserved names (400 with the
// diagnostics), update (content, a rename, a rename onto a taken name), toggle (`off` in the catalog), delete, the
// per-kind cap, `load` of a personal entry, and the backup members (export order, restore: imported / skipped /
// failed). Phase 11 (W11.6-T3): personal output styles (slug names and labels, reserved builtin names, the per-kind
// cap, backups) and personal commands with `!` spans restored turned off (open point 9).
import type { BackupCustomization } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { customizationSchema, HarnessError, LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { customizations } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { runsShellSpans } from './store.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function open(): Promise<TestApp> {
  const t = await createTestApp({ builtins: [] })
  cleanups.push(() => t.close())
  return t
}

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

const AGENT = '---\nname: reviewer\ndescription: Reviews diffs.\ntools: Read, Grep\n---\nReview the diff carefully.\n'

describe('personal definitions', () => {
  it('create parses the content, stores the raw markdown and the denormalized columns; get answers the same', async () => {
    const t = await open()
    const created = await t.deps.customizations.create({ kind: 'agent', content: AGENT })
    expect(customizationSchema.safeParse(created).success).toBe(true)
    expect(created).toMatchObject({
      kind: 'agent',
      name: 'reviewer',
      description: 'Reviews diffs.',
      content: AGENT,
      enabled: true,
      diagnostics: [],
      fields: { name: 'reviewer', tools: ['read_file', 'search_files'], model: null, instructions: 'Review the diff carefully.' },
    })
    expect(created.id).toMatch(/^cus_[\dA-Za-z]{16}$/)
    const [row] = await t.db.select().from(customizations).where(eq(customizations.id, created.id))
    expect(row).toMatchObject({ kind: 'agent', name: 'reviewer', description: 'Reviews diffs.', content: AGENT, enabled: true })
    expect(await t.deps.customizations.get(created.id)).toEqual(created)
    await expect(t.deps.customizations.get('cus_ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses invalid content and reserved names (400 with the diagnostics) and a taken kind and name (409 exists)', async () => {
    const t = await open()
    const invalid = await rejection(t.deps.customizations.create({ kind: 'agent', content: '---\ndescription: No name.\n---\nBody' }))
    expect(invalid.code).toBe('validation_error')
    expect(invalid.message).toBe('Add a name.')
    expect(invalid.details).toMatchObject({ diagnostics: [{ level: 'error', code: 'missing-field' }], issues: [{ path: ['content'], message: 'Add a name.', code: 'custom' }] })
    for (const [kind, content] of [
      ['agent', '---\nname: explore\ndescription: Mine.\n---\nBody'],
      ['agent', '---\nname: general-purpose\ndescription: Mine.\n---\nBody'],
      ['command', '---\nname: compact\ndescription: Mine.\n---\nBody'],
      ['command', '---\nname: remember\ndescription: Mine.\n---\nBody'],
    ] as const) {
      const reserved = await rejection(t.deps.customizations.create({ kind, content }))
      expect(reserved.code, content).toBe('validation_error')
      expect((reserved.details as { diagnostics: Array<{ code: string }> }).diagnostics.map(item => item.code)).toContain('reserved-name')
    }
    await t.deps.customizations.create({ kind: 'agent', content: AGENT })
    const taken = await rejection(t.deps.customizations.create({ kind: 'agent', content: AGENT }))
    expect(taken).toMatchObject({ code: 'conflict', message: 'A personal agent named "reviewer" already exists.', details: { reason: 'exists' } })
    // The same name of another kind is fine.
    await t.deps.customizations.create({ kind: 'skill', content: '---\nname: reviewer\ndescription: A skill.\n---\nSteps.' })
    // Two creates at once: one wins, the other is the 409.
    const both = await Promise.allSettled([
      t.deps.customizations.create({ kind: 'command', content: '---\nname: twin\ndescription: One.\n---\nOne.' }),
      t.deps.customizations.create({ kind: 'command', content: '---\nname: twin\ndescription: Two.\n---\nTwo.' }),
    ])
    expect(both.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('update re-parses content (a rename; 409 onto a taken name), toggles enabled, keeps the kind; delete is final', async () => {
    const t = await open()
    const first = await t.deps.customizations.create({ kind: 'command', content: '---\nname: one\ndescription: First.\n---\nDo one.' })
    const second = await t.deps.customizations.create({ kind: 'command', content: '---\nname: two\ndescription: Second.\n---\nDo two.' })
    const renamed = await t.deps.customizations.update(first.id, { content: '---\nname: uno\ndescription: Primero.\nargument-hint: <x>\n---\nHaz $1.' })
    expect(renamed).toMatchObject({ id: first.id, kind: 'command', name: 'uno', description: 'Primero.', fields: { argumentHint: '<x>', body: 'Haz $1.' } })
    expect(renamed.updatedAt).toBeGreaterThan(first.updatedAt)
    const taken = await rejection(t.deps.customizations.update(second.id, { content: '---\nname: uno\ndescription: Clash.\n---\nNo.' }))
    expect(taken).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await t.deps.customizations.get(second.id)).name).toBe('two')
    const invalid = await rejection(t.deps.customizations.update(second.id, { content: '---\nname: two\n---\n' }))
    expect(invalid.code).toBe('validation_error')

    const off = await t.deps.customizations.update(second.id, { enabled: false })
    expect(off).toMatchObject({ enabled: false, name: 'two', content: second.content })
    const catalog = await t.deps.customizations.catalog(null)
    expect(catalog.entries.filter(entry => entry.source === 'user').map(entry => [entry.name, entry.state, entry.enabled, entry.id])).toEqual([
      ['two', 'off', false, second.id],
      ['uno', 'active', true, first.id],
    ])
    expect(catalog.command('two')).toBeNull()
    expect(catalog.command('uno')).toMatchObject({ source: 'user', argumentHint: '<x>' })

    await t.deps.customizations.remove(first.id)
    await expect(t.deps.customizations.get(first.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.customizations.remove(first.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.customizations.update(first.id, { enabled: true })).rejects.toMatchObject({ code: 'not_found' })
    expect((await t.deps.customizations.catalog(null)).command('uno')).toBeNull()
  })

  it('allows at most 200 definitions per kind (409)', async () => {
    const t = await open()
    const at = Date.now()
    await t.db.insert(customizations).values(Array.from({ length: LIMITS.customizationsPerKindMax }, (_, index) => ({
      id: `cus_${String(index).padStart(16, '0')}`,
      kind: 'skill' as const,
      name: `s${index}`,
      description: `Skill ${index}.`,
      content: `---\nname: s${index}\ndescription: Skill ${index}.\n---\nSteps.`,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })))
    const full = await rejection(t.deps.customizations.create({ kind: 'skill', content: '---\nname: last\ndescription: One too many.\n---\nNo.' }))
    expect(full).toMatchObject({ code: 'conflict', message: 'At most 200 personal skills can be stored; delete one first.', details: { reason: 'exists' } })
    // Another kind is not full.
    await t.deps.customizations.create({ kind: 'agent', content: AGENT })
    expect((await t.deps.customizations.catalog(null)).skills()).toHaveLength(LIMITS.customizationsPerKindMax)
  })

  it('load gives the body of an enabled personal entry; a turned-off or removed one is not_found', async () => {
    const t = await open()
    const created = await t.deps.customizations.create({ kind: 'agent', content: AGENT })
    const entry = (await t.deps.customizations.catalog(null)).agent('reviewer')!
    expect(entry).toMatchObject({ source: 'user', id: created.id, tools: ['read_file', 'search_files'] })
    const loaded = await t.deps.customizations.load(entry)
    expect(loaded.definition).toEqual({ kind: 'agent', fields: { name: 'reviewer', description: 'Reviews diffs.', tools: ['read_file', 'search_files'], model: null, instructions: 'Review the diff carefully.' } })
    await t.deps.customizations.update(created.id, { enabled: false })
    await expect(t.deps.customizations.load(entry)).rejects.toMatchObject({ code: 'not_found' })
    await t.deps.customizations.remove(created.id)
    await expect(t.deps.customizations.load(entry)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('backups', () => {
  it('exportBackup lists every row by kind and name; restoreBackup imports, keeps existing names and fails bad items', async () => {
    const source = await open()
    await source.deps.customizations.create({ kind: 'skill', content: '---\nname: notes\ndescription: Notes.\n---\nWrite notes.', enabled: false })
    await source.deps.customizations.create({ kind: 'command', content: '---\nname: zeta\ndescription: Z.\n---\nZ.' })
    await source.deps.customizations.create({ kind: 'command', content: '---\nname: alpha\ndescription: A.\n---\nA.' })
    await source.deps.customizations.create({ kind: 'agent', content: AGENT })
    const backup = await source.deps.customizations.exportBackup()
    expect(backup.items.map(item => [item.kind, item.name, item.enabled])).toEqual([
      ['agent', 'reviewer', true],
      ['command', 'alpha', true],
      ['command', 'zeta', true],
      ['skill', 'notes', false],
    ])
    expect(backup.items[0]).toEqual({ kind: 'agent', name: 'reviewer', content: AGENT, enabled: true })

    const target = await open()
    const existing = await target.deps.customizations.create({ kind: 'agent', content: '---\nname: reviewer\ndescription: Mine.\n---\nKeep me.' })
    const items: BackupCustomization[] = [
      ...backup.items,
      { kind: 'command', name: 'broken', content: '---\ndescription: [x\n---\n', enabled: true },
      { kind: 'agent', name: 'explore', content: '---\nname: explore\ndescription: Reserved.\n---\nNo.', enabled: true },
    ]
    const result = await target.deps.customizations.restoreBackup(items)
    expect(result).toMatchObject({ imported: 3, skipped: 1, failed: 2 })
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toMatch(/^The personal command "broken" was not restored: /)
    expect(result.warnings[1]).toBe('The personal agent "explore" was not restored: Line 2: explore is a built-in name.')
    for (const warning of result.warnings)
      expect(warning.length).toBeLessThanOrEqual(300)
    // The existing entry with the same kind and name is kept.
    expect(await target.deps.customizations.get(existing.id)).toMatchObject({ content: existing.content })
    const restored = await target.deps.customizations.exportBackup()
    expect(restored.items.map(item => [item.kind, item.name, item.enabled])).toEqual([
      ['agent', 'reviewer', true],
      ['command', 'alpha', true],
      ['command', 'zeta', true],
      ['skill', 'notes', false],
    ])
    // A second restore skips everything.
    expect(await target.deps.customizations.restoreBackup(backup.items)).toMatchObject({ imported: 0, skipped: 4, failed: 0, warnings: [] })
  })

  it('restoreBackup fails the items beyond the per-kind limit', async () => {
    const t = await open()
    const at = Date.now()
    await t.db.insert(customizations).values(Array.from({ length: LIMITS.customizationsPerKindMax - 1 }, (_, index) => ({
      id: `cus_${String(index).padStart(16, '0')}`,
      kind: 'agent' as const,
      name: `a${index}`,
      description: 'An agent.',
      content: `---\nname: a${index}\ndescription: An agent.\n---\nBody.`,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })))
    const result = await t.deps.customizations.restoreBackup([
      { kind: 'agent', name: 'fits', content: '---\nname: fits\ndescription: Fits.\n---\nBody.', enabled: true },
      { kind: 'agent', name: 'over', content: '---\nname: over\ndescription: Over.\n---\nBody.', enabled: true },
    ])
    expect(result).toEqual({ imported: 1, skipped: 0, failed: 1, turnedOff: 0, warnings: ['The personal agent "over" was not restored: the limit of 200 personal agents is reached.'] })
  })
})

describe('output styles and commands with spans (Phase 11)', () => {
  const TERSE = '---\nname: Terse Replies\ndescription: Short answers.\nkeep-coding-instructions: true\n---\nAnswer in three lines at most.\n'

  it('stores personal styles by their slug with the label; refuses builtin names and taken names; the cap holds', async () => {
    const t = await open()
    const created = await t.deps.customizations.create({ kind: 'style', content: TERSE })
    expect(customizationSchema.safeParse(created).success).toBe(true)
    expect(created).toMatchObject({
      kind: 'style',
      name: 'terse-replies',
      description: 'Short answers.',
      enabled: true,
      fields: { name: 'terse-replies', label: 'Terse Replies', keepCodingInstructions: true, content: 'Answer in three lines at most.' },
    })
    const [row] = await t.db.select().from(customizations).where(eq(customizations.id, created.id))
    expect(row).toMatchObject({ kind: 'style', name: 'terse-replies', content: TERSE })
    const entry = (await t.deps.customizations.catalog(null)).style('terse-replies')
    expect(entry).toMatchObject({ source: 'user', id: created.id, label: 'Terse Replies', keepCodingInstructions: true, state: 'active' })

    const reserved = await rejection(t.deps.customizations.create({ kind: 'style', content: '---\nname: Explanatory\ndescription: Mine.\n---\nNo.' }))
    expect(reserved.code).toBe('validation_error')
    expect((reserved.details as { diagnostics: Array<{ code: string }> }).diagnostics.map(item => item.code)).toContain('reserved-name')
    const taken = await rejection(t.deps.customizations.create({ kind: 'style', content: TERSE.replace('Short answers.', 'Again.') }))
    expect(taken).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // The same name in another kind is fine.
    expect(await t.deps.customizations.create({ kind: 'skill', content: '---\nname: terse-replies\ndescription: A skill.\n---\nBody.' })).toMatchObject({ kind: 'skill' })

    const at = Date.now()
    await t.db.insert(customizations).values(Array.from({ length: LIMITS.customizationsPerKindMax - 1 }, (_, index) => ({
      id: `cus_${String(index).padStart(16, '0')}`,
      kind: 'style' as const,
      name: `s${index}`,
      description: 'A style.',
      content: `---\nname: s${index}\ndescription: A style.\n---\nBody.`,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })))
    const full = await rejection(t.deps.customizations.create({ kind: 'style', content: '---\nname: one-more\ndescription: Over.\n---\nBody.' }))
    expect(full).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(full.message).toBe('At most 200 personal styles can be stored; delete one first.')
  })

  it('backs personal styles up and restores them; a restored command with !`…` spans comes back turned off', async () => {
    const source = await open()
    await source.deps.customizations.create({ kind: 'style', content: TERSE, enabled: false })
    await source.deps.customizations.create({ kind: 'command', content: '---\nname: status\ndescription: Status.\n---\nStatus: !`git status --short`\n' })
    await source.deps.customizations.create({ kind: 'command', content: '---\nname: plain\ndescription: Plain.\n---\nSay $ARGUMENTS.\n' })
    const backup = await source.deps.customizations.exportBackup()
    expect(backup.items.map(item => [item.kind, item.name, item.enabled])).toEqual([
      ['command', 'plain', true],
      ['command', 'status', true],
      ['style', 'terse-replies', false],
    ])

    const target = await open()
    const fenced = '---\nname: fenced\ndescription: Fenced.\n---\nExample:\n\n```\n!`rm -rf /`\n```\n'
    const items: BackupCustomization[] = [
      ...backup.items,
      { kind: 'command', name: 'already-off', content: '---\nname: already-off\ndescription: Off.\n---\nRun !`ls`', enabled: false },
      { kind: 'command', name: 'fenced', content: fenced, enabled: true },
      { kind: 'style', name: 'default', content: '---\nname: default\ndescription: Reserved.\n---\nNo.', enabled: true },
    ]
    const result = await target.deps.customizations.restoreBackup(items)
    expect(result).toMatchObject({ imported: 5, skipped: 0, failed: 1 })
    expect(result.warnings).toEqual(['The personal style "default" was not restored: Line 2: default is a built-in name.'])
    const restored = await target.deps.customizations.exportBackup()
    expect(restored.items.map(item => [item.kind, item.name, item.enabled])).toEqual([
      ['command', 'already-off', false],
      // Spans only inside a fenced block are text: the command stays on.
      ['command', 'fenced', true],
      ['command', 'plain', true],
      ['command', 'status', false],
      ['style', 'terse-replies', false],
    ])
    const catalog = await target.deps.customizations.catalog(null)
    expect(catalog.command('status')).toBeNull()
    expect(catalog.entries.find(entry => entry.kind === 'command' && entry.name === 'status')).toMatchObject({ state: 'off', enabled: false })
    expect(catalog.style('terse-replies')).toBeNull()
    expect(target.logs.text()).toMatch(/customizations restored/)
  })

  it('runsShellSpans: only commands whose body holds a span outside fences', () => {
    const command = (body: string) => ({ kind: 'command' as const, fields: { name: 'x', description: 'X.', argumentHint: null, model: null, allowedTools: null, body } })
    expect(runsShellSpans(command('Run !`git status`'))).toBe(true)
    expect(runsShellSpans(command('Plain $ARGUMENTS and @README.md'))).toBe(false)
    expect(runsShellSpans(command('```\n!`ls`\n```'))).toBe(false)
    expect(runsShellSpans(command('Empty !` ` span'))).toBe(false)
    expect(runsShellSpans({ kind: 'skill', fields: { name: 'x', description: 'X.', content: 'Run !`ls`' } })).toBe(false)
  })
})
