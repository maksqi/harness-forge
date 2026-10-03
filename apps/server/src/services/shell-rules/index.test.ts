// Shell rule service (W8.6, ADR-038, API.md 4.24 / 5.25): storage over `shell_rules`, the parser, duplicates, the cap
// per scope, `forRun`, the foreign key cascade of a project delete, the log levels and the backup isolation. Phase 9
// (W9.7): the unique indexes of migration `0006` are the authority on duplicates (a violation is `409 exists`).
import type { ShellRule } from '@harness-forge/shared'
import type { Db } from '../../db/client.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppDeps } from '../../types.ts'
import { HarnessError, harnessErrorEnvelopeSchema, LIMITS, parseShellRule, SHELL_RULE_ID_PATTERN, shellRuleSchema } from '@harness-forge/shared'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { projects, shellRules } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { compareShellRules, createShellRuleService, emptyShellRuleSet, isUniqueViolation, SHELL_RULE_EXISTS_MESSAGE, shellRuleSetOf, shellRulesFullMessage } from './index.ts'

const A = 'prj_AAAAAAAAAAAAAAAA'
const B = 'prj_BBBBBBBBBBBBBBBB'
const UNKNOWN = 'prj_ZZZZZZZZZZZZZZZZ'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function app(options: { start?: boolean } = {}): Promise<TestApp> {
  const t = await createTestApp({ start: options.start ?? false, builtins: [] })
  cleanups.push(() => t.close())
  return t
}

async function addProjects(t: TestApp, ...ids: string[]): Promise<void> {
  for (const [index, id] of ids.entries())
    await t.db.insert(projects).values({ id, name: `Project ${index}`, path: `/srv/projects/p${index}`, createdAt: 1, updatedAt: 1 })
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

/** Rows straight into the table (fills a scope up to the cap without going through `create`). */
async function fill(t: TestApp, projectId: string | null, n: number): Promise<void> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: `srl_F${String(index).padStart(9, '0')}${projectId === null ? 'GLOBAL' : projectId.slice(4, 10)}`,
    projectId,
    prefix: `tool${index}`,
    createdAt: 1,
  }))
  await t.db.insert(shellRules).values(rows)
}

function scopes(rules: ShellRule[]): Array<[string | null, string]> {
  return rules.map(rule => [rule.projectId, rule.prefix])
}

describe('shell rule service: create and list', () => {
  it('stores the canonical prefix with a new srl_ id and a timestamp', async () => {
    const t = await app()
    await addProjects(t, A)
    const before = Date.now()
    const rule = await t.deps.shellRules.create({ projectId: A, prefix: 'pnpm   \'test\'' })
    expect(shellRuleSchema.parse(rule)).toEqual({ id: expect.stringMatching(SHELL_RULE_ID_PATTERN), projectId: A, prefix: 'pnpm test', createdAt: expect.any(Number) })
    expect(rule.createdAt).toBeGreaterThanOrEqual(before)
    const quoted = await t.deps.shellRules.create({ projectId: null, prefix: 'git commit -m "x y"' })
    expect(quoted.prefix).toBe('git commit -m \'x y\'')
    const rows = await t.db.select().from(shellRules)
    expect(rows.map(row => [row.id, row.projectId, row.prefix])).toEqual(expect.arrayContaining([
      [rule.id, A, 'pnpm test'],
      [quoted.id, null, 'git commit -m \'x y\''],
    ]))
  })

  it('lists the global rules first, then by project id; each scope by prefix', async () => {
    const t = await app()
    await addProjects(t, B, A)
    for (const [projectId, prefix] of [[B, 'make'], [null, 'ls'], [A, 'pnpm test'], [A, 'git status'], [null, 'cat'], [B, 'cargo test']] as const)
      await t.deps.shellRules.create({ projectId, prefix })
    const list = await t.deps.shellRules.list()
    for (const rule of list)
      shellRuleSchema.parse(rule)
    expect(scopes(list)).toEqual([
      [null, 'cat'],
      [null, 'ls'],
      [A, 'git status'],
      [A, 'pnpm test'],
      [B, 'cargo test'],
      [B, 'make'],
    ])
    expect([...list].reverse().sort(compareShellRules)).toEqual(list)
  })

  it.each([
    ['empty', '   '],
    ['syntax', 'ls $HOME'],
    ['syntax', 'pnpm test && rm -rf x'],
    ['command-runner', 'bash -c'],
    ['command-runner', 'sudo'],
    ['shell-builtin', 'export'],
    ['interpreter', 'python3 -m'],
    ['cd', 'cd src'],
    ['too-long', `echo ${'x'.repeat(LIMITS.shellRulePrefixMaxChars)}`],
  ])('refuses a %s prefix (%j) with 400 on [prefix] and the parser message', async (reason, prefix) => {
    const t = await app()
    const parsed = parseShellRule(prefix)
    expect(parsed).toMatchObject({ ok: false, reason })
    const message = parsed.ok ? '' : parsed.message
    const error = await rejection(t.deps.shellRules.create({ projectId: null, prefix }))
    expect(error).toMatchObject({ code: 'validation_error', message, details: { issues: [{ path: ['prefix'], message }] } })
    expect(await t.deps.shellRules.list()).toEqual([])
  })

  it('answers 404 for an unknown project (before the duplicate and cap checks)', async () => {
    const t = await app()
    const error = await rejection(t.deps.shellRules.create({ projectId: UNKNOWN, prefix: 'ls' }))
    expect(error).toMatchObject({ code: 'not_found', message: `Project ${UNKNOWN} not found.` })
    // A refused prefix is reported first.
    expect(await rejection(t.deps.shellRules.create({ projectId: UNKNOWN, prefix: 'sh' }))).toMatchObject({ code: 'validation_error' })
  })

  it('refuses the same canonical prefix in the same scope (409 exists); another scope is fine', async () => {
    const t = await app()
    await addProjects(t, A, B)
    await t.deps.shellRules.create({ projectId: A, prefix: 'pnpm test' })
    const duplicate = await rejection(t.deps.shellRules.create({ projectId: A, prefix: '  pnpm  "test"  ' }))
    expect(duplicate).toMatchObject({ code: 'conflict', message: SHELL_RULE_EXISTS_MESSAGE, details: { reason: 'exists' } })
    await t.deps.shellRules.create({ projectId: B, prefix: 'pnpm test' })
    await t.deps.shellRules.create({ projectId: null, prefix: 'pnpm test' })
    expect(await rejection(t.deps.shellRules.create({ projectId: null, prefix: 'pnpm test' }))).toMatchObject({ code: 'conflict' })
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'pnpm test'], [A, 'pnpm test'], [B, 'pnpm test']])
  })

  it('caps every scope at LIMITS.shellRulesPerScopeMax rules (400); other scopes keep working', async () => {
    const t = await app()
    await addProjects(t, A, B)
    await fill(t, A, LIMITS.shellRulesPerScopeMax - 1)
    await t.deps.shellRules.create({ projectId: A, prefix: 'make' })
    const full = await rejection(t.deps.shellRules.create({ projectId: A, prefix: 'make test' }))
    expect(full).toMatchObject({ code: 'validation_error', message: shellRulesFullMessage(A), details: { issues: [{ path: ['prefix'] }] } })
    // A duplicate in a full scope is still a duplicate.
    expect(await rejection(t.deps.shellRules.create({ projectId: A, prefix: 'make' }))).toMatchObject({ code: 'conflict' })
    await t.deps.shellRules.create({ projectId: B, prefix: 'make test' })
    await fill(t, null, LIMITS.shellRulesPerScopeMax)
    expect(await rejection(t.deps.shellRules.create({ projectId: null, prefix: 'make test' }))).toMatchObject({ code: 'validation_error', message: shellRulesFullMessage(null) })
    expect(shellRulesFullMessage(null)).not.toBe(shellRulesFullMessage(A))
    // Removing one frees a place.
    const [first] = (await t.deps.shellRules.list()).filter(rule => rule.projectId === A)
    await t.deps.shellRules.remove(first!.id)
    await t.deps.shellRules.create({ projectId: A, prefix: 'make test' })
  })

  it('serializes concurrent creates: one of the same prefix wins, the cap is never exceeded', async () => {
    const t = await app()
    await addProjects(t, A)
    const same = await Promise.allSettled(Array.from({ length: 8 }, async () => t.deps.shellRules.create({ projectId: A, prefix: 'pnpm lint' })))
    expect(same.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of same.filter(result => result.status === 'rejected'))
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' })

    await fill(t, null, LIMITS.shellRulesPerScopeMax - 2)
    const near = await Promise.allSettled(Array.from({ length: 5 }, async (_, index) => t.deps.shellRules.create({ projectId: null, prefix: `extra${index}` })))
    expect(near.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect((await t.deps.shellRules.list()).filter(rule => rule.projectId === null)).toHaveLength(LIMITS.shellRulesPerScopeMax)
    // A failed create does not block the queue.
    await t.deps.shellRules.create({ projectId: A, prefix: 'pnpm test' })
  })
})

describe('shell rule service: remove', () => {
  it('removes a rule; an unknown id is 404', async () => {
    const t = await app()
    const rule = await t.deps.shellRules.create({ projectId: null, prefix: 'ls' })
    await t.deps.shellRules.create({ projectId: null, prefix: 'cat' })
    await t.deps.shellRules.remove(rule.id)
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'cat']])
    const missing = await rejection(t.deps.shellRules.remove(rule.id))
    expect(missing).toMatchObject({ code: 'not_found', message: `Shell rule ${rule.id} not found.` })
    // No edit: remove and add again.
    await t.deps.shellRules.create({ projectId: null, prefix: 'ls' })
  })
})

describe('shell rule service: forRun', () => {
  it('gives the global rules, then the project\'s, each by prefix, deduplicated and frozen', async () => {
    const t = await app()
    await addProjects(t, A, B)
    await t.deps.shellRules.create({ projectId: A, prefix: 'pnpm test' })
    await t.deps.shellRules.create({ projectId: null, prefix: 'ls' })
    await t.deps.shellRules.create({ projectId: A, prefix: 'git status' })
    await t.deps.shellRules.create({ projectId: A, prefix: 'ls' })
    await t.deps.shellRules.create({ projectId: null, prefix: 'cat' })
    await t.deps.shellRules.create({ projectId: B, prefix: 'make' })
    const setA = await t.deps.shellRules.forRun(A)
    expect(setA).toEqual({ projectId: A, prefixes: ['cat', 'ls', 'git status', 'pnpm test'] })
    expect(Object.isFrozen(setA)).toBe(true)
    expect(Object.isFrozen(setA.prefixes)).toBe(true)
    // A rule of project A is not in B's set; a global rule is in both.
    expect(await t.deps.shellRules.forRun(B)).toEqual({ projectId: B, prefixes: ['cat', 'ls', 'make'] })
    // An unknown project gets the global rules only (never an error).
    expect(await t.deps.shellRules.forRun(UNKNOWN)).toEqual({ projectId: UNKNOWN, prefixes: ['cat', 'ls'] })
  })

  it('gives an empty set for a chat without a project', async () => {
    const t = await app()
    await t.deps.shellRules.create({ projectId: null, prefix: 'ls' })
    const set = await t.deps.shellRules.forRun(null)
    expect(set).toEqual({ projectId: null, prefixes: [] })
    expect(Object.isFrozen(set)).toBe(true)
    expect(emptyShellRuleSet(A)).toEqual({ projectId: A, prefixes: [] })
  })

  it('a set is read once: a rule added later applies to the next set only', async () => {
    const t = await app()
    await addProjects(t, A)
    const first = await t.deps.shellRules.forRun(A)
    await t.deps.shellRules.create({ projectId: A, prefix: 'pnpm test' })
    expect(first.prefixes).toEqual([])
    expect((await t.deps.shellRules.forRun(A)).prefixes).toEqual(['pnpm test'])
  })

  it('shellRuleSetOf ignores rows of other projects', () => {
    expect(shellRuleSetOf(A, [{ projectId: B, prefix: 'make' }, { projectId: A, prefix: 'b' }, { projectId: null, prefix: 'z' }, { projectId: A, prefix: 'a' }]))
      .toEqual({ projectId: A, prefixes: ['z', 'a', 'b'] })
  })
})

describe('shell rule service: projects, logs and backups', () => {
  it('a project delete removes its rules (foreign key cascade); global and other rules stay', async () => {
    const t = await app({ start: true })
    await addProjects(t, A, B)
    await t.deps.shellRules.create({ projectId: A, prefix: 'pnpm test' })
    await t.deps.shellRules.create({ projectId: A, prefix: 'make' })
    await t.deps.shellRules.create({ projectId: B, prefix: 'cargo test' })
    await t.deps.shellRules.create({ projectId: null, prefix: 'ls' })
    await t.deps.projects.remove(A)
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'ls'], [B, 'cargo test']])
    expect((await t.deps.shellRules.forRun(A)).prefixes).toEqual(['ls'])
    expect(await rejection(t.deps.shellRules.create({ projectId: A, prefix: 'make' }))).toMatchObject({ code: 'not_found' })
  })

  it('logs added / removed at info with the id and the scope; the prefix only at debug', async () => {
    const t = await app()
    await addProjects(t, A)
    const secretish = 'make probe-target-q7'
    const project = await t.deps.shellRules.create({ projectId: A, prefix: secretish })
    const global = await t.deps.shellRules.create({ projectId: null, prefix: 'ls' })
    await t.deps.shellRules.remove(project.id)
    const records = t.logs.records.filter(record => record.msg.startsWith('shell rule'))
    const info = records.filter(record => record.level !== 'debug')
    expect(info.map(record => [record.level, record.msg, record.ruleId, record.scope, record.projectId])).toEqual([
      ['info', 'shell rule added', project.id, 'project', A],
      ['info', 'shell rule added', global.id, 'global', null],
      ['info', 'shell rule removed', project.id, 'project', A],
    ])
    expect(JSON.stringify(info)).not.toContain('probe-target')
    const debug = records.filter(record => record.level === 'debug')
    expect(debug.map(record => [record.msg, record.ruleId, record.prefix])).toEqual([
      ['shell rule prefix', project.id, secretish],
      ['shell rule prefix', global.id, 'ls'],
      ['shell rule prefix', project.id, secretish],
    ])
  })

  it('rules never travel in a backup, and a crafted backup with restoreSettings creates none', async () => {
    const source = await app()
    await addProjects(source, A)
    await source.deps.shellRules.create({ projectId: A, prefix: 'make probe-target-q7' })
    await source.deps.shellRules.create({ projectId: null, prefix: 'pnpm probe-global-q7' })
    const backup = await source.deps.data.exportBackup({ files: false, settings: true })
    const entries = unzipSync(new Uint8Array(await new Response(backup.stream).arrayBuffer()))
    const text = Object.entries(entries).map(([name, bytes]) => `${name}\n${new TextDecoder().decode(bytes)}`).join('\n')
    expect(text).not.toContain('probe-target-q7')
    expect(text).not.toContain('probe-global-q7')
    expect(Object.keys(entries).some(name => /shell|rule/i.test(name))).toBe(false)

    // Rules smuggled into settings.json and an extra entry are ignored by the import.
    const settings = JSON.parse(new TextDecoder().decode(entries['settings.json'])) as Record<string, unknown>
    const crafted = zipSync({
      ...entries,
      'settings.json': strToU8(JSON.stringify({ ...settings, shellRules: [{ projectId: null, prefix: 'rm' }], shell_rules: ['rm'] })),
      'shell-rules.json': strToU8(JSON.stringify({ items: [{ id: 'srl_AAAAAAAAAAAAAAAA', projectId: null, prefix: 'rm', createdAt: 1 }] })),
    })
    const target = await app()
    const result = await target.deps.data.importData(new Blob([crafted]), { restoreSettings: true })
    expect(result.warnings).toEqual(expect.arrayContaining(['The unknown setting "shellRules" was ignored.', 'The unknown setting "shell_rules" was ignored.']))
    expect(await target.deps.shellRules.list()).toEqual([])
    expect((await target.deps.shellRules.forRun(A)).prefixes).toEqual([])
  })

  it('createShellRuleService is the production factory of deps.shellRules', async () => {
    const t = await app()
    const service = createShellRuleService(t.deps)
    await service.create({ projectId: null, prefix: 'ls' })
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'ls']])
  })
})

// ---------- Phase 9: the unique indexes (migration 0006) are the authority ----------

/**
 * The deps of `t` with a database whose first `insert(shell_rules)` stores `planted` right before the real insert: a
 * create that raced past the duplicate check (another process or service instance stored the same rule meanwhile).
 */
let racers = 0

function racingDeps(t: TestApp, planted: { projectId: string | null, prefix: string }): AppDeps {
  let raced = false
  racers += 1
  const id = `srl_RACER${String(racers).padStart(11, '0')}`
  const db = new Proxy(t.db, {
    get(target, property) {
      if (property === 'insert') {
        return (table: unknown) => {
          if (table !== shellRules || raced)
            return target.insert(table as typeof shellRules)
          raced = true
          return {
            values: (values: typeof shellRules.$inferInsert) => ({
              returning: async () => {
                await target.insert(shellRules).values({ id, createdAt: 1, ...planted })
                return target.insert(shellRules).values(values).returning()
              },
            }),
          }
        }
      }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as Db
  return Object.create(t.deps, { db: { value: db } }) as AppDeps
}

async function post(t: TestApp, body: unknown): Promise<{ status: number, body: unknown }> {
  const response = await t.request('/api/shell-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as unknown }
}

describe('shell rule service: the unique indexes (Phase 9, migration 0006)', () => {
  it('the database refuses a second row of the same scope and prefix (global and per project)', async () => {
    const t = await app()
    await addProjects(t, A, B)
    await t.db.insert(shellRules).values({ id: 'srl_UNIQUEGLOBAL0001', projectId: null, prefix: 'ls', createdAt: 1 })
    await t.db.insert(shellRules).values({ id: 'srl_UNIQUEPROJECT01', projectId: A, prefix: 'ls', createdAt: 1 })
    await t.db.insert(shellRules).values({ id: 'srl_UNIQUEPROJECT02', projectId: B, prefix: 'ls', createdAt: 1 })
    for (const [id, projectId] of [['srl_UNIQUEGLOBAL0002', null], ['srl_UNIQUEPROJECT03', A]] as const) {
      const error = await t.db.insert(shellRules).values({ id, projectId, prefix: 'ls', createdAt: 2 }).then(() => null, (caught: unknown) => caught)
      expect(error, String(projectId)).not.toBeNull()
      expect(isUniqueViolation(error), String(projectId)).toBe(true)
    }
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'ls'], [A, 'ls'], [B, 'ls']])
  })

  it('maps a unique violation of the insert to 409 exists (a create that raced past the duplicate check)', async () => {
    const t = await app()
    await addProjects(t, A)
    for (const projectId of [null, A]) {
      const service = createShellRuleService(racingDeps(t, { projectId, prefix: 'pnpm test' }))
      const error = await rejection(service.create({ projectId, prefix: 'pnpm   test' }))
      expect(error).toMatchObject({ code: 'conflict', message: SHELL_RULE_EXISTS_MESSAGE, details: { reason: 'exists' } })
    }
    // The planted rows are the only ones; the failed creates logged nothing.
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'pnpm test'], [A, 'pnpm test']])
    expect(t.logs.records.filter(record => record.msg === 'shell rule added')).toEqual([])
  })

  it('a rule of another scope stored meanwhile is no conflict', async () => {
    const t = await app()
    await addProjects(t, A)
    const service = createShellRuleService(racingDeps(t, { projectId: null, prefix: 'make' }))
    const rule = await service.create({ projectId: A, prefix: 'make' })
    expect(rule).toMatchObject({ projectId: A, prefix: 'make' })
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'make'], [A, 'make']])
  })

  it('a foreign key or primary key violation is not a duplicate', () => {
    const constraint = (code: string) => Object.assign(new Error('failed'), { cause: Object.assign(new Error('SQLITE_CONSTRAINT'), { code: 'SQLITE_CONSTRAINT', cause: { code } }) })
    expect(isUniqueViolation(constraint('SQLITE_CONSTRAINT_UNIQUE'))).toBe(true)
    expect(isUniqueViolation(constraint('SQLITE_CONSTRAINT_FOREIGNKEY'))).toBe(false)
    expect(isUniqueViolation(constraint('SQLITE_CONSTRAINT_PRIMARYKEY'))).toBe(false)
    expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT_UNIQUE'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
  })

  it('two service instances racing on one prefix store it once; the others answer 409 exists', async () => {
    const t = await app()
    await addProjects(t, A)
    const services = [createShellRuleService(t.deps), createShellRuleService(t.deps), createShellRuleService(t.deps)]
    const results = await Promise.allSettled(services.flatMap(service => [0, 1].map(async () => service.create({ projectId: A, prefix: 'cargo test' }))))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of results.filter(result => result.status === 'rejected'))
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(scopes(await t.deps.shellRules.list())).toEqual([[A, 'cargo test']])
  })

  it('pOST /shell-rules: two concurrent identical creates answer one 201 and one 409 exists; global and project both 201', async () => {
    const t = await app()
    await addProjects(t, A)
    const answers = await Promise.all([post(t, { projectId: null, prefix: 'pnpm lint' }), post(t, { projectId: null, prefix: 'pnpm lint' })])
    expect(answers.map(answer => answer.status).sort()).toEqual([201, 409])
    const conflict = answers.find(answer => answer.status === 409)!
    expect(harnessErrorEnvelopeSchema.parse(conflict.body).error).toMatchObject({ code: 'conflict', message: SHELL_RULE_EXISTS_MESSAGE, details: { reason: 'exists' } })
    const created = answers.find(answer => answer.status === 201)!
    expect(shellRuleSchema.parse(created.body)).toMatchObject({ projectId: null, prefix: 'pnpm lint' })

    // The same prefix in a project is another scope.
    const both = await Promise.all([post(t, { projectId: A, prefix: 'make' }), post(t, { projectId: null, prefix: 'make' })])
    expect(both.map(answer => answer.status)).toEqual([201, 201])
    expect(scopes(await t.deps.shellRules.list())).toEqual([[null, 'make'], [null, 'pnpm lint'], [A, 'make']])
  })
})
