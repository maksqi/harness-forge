// Shell rules store (docs/UI.md 7.23, 9.10, 11.5; C20 skeleton, W8.11-T1): the frozen shape (no update action: rules
// are removed and added, never edited), the sorted getters, the load (joined while it runs, replaying the local
// changes made meanwhile), create / remove with their errors, and dropping the rules of a deleted project.
import type { ShellRuleList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatId, projectId, projectSummary, shellRule, shellRuleId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useShellRulesStore } from './shell-rules'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

describe('shell rules store: shape', () => {
  it('starts empty and exposes the frozen members, without an update action', () => {
    const rules = useShellRulesStore()
    expect(rules.items).toEqual([])
    expect(rules.loaded).toBe(false)
    expect(rules.loading).toBe(false)
    expect(rules.global).toEqual([])
    expect(rules.forProject(projectId(1))).toEqual([])
    expect(rules.countForProject(projectId(1))).toBe(0)
    for (const action of ['fetchAll', 'create', 'remove', 'applyEvent'] as const)
      expect(rules[action]).toBeTypeOf('function')
    expect('update' in rules).toBe(false)
  })

  it('splits the rules into the global list and per project, each sorted by prefix', () => {
    const rules = useShellRulesStore()
    const test = shellRule({ id: shellRuleId(1), prefix: 'pnpm test' })
    const lint = shellRule({ id: shellRuleId(2), prefix: 'pnpm lint' })
    const ls = shellRule({ id: shellRuleId(3), projectId: null, prefix: 'ls' })
    const git = shellRule({ id: shellRuleId(4), projectId: null, prefix: 'git status' })
    const other = shellRule({ id: shellRuleId(5), projectId: projectId(2), prefix: 'make' })
    rules.items = [test, ls, lint, other, git]
    expect(rules.global.map(rule => rule.prefix)).toEqual(['git status', 'ls'])
    expect(rules.forProject(projectId(1)).map(rule => rule.prefix)).toEqual(['pnpm lint', 'pnpm test'])
    expect(rules.countForProject(projectId(1))).toBe(2)
    expect(rules.countForProject(projectId(2))).toBe(1)
    expect(rules.countForProject(projectId(3))).toBe(0)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const test = shellRule({ id: shellRuleId(1), prefix: 'pnpm test' })
const ls = shellRule({ id: shellRuleId(2), projectId: null, prefix: 'ls' })
const make = shellRule({ id: shellRuleId(3), projectId: projectId(2), prefix: 'make' })

describe('shell rules store: fetchAll', () => {
  it('loads every rule and marks the list loaded', async () => {
    api.shellRules.list.mockResolvedValue({ items: [ls, test, make] })
    const rules = useShellRulesStore()
    const load = rules.fetchAll()
    expect(rules.loading).toBe(true)
    await load
    expect(api.shellRules.list).toHaveBeenCalledWith()
    expect(rules.loaded).toBe(true)
    expect(rules.loading).toBe(false)
    expect(rules.global).toEqual([ls])
    expect(rules.forProject(projectId(1))).toEqual([test])
    expect(rules.countForProject(projectId(2))).toBe(1)
  })

  it('joins a load that is already running', async () => {
    const answer = deferred<ShellRuleList>()
    api.shellRules.list.mockReturnValue(answer.promise)
    const rules = useShellRulesStore()
    const first = rules.fetchAll()
    const second = rules.fetchAll()
    answer.resolve({ items: [test] })
    await Promise.all([first, second])
    expect(api.shellRules.list).toHaveBeenCalledTimes(1)
    expect(rules.items).toEqual([test])
    // A later call loads again.
    api.shellRules.list.mockResolvedValue({ items: [] })
    await rules.fetchAll()
    expect(api.shellRules.list).toHaveBeenCalledTimes(2)
    expect(rules.items).toEqual([])
  })

  it('throws a HarnessError and keeps the rules shown before when the load fails', async () => {
    api.shellRules.list.mockResolvedValueOnce({ items: [test] })
    const rules = useShellRulesStore()
    await rules.fetchAll()
    api.shellRules.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await expect(rules.fetchAll()).rejects.toMatchObject({ code: 'internal_error', message: 'The database is locked.' })
    expect(rules.items).toEqual([test])
    expect(rules.loaded).toBe(true)
    expect(rules.loading).toBe(false)
  })

  it('stays not loaded when the first load fails, so the editors can offer Retry', async () => {
    api.shellRules.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Down.' }))
    const rules = useShellRulesStore()
    await expect(rules.fetchAll()).rejects.toBeInstanceOf(HarnessError)
    expect(rules.loaded).toBe(false)
    expect(rules.loading).toBe(false)
  })

  it('replays the creates and removes made while the list was loading', async () => {
    const rules = useShellRulesStore()
    rules.items = [test, ls]
    const answer = deferred<ShellRuleList>()
    api.shellRules.list.mockReturnValue(answer.promise)
    const load = rules.fetchAll()

    const added = shellRule({ id: shellRuleId(4), prefix: 'pnpm lint' })
    api.shellRules.create.mockResolvedValueOnce(added)
    await rules.create({ projectId: projectId(1), prefix: 'pnpm lint' })
    api.shellRules.remove.mockResolvedValueOnce(undefined)
    await rules.remove(ls.id)
    rules.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: null }))

    // The answer was built before those changes.
    answer.resolve({ items: [ls, test, make] })
    await load
    expect(rules.items.map(rule => rule.id).sort()).toEqual([test.id, added.id].sort())
  })
})

describe('shell rules store: create', () => {
  it('posts the rule and adds the stored one to the list', async () => {
    const rules = useShellRulesStore()
    rules.items = [ls]
    rules.loaded = true
    const stored = shellRule({ id: shellRuleId(5), prefix: 'pnpm test' })
    api.shellRules.create.mockResolvedValueOnce(stored)
    await expect(rules.create({ projectId: projectId(1), prefix: 'pnpm  test' })).resolves.toEqual(stored)
    expect(api.shellRules.create).toHaveBeenCalledWith({ body: { projectId: projectId(1), prefix: 'pnpm  test' } })
    expect(rules.forProject(projectId(1))).toEqual([stored])
    expect(rules.countForProject(projectId(1))).toBe(1)
    expect(api.shellRules.list).not.toHaveBeenCalled()
  })

  it('creates a global rule with projectId null', async () => {
    const rules = useShellRulesStore()
    rules.loaded = true
    api.shellRules.create.mockResolvedValueOnce(ls)
    await rules.create({ projectId: null, prefix: 'ls' })
    expect(api.shellRules.create).toHaveBeenCalledWith({ body: { projectId: null, prefix: 'ls' } })
    expect(rules.global).toEqual([ls])
  })

  it('throws 409 exists and 400 as HarnessError and leaves the list alone', async () => {
    const rules = useShellRulesStore()
    rules.items = [test]
    rules.loaded = true
    api.shellRules.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'This rule already exists.', details: { reason: 'exists' } }))
    await expect(rules.create({ projectId: projectId(1), prefix: 'pnpm test' }))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    api.shellRules.create.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'bash runs other commands.' }))
    await expect(rules.create({ projectId: null, prefix: 'bash' })).rejects.toMatchObject({ code: 'validation_error' })
    expect(rules.items).toEqual([test])
  })

  it('starts the first load in the background after a rule was saved from an approval card', async () => {
    const rules = useShellRulesStore()
    api.shellRules.create.mockResolvedValueOnce(test)
    api.shellRules.list.mockResolvedValueOnce({ items: [ls, test] })
    await rules.create({ projectId: projectId(1), prefix: 'pnpm test' })
    expect(api.shellRules.list).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(rules.loaded).toBe(true)
    expect(rules.items).toEqual([ls, test])
  })

  it('also loads after a 409 before the first load, and a failed background load stays quiet', async () => {
    const rules = useShellRulesStore()
    api.shellRules.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'This rule already exists.', details: { reason: 'exists' } }))
    api.shellRules.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Down.' }))
    await expect(rules.create({ projectId: projectId(1), prefix: 'pnpm test' })).rejects.toMatchObject({ code: 'conflict' })
    await flushPromises()
    expect(api.shellRules.list).toHaveBeenCalledTimes(1)
    expect(rules.loaded).toBe(false)
  })
})

describe('shell rules store: remove', () => {
  it('deletes the rule and drops it once the server answered', async () => {
    const rules = useShellRulesStore()
    rules.items = [test, ls]
    const answer = deferred<undefined>()
    api.shellRules.remove.mockReturnValueOnce(answer.promise)
    const removal = rules.remove(test.id)
    expect(rules.items).toEqual([test, ls])
    answer.resolve(undefined)
    await removal
    expect(api.shellRules.remove).toHaveBeenCalledWith({ params: { id: test.id } })
    expect(rules.items).toEqual([ls])
  })

  it('counts a 404 as removed', async () => {
    const rules = useShellRulesStore()
    rules.items = [test, ls]
    api.shellRules.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: `Shell rule ${test.id} not found.` }))
    await rules.remove(test.id)
    expect(rules.items).toEqual([ls])
  })

  it('keeps the rule and throws other failures', async () => {
    const rules = useShellRulesStore()
    rules.items = [test]
    api.shellRules.remove.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await expect(rules.remove(test.id)).rejects.toMatchObject({ code: 'internal_error' })
    expect(rules.items).toEqual([test])
  })
})

describe('shell rules store: applyEvent', () => {
  it('drops the rules of a deleted project and keeps the others', () => {
    const rules = useShellRulesStore()
    rules.items = [test, ls, make]
    rules.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }))
    expect(rules.items).toEqual([ls, make])
    expect(rules.countForProject(projectId(1))).toBe(0)
  })

  it('ignores a changed project and other events, and sends nothing', () => {
    const rules = useShellRulesStore()
    rules.items = [test, ls]
    const before = rules.items
    rules.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: projectSummary({ id: projectId(1) }) }))
    rules.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    expect(rules.items).toBe(before)
    expect(api.shellRules.list).not.toHaveBeenCalled()
  })
})
