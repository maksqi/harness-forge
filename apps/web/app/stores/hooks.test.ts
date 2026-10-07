// Hooks store (docs/UI.md 9.13, 11.8, 11.9; W11.8-T1, W12.12-T5): per-scope caches with single flight and `maxAgeMs`, an
// answer that an event or a mutation overtook is never cached, events mark the affected scopes stale and refetch the
// recent ones, `{ enabled: false }` is optimistic with a rollback, and the fresh-auth 403 is thrown for the component.
// Phase 12: `saveProjectHook` reads a settings file, splices the handler into its `hooks` key and writes it with the
// sha256 it read (a changed file is a 409 `stale`, before or by the server); `workspace.changed` for a settings file marks
// the project stale.
import type { HookList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError, LIMITS } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeHookEntry, hookEntry, hookId, hookList, personalHook, projectDefinitionFile, projectDefinitionWriteResult, projectId, projectSummary, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { HOOKS_RECENT_MS, hookScopeKey, PROJECT_HOOK_STALE_MESSAGE, useHooksStore } from './hooks'

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
  vi.useRealTimers()
  disposePinia(pinia)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const globalList = hookList({ items: [hookEntry(), codeHookEntry()], project: undefined })

describe('hooks store', () => {
  it('starts empty', () => {
    const store = useHooksStore()
    expect(store.lists).toEqual({})
    expect(store.list(null)).toBeNull()
    expect(store.list(projectId(1))).toBeNull()
    expect(store.personal).toEqual([])
    expect(hookScopeKey(null)).toBe('')
    expect(hookScopeKey(projectId(1))).toBe(projectId(1))
  })

  it('fetches a scope, keeps the personal entries of the global one and reuses a young list', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValueOnce(globalList)
    await store.fetch(null)
    expect(api.hooks.list).toHaveBeenCalledWith({ query: {} })
    expect(store.list(null)).toEqual(globalList)
    expect(store.personal).toEqual([hookEntry()])
    await expect(store.fetch(null, { maxAgeMs: 60_000 })).resolves.toEqual(globalList)
    expect(api.hooks.list).toHaveBeenCalledTimes(1)
    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    expect(api.hooks.list).toHaveBeenLastCalledWith({ query: { projectId: projectId(1) } })
    expect(store.list(projectId(1))?.project?.pending).toBe(1)
  })

  it('refetches a list older than maxAgeMs', async () => {
    vi.useFakeTimers()
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(globalList)
    await store.fetch(null)
    vi.advanceTimersByTime(20_000)
    await store.fetch(null, { maxAgeMs: 15_000 })
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
  })

  it('runs one request per scope at a time', async () => {
    const store = useHooksStore()
    const answer = deferred<HookList>()
    api.hooks.list.mockReturnValueOnce(answer.promise)
    const first = store.fetch(null)
    const second = store.fetch(null)
    expect(api.hooks.list).toHaveBeenCalledTimes(1)
    answer.resolve(globalList)
    await expect(first).resolves.toEqual(globalList)
    await expect(second).resolves.toEqual(globalList)
  })

  it('never caches an answer that an event overtook, and refetches the scope used recently', async () => {
    const store = useHooksStore()
    const old = deferred<HookList>()
    api.hooks.list.mockReturnValueOnce(old.promise)
    const request = store.fetch(null)
    const fresh = hookList({ items: [hookEntry({ command: 'sh new.sh' })], project: undefined })
    api.hooks.list.mockResolvedValueOnce(fresh)
    store.applyEvent(createServerEvent('hooks.changed', { projectId: null }, 1))
    old.resolve(globalList)
    await expect(request).resolves.toEqual(globalList)
    await vi.waitFor(() => expect(store.list(null)).toEqual(fresh))
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
  })

  it('marks only the affected scopes stale and refetches only the recently used ones', async () => {
    vi.useFakeTimers()
    const store = useHooksStore()
    api.hooks.list.mockImplementation(async ({ query }: { query: { projectId?: string } }) => (query.projectId ? hookList({ project: { ...hookList().project!, id: query.projectId } }) : globalList))
    await store.fetch(null)
    await store.fetch(projectId(1))
    await store.fetch(projectId(2))
    api.hooks.list.mockClear()

    store.applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 0 }, 1))
    expect(store.stale).toEqual({ [projectId(1)]: true })
    await vi.waitFor(() => expect(api.hooks.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } }))
    expect(api.hooks.list).toHaveBeenCalledTimes(1)

    // A scope not used for a minute is only marked stale.
    vi.advanceTimersByTime(HOOKS_RECENT_MS + 1)
    api.hooks.list.mockClear()
    store.applyEvent(createServerEvent('plugin.changed', { id: 'hook-pack', plugin: null }, 2))
    expect(Object.keys(store.stale).sort()).toEqual(['', projectId(1), projectId(2)].sort())
    expect(api.hooks.list).not.toHaveBeenCalled()
    await store.fetch(null)
    expect(store.stale['']).toBeUndefined()

    store.applyEvent(createServerEvent('customization.changed', { projectId: projectId(2) }, 3))
    expect(store.stale[projectId(2)]).toBe(true)
    store.applyEvent(createServerEvent('customization.changed', {}, 4))
    expect(store.stale['']).toBeUndefined()
  })

  it('drops a deleted project\'s scope on a 404 and on project.changed', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    api.hooks.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await expect(store.fetch(projectId(1))).rejects.toMatchObject({ code: 'not_found' })
    expect(store.list(projectId(1))).toBeNull()

    api.hooks.list.mockResolvedValueOnce(hookList())
    await store.fetch(projectId(1))
    store.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }, 1))
    expect(store.list(projectId(1))).toBeNull()
    expect(projectSummary().id).toBe(projectId(1))
  })

  it('throws the fresh-auth 403 of create and marks every scope stale after a mutation', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again.', action: 'login' }))
    await expect(store.create({ event: 'Stop', command: 'sh check.sh' })).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(store.stale).toEqual({})
    api.hooks.create.mockResolvedValueOnce(personalHook({ id: hookId(2) }))
    await store.create({ event: 'Stop', command: 'sh check.sh' })
    expect(store.stale).toEqual({ '': true, [projectId(1)]: true })
    api.hooks.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Gone' }))
    await expect(store.remove(hookId(1))).resolves.toBeUndefined()
    api.hooks.remove.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await expect(store.remove(hookId(1))).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('turns a hook off at once in every scope and rolls back a failure', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    const answer = deferred<unknown>()
    api.hooks.update.mockReturnValueOnce(answer.promise)
    const request = store.update(hookId(1), { enabled: false })
    expect(store.list(null)?.items[0]?.state).toBe('off')
    expect(store.list(projectId(1))?.items[0]?.state).toBe('off')
    expect(store.personal[0]?.state).toBe('off')
    answer.reject(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await expect(request).rejects.toMatchObject({ code: 'internal_error' })
    expect(store.list(null)?.items[0]?.state).toBe('active')

    // A success keeps the off state until the refetch answers.
    api.hooks.update.mockResolvedValueOnce(personalHook({ enabled: false }))
    await store.update(hookId(1), { enabled: false })
    expect(store.list(projectId(1))?.items[0]?.state).toBe('off')
    expect(api.hooks.update).toHaveBeenLastCalledWith({ params: { id: hookId(1) }, body: { enabled: false } })
  })

  it('does not change the shown state of a fresh-auth update before the server answers', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList({ items: [hookEntry({ state: 'off' })] }))
    await store.fetch(null)
    api.hooks.update.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again.', action: 'login' }))
    const request = store.update(hookId(1), { enabled: true })
    expect(store.list(null)?.items[0]?.state).toBe('off')
    await expect(request).rejects.toMatchObject({ action: 'login' })
  })

  it('refetches the loaded scopes after a reconnect and reads the run log', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(hookList())
    await store.fetch(null)
    await store.fetch(projectId(1))
    api.hooks.list.mockClear()
    await store.refreshLoaded()
    expect(api.hooks.list).toHaveBeenCalledTimes(2)
    api.hooks.runs.mockResolvedValueOnce({ items: [] })
    await expect(store.runs()).resolves.toEqual({ items: [] })
  })
})

describe('hooks store: project hooks (Phase 12, W12.12-T5)', () => {
  const settingsPath = '.claude/settings.json'
  const fileText = (hooks: unknown, extra: Record<string, unknown> = { permissions: { allow: ['Bash(ls:*)'] } }) => JSON.stringify({ ...extra, hooks }, null, 2)
  const FILE_HOOKS = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh .claude/hooks/guard.sh' }] }] }
  const target = (overrides: Partial<{ groupIndex: number | null, handlerIndex: number | null, event: 'PreToolUse' | 'Stop' }> = {}) => ({
    projectId: projectId(1),
    path: settingsPath,
    event: 'PreToolUse' as const,
    groupIndex: null,
    handlerIndex: null,
    ...overrides,
  })
  /** The listing of project 1 with the guard hook at [0, 0] of `.claude/settings.json`. */
  const listed = hookList({ items: [hookEntry({ key: `project:${trustSha(1)}`, source: 'project', id: undefined, event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/guard.sh', state: 'pending', path: settingsPath, sha256: trustSha(1), position: [0, 0] })] })

  it('adds a new handler to the file\'s hooks key with the sha256 it read, and never asks for a password', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(listed)
    await store.fetch(projectId(1))
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: fileText(FILE_HOOKS), sha256: trustSha(4) }))
    api.projectDefinitions.write.mockResolvedValueOnce(projectDefinitionWriteResult({ trust: { pending: 2 } }))
    const result = await store.saveProjectHook(projectId(1), target(), { event: 'Stop', matcher: '', command: '', timeout: null, enabled: true, type: 'prompt', prompt: 'Did the tests pass?' })
    expect(result.trust.pending).toBe(2)
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: settingsPath } })
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: settingsPath, expectedSha256: trustSha(4), hooks: { ...FILE_HOOKS, Stop: [{ hooks: [{ type: 'prompt', prompt: 'Did the tests pass?' }] }] } },
    })
    expect(store.stale[projectId(1)]).toBe(true)
    expect(api.auth.login).not.toHaveBeenCalled()
  })

  it('creates the key of a missing file (expectedSha256 null)', async () => {
    const store = useHooksStore()
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: '.harness/settings.local.json', kind: 'settings', exists: false, content: null, sha256: null }))
    api.projectDefinitions.write.mockResolvedValueOnce(projectDefinitionWriteResult({ path: '.harness/settings.local.json', created: true }))
    await store.saveProjectHook(projectId(1), { ...target(), path: '.harness/settings.local.json' }, { event: 'PreToolUse', matcher: 'Write', command: 'sh fmt.sh', timeout: 10, enabled: true })
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.harness/settings.local.json', expectedSha256: null, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'sh fmt.sh', timeout: 10 }] }] } },
    })
  })

  it('replaces the listed handler in place and removes it with a null draft', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(listed)
    await store.fetch(projectId(1))
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: fileText(FILE_HOOKS), sha256: trustSha(4) }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult())
    await store.saveProjectHook(projectId(1), target({ groupIndex: 0, handlerIndex: 0 }), { event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/guard.sh --strict', timeout: null, enabled: true, if: 'Bash(git *)' })
    expect(api.projectDefinitions.write).toHaveBeenLastCalledWith({
      params: { id: projectId(1) },
      body: { path: settingsPath, expectedSha256: trustSha(4), hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh .claude/hooks/guard.sh --strict', if: 'Bash(git *)' }] }] } },
    })
    await store.fetch(projectId(1))
    await store.saveProjectHook(projectId(1), target({ groupIndex: 0, handlerIndex: 0 }), null)
    expect(api.projectDefinitions.write).toHaveBeenLastCalledWith({ params: { id: projectId(1) }, body: { path: settingsPath, expectedSha256: trustSha(4), hooks: null } })
  })

  it('refuses with 409 stale when the file no longer holds the listed handler, before writing', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(listed)
    await store.fetch(projectId(1))
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: fileText({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh other.sh' }] }] }), sha256: trustSha(5) }))
    await expect(store.saveProjectHook(projectId(1), target({ groupIndex: 0, handlerIndex: 0 }), null))
      .rejects
      .toMatchObject({ code: 'conflict', message: PROJECT_HOOK_STALE_MESSAGE, details: { reason: 'stale' } })
    // A handler that is gone (no listing to compare with) is stale too.
    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    const fresh = useHooksStore()
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: fileText({}), sha256: trustSha(5) }))
    await expect(fresh.saveProjectHook(projectId(1), target({ groupIndex: 0, handlerIndex: 0 }), null)).rejects.toMatchObject({ details: { reason: 'stale' } })
    expect(api.projectDefinitions.write).not.toHaveBeenCalled()
  })

  it('passes the server\'s stale answer through and refuses a file it can\'t read', async () => {
    const store = useHooksStore()
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: fileText(FILE_HOOKS), sha256: trustSha(4) }))
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: PROJECT_HOOK_STALE_MESSAGE, details: { reason: 'stale' } }))
    await expect(store.saveProjectHook(projectId(1), target(), { event: 'Stop', matcher: '', command: 'pnpm lint', timeout: null, enabled: true }))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: '{ "hooks": ', sha256: trustSha(4) }))
    await expect(store.saveProjectHook(projectId(1), target(), { event: 'Stop', matcher: '', command: 'pnpm lint', timeout: null, enabled: true }))
      .rejects
      .toMatchObject({ code: 'validation_error', message: `${settingsPath} can't be changed here: it isn't valid JSON. Fix it in the project folder.` })
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: settingsPath, kind: 'settings', content: fileText([1]), sha256: trustSha(4) }))
    await expect(store.saveProjectHook(projectId(1), target(), { event: 'Stop', matcher: '', command: 'pnpm lint', timeout: null, enabled: true }))
      .rejects
      .toMatchObject({ code: 'validation_error' })
    expect(api.projectDefinitions.write).toHaveBeenCalledTimes(1)
  })

  it('marks a project stale on workspace.changed for its settings files only', async () => {
    const store = useHooksStore()
    api.hooks.list.mockResolvedValue(listed)
    await store.fetch(projectId(1))
    const changed = (paths: string[]) => createServerEvent('workspace.changed', { projectId: projectId(1), chatId: null, batchId: null, source: 'user', paths }, 1)
    store.applyEvent(changed(['src/app.ts', '.claude/agents/reviewer.md']))
    expect(store.stale).toEqual({})
    store.applyEvent(changed(['.harness/settings.local.json']))
    expect(store.stale).toEqual({ [projectId(1)]: true })
    await store.fetch(projectId(1))
    // A path list cut at the event's cap may hold a settings file.
    store.applyEvent(changed(Array.from({ length: LIMITS.workspaceEventPathsMax }, (_, index) => `src/${index}.ts`)))
    expect(store.stale[projectId(1)]).toBe(true)
  })
})
