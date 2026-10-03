// Shell rules store (docs/UI.md 7.23, 11.5; C20 skeleton): the frozen shape (no update action: rules are removed and
// added, never edited), the sorted getters, the create / remove calls and the stub fetch, which sends nothing until
// W8.11.
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectId, shellRule, shellRuleId } from '~/utils/testing/fixtures'
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

describe('shell rules store: stub actions (C20)', () => {
  it('fetchAll and applyEvent send nothing until W8.11', async () => {
    const rules = useShellRulesStore()
    await expect(rules.fetchAll()).resolves.toBeUndefined()
    rules.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }))
    expect(api.shellRules.list).not.toHaveBeenCalled()
  })

  it('creates and removes through the shell-rules routes', async () => {
    const rules = useShellRulesStore()
    api.shellRules.create.mockResolvedValue(shellRule())
    api.shellRules.remove.mockResolvedValue(undefined)
    await expect(rules.create({ projectId: projectId(1), prefix: 'pnpm test' })).resolves.toEqual(shellRule())
    expect(api.shellRules.create).toHaveBeenCalledWith({ body: { projectId: projectId(1), prefix: 'pnpm test' } })
    await rules.remove(shellRuleId(1))
    expect(api.shellRules.remove).toHaveBeenCalledWith({ params: { id: shellRuleId(1) } })
  })
})
