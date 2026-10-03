import { LIMITS, shellRuleSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { projects } from '../db/schema.ts'
import { createTestApp } from './create-test-app.ts'
import { createFakeShellRuleService } from './fake-shell-rules.ts'

const A = 'prj_AAAAAAAAAAAAAAAA'
const B = 'prj_BBBBBBBBBBBBBBBB'

describe('createFakeShellRuleService', () => {
  it('stores canonical prefixes; lists global first, then by project and prefix', async () => {
    const rules = createFakeShellRuleService(undefined, { now: () => 5 })
    const test = await rules.create({ projectId: A, prefix: 'pnpm   test' })
    expect(shellRuleSchema.parse(test)).toMatchObject({ projectId: A, prefix: 'pnpm test', createdAt: 5 })
    await rules.create({ projectId: null, prefix: 'ls' })
    await rules.create({ projectId: B, prefix: 'make' })
    await rules.create({ projectId: A, prefix: 'git status' })
    await rules.create({ projectId: null, prefix: 'cat' })
    expect((await rules.list()).map(rule => [rule.projectId, rule.prefix])).toEqual([
      [null, 'cat'],
      [null, 'ls'],
      [A, 'git status'],
      [A, 'pnpm test'],
      [B, 'make'],
    ])
  })

  it('forRun: the global rules, then the project\'s (deduplicated); empty for a null project', async () => {
    const rules = createFakeShellRuleService()
    await rules.create({ projectId: null, prefix: 'ls' })
    await rules.create({ projectId: A, prefix: 'pnpm test' })
    await rules.create({ projectId: A, prefix: 'ls' })
    await rules.create({ projectId: B, prefix: 'make' })
    const set = await rules.forRun(A)
    expect(set).toEqual({ projectId: A, prefixes: ['ls', 'pnpm test'] })
    expect(Object.isFrozen(set)).toBe(true)
    expect(Object.isFrozen(set.prefixes)).toBe(true)
    expect(await rules.forRun(B)).toEqual({ projectId: B, prefixes: ['ls', 'make'] })
    expect(await rules.forRun(null)).toEqual({ projectId: null, prefixes: [] })
    expect(rules.forRunCalls).toEqual([A, B, null])
  })

  it('refuses rules like the real service: the parser, duplicates, the cap, unknown ids', async () => {
    const rules = createFakeShellRuleService()
    await expect(rules.create({ projectId: null, prefix: 'bash -c' })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['prefix'] }] } })
    await expect(rules.create({ projectId: null, prefix: 'ls $HOME' })).rejects.toMatchObject({ code: 'validation_error' })
    const ls = await rules.create({ projectId: null, prefix: 'ls' })
    await expect(rules.create({ projectId: null, prefix: '\'ls\'' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // The same prefix in another scope is fine.
    await rules.create({ projectId: A, prefix: 'ls' })
    for (let index = 0; index < LIMITS.shellRulesPerScopeMax; index++)
      rules.rules.push({ id: `srl_cap${String(index).padStart(13, '0')}`, projectId: B, prefix: `tool${index}`, createdAt: 1 })
    await expect(rules.create({ projectId: B, prefix: 'make' })).rejects.toMatchObject({ code: 'validation_error' })
    await rules.remove(ls.id)
    await expect(rules.remove(ls.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('with deps: an unknown project is 404 and the rules of a deleted project disappear', async () => {
    const t = await createTestApp({ shellRules: 'fake', start: false })
    try {
      const rules = t.deps.shellRules
      await expect(rules.create({ projectId: A, prefix: 'ls' })).rejects.toMatchObject({ code: 'not_found' })
      await t.db.insert(projects).values({ id: A, name: 'Demo', path: '/srv/projects/demo', createdAt: 1, updatedAt: 1 })
      await rules.create({ projectId: A, prefix: 'ls' })
      await rules.create({ projectId: null, prefix: 'cat' })
      expect((await rules.forRun(A)).prefixes).toEqual(['cat', 'ls'])
      await t.db.delete(projects).where(eq(projects.id, A))
      expect((await rules.list()).map(rule => rule.prefix)).toEqual(['cat'])
      expect((await rules.forRun(A)).prefixes).toEqual(['cat'])
    }
    finally {
      await t.close()
    }
  })
})
